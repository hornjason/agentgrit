/**
 * #331 — rows capture wrote from machine text leave the live logs but are never deleted.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { splitRows } from "../../scripts/quarantine-signals";

const TMP = join(import.meta.dir, ".tmp-quarantine-signals");
const SCRIPT = join(import.meta.dir, "../../scripts/quarantine-signals.ts");
const CUTOFF = "2026-11-27T21:00:00Z";

const rating = (source: string, value: number, timestamp: string) =>
  JSON.stringify({ id: `${source}-${timestamp}`, type: "rating", timestamp, session_id: "s", source, rating: value });

const RATING_LINES = [
  rating("thumbs", 9, "2026-10-19T10:00:00.000Z"), // moves
  rating("explicit", 7, "2026-11-01T10:00:00.000Z"), // other source — stays
  "{not json", // unparseable — stays byte for byte
  rating("thumbs", 2, "2026-11-26T09:01:00.000Z"), // moves
  rating("thumbs", 9, "2026-11-28T10:00:00.000Z"), // after the fix — stays
];
const RATINGS = `${RATING_LINES.join("\n")}\n`;

const sentiment = (preview: string | undefined) =>
  JSON.stringify({ id: preview ?? "none", type: "sentiment", score: 0.5, ...(preview === undefined ? {} : { message_preview: preview }) });

const SENTIMENT_LINES = [
  sentiment("<task-notification>\n<task-id>b1</task-id>"), // moves
  sentiment("thanks, that works"), // human — stays
  sentiment('<cross-session-message from="uds:/tmp/x.sock">'), // moves
  sentiment('<pasted_content id="p1">\nlog\n'), // pasted by the human — stays
  sentiment(undefined), // no text to judge — stays, UNMEASURED
  sentiment("/loop Keep the board moving"), // moves
];
const SENTIMENT = `${SENTIMENT_LINES.join("\n")}\n`;

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  writeFileSync(join(TMP, "ratings.jsonl"), RATINGS);
  writeFileSync(join(TMP, "sentiment.jsonl"), SENTIMENT);
});
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

function run(...args: string[]) {
  return Bun.spawnSync(["bun", SCRIPT, "--reason", "#331 machine text", "--dir", TMP, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
}

const lines = (f: string) => readFileSync(join(TMP, f), "utf-8").trim().split("\n");

describe("splitRows --source/--before (ratings store no prompt text)", () => {
  test("moves only the selected source before the cutoff; keeps every other line as-is", () => {
    const { keep, quarantined } = splitRows(RATINGS, { source: "thumbs", before: CUTOFF });
    expect(quarantined.map((r) => r.timestamp)).toEqual(["2026-10-19T10:00:00.000Z", "2026-11-26T09:01:00.000Z"]);
    expect(keep).toEqual([RATING_LINES[1], RATING_LINES[2], RATING_LINES[4]]);
  });

  test("an unparseable cutoff is refused, not read as 'move nothing'", () => {
    expect(() => splitRows(RATINGS, { source: "thumbs", before: "yesterday" })).toThrow();
  });
});

describe("splitRows --machine-text (the capture gate's own predicate)", () => {
  test("moves rows whose stored text fails isHumanPrompt; counts rows with no text as unmeasured", () => {
    const { keep, quarantined, unmeasured } = splitRows(SENTIMENT, { textField: "message_preview" });
    expect(quarantined.map((r) => r.id)).toEqual([
      "<task-notification>\n<task-id>b1</task-id>",
      '<cross-session-message from="uds:/tmp/x.sock">',
      "/loop Keep the board moving",
    ]);
    expect(keep).toEqual([SENTIMENT_LINES[1], SENTIMENT_LINES[3], SENTIMENT_LINES[4]]);
    expect(unmeasured).toBe(1);
  });
});

describe("quarantine-signals script", () => {
  test("dry run writes nothing", () => {
    expect(run("--file", "sentiment.jsonl", "--machine-text", "message_preview").exitCode).toBe(0);
    expect(readFileSync(join(TMP, "sentiment.jsonl"), "utf-8")).toBe(SENTIMENT);
    expect(existsSync(join(TMP, "sentiment.quarantined.jsonl"))).toBe(false);
  });

  test("--write moves and tags the rows, backs up the original, and is idempotent", () => {
    expect(run("--file", "ratings.jsonl", "--source", "thumbs", "--before", CUTOFF, "--write").exitCode).toBe(0);

    expect(readFileSync(join(TMP, "ratings.jsonl"), "utf-8")).toBe(
      `${[RATING_LINES[1], RATING_LINES[2], RATING_LINES[4]].join("\n")}\n`,
    );
    const moved = lines("ratings.quarantined.jsonl").map((l) => JSON.parse(l));
    expect(moved.map((r) => r.rating)).toEqual([9, 2]);
    expect(moved.every((r) => r.quarantine?.reason === "#331 machine text" && typeof r.quarantine?.at === "string")).toBe(true);

    const backups = readdirSync(TMP).filter((f) => f.startsWith("ratings.jsonl.pre-quarantine-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(TMP, backups[0]), "utf-8")).toBe(RATINGS);

    expect(run("--file", "ratings.jsonl", "--source", "thumbs", "--before", CUTOFF, "--write").exitCode).toBe(0);
    expect(lines("ratings.quarantined.jsonl")).toHaveLength(2);
  });

  test("--write with --machine-text writes <name>.quarantined.jsonl next to the log", () => {
    expect(run("--file", "sentiment.jsonl", "--machine-text", "message_preview", "--write").exitCode).toBe(0);
    expect(lines("sentiment.jsonl")).toHaveLength(3);
    expect(lines("sentiment.quarantined.jsonl")).toHaveLength(3);
  });

  test("missing selector is a usage error, not a silent no-op", () => {
    expect(run("--file", "sentiment.jsonl").exitCode).toBe(1);
  });
});
