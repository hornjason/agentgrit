/**
 * #331 — the bad thumbs rows leave ratings.jsonl but are never deleted.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { splitRatings } from "../../scripts/quarantine-ratings";

const TMP = join(import.meta.dir, ".tmp-quarantine-ratings");
const SCRIPT = join(import.meta.dir, "../../scripts/quarantine-ratings.ts");
const CUTOFF = "2026-11-27T21:00:00Z";

const row = (source: string, rating: number, timestamp: string) =>
  JSON.stringify({ id: `${source}-${timestamp}`, type: "rating", timestamp, session_id: "s", source, rating });

const LINES = [
  row("thumbs", 9, "2026-10-19T10:00:00.000Z"), // moves
  row("explicit", 7, "2026-11-01T10:00:00.000Z"), // other source — stays
  "{not json", // unparseable — stays byte for byte
  row("thumbs", 2, "2026-11-26T09:01:00.000Z"), // moves
  row("thumbs", 9, "2026-11-28T10:00:00.000Z"), // after the fix — stays
];
const RAW = `${LINES.join("\n")}\n`;

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  writeFileSync(join(TMP, "ratings.jsonl"), RAW);
});
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

function run(...extra: string[]) {
  return Bun.spawnSync(
    ["bun", SCRIPT, "--source", "thumbs", "--before", CUTOFF, "--reason", "#331 machine text", "--dir", TMP, ...extra],
    { stdout: "pipe", stderr: "pipe" },
  );
}

describe("splitRatings", () => {
  test("moves only the selected source before the cutoff; keeps every other line as-is", () => {
    const { keep, quarantined } = splitRatings(RAW, { source: "thumbs", before: CUTOFF });
    expect(quarantined.map((r) => r.timestamp)).toEqual(["2026-10-19T10:00:00.000Z", "2026-11-26T09:01:00.000Z"]);
    expect(keep).toEqual([LINES[1], LINES[2], LINES[4]]);
  });

  test("an unparseable cutoff is refused, not read as 'move nothing'", () => {
    expect(() => splitRatings(RAW, { source: "thumbs", before: "yesterday" })).toThrow();
  });
});

describe("quarantine-ratings script", () => {
  test("dry run writes nothing", () => {
    expect(run().exitCode).toBe(0);
    expect(readFileSync(join(TMP, "ratings.jsonl"), "utf-8")).toBe(RAW);
    expect(existsSync(join(TMP, "ratings.quarantined.jsonl"))).toBe(false);
  });

  test("--write moves the rows, tags them, backs up the original, and is idempotent", () => {
    expect(run("--write").exitCode).toBe(0);

    expect(readFileSync(join(TMP, "ratings.jsonl"), "utf-8")).toBe(`${[LINES[1], LINES[2], LINES[4]].join("\n")}\n`);
    const moved = readFileSync(join(TMP, "ratings.quarantined.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(moved.map((r) => r.rating)).toEqual([9, 2]);
    expect(moved.every((r) => r.quarantine?.reason === "#331 machine text" && typeof r.quarantine?.at === "string")).toBe(true);

    const backups = readdirSync(TMP).filter((f) => f.startsWith("ratings.jsonl.pre-quarantine-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(TMP, backups[0]), "utf-8")).toBe(RAW);

    expect(run("--write").exitCode).toBe(0);
    expect(readFileSync(join(TMP, "ratings.quarantined.jsonl"), "utf-8").trim().split("\n")).toHaveLength(2);
  });
});
