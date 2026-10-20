/**
 * Regression test for the transcript rating miner (issue #260).
 *
 * The outage this command exists to repair destroyed ~18 days of ratings, and
 * the only surviving copy is the host transcript log. Three properties decide
 * whether a run repairs the record or corrupts it, so each one is asserted
 * against a fixture transcript rather than against the live log:
 *
 *  1. The mined timestamp is the transcript entry's, not today's. A miner that
 *     stamps `new Date()` writes 200 ratings dated the day it ran and destroys
 *     the timeline it was built to restore.
 *  2. Only real typed user prompts are mined — not assistant turns, not
 *     tool_result envelopes, not subagent sidechains.
 *  3. Re-running is a no-op. The dedupe key is the transcript entry uuid,
 *     carried onto the written record as `source_uuid`.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { mineTranscriptRatings } from "../../bin/commands/backfill-ratings";

const TMP_DIR = join(import.meta.dir, ".tmp-backfill-ratings-test");
const TRANSCRIPTS = join(TMP_DIR, "projects");
const RATINGS = join(TMP_DIR, "signals", "ratings.jsonl");

interface FixtureEntry {
  type: string;
  uuid: string;
  timestamp: string;
  sessionId?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  toolUseResult?: unknown;
  message: { role: string; content: unknown };
}

function entry(partial: Partial<FixtureEntry> & { uuid: string; timestamp: string; content: unknown }): FixtureEntry {
  const { content, ...rest } = partial;
  return {
    type: "user",
    sessionId: "sess-fixture",
    isSidechain: false,
    ...rest,
    message: { role: (rest.type ?? "user") === "assistant" ? "assistant" : "user", content },
  } as FixtureEntry;
}

/** Every record in the fixture, in file order. */
const FIXTURE: FixtureEntry[] = [
  // ── in range, should be mined ──
  entry({ uuid: "u-explicit", timestamp: "2026-10-05T10:00:00.000Z", content: "/rate M:7 S:8 Q:9 solid work" }),
  entry({ uuid: "u-bare", timestamp: "2026-10-06T10:00:00.000Z", content: "8" }),
  entry({ uuid: "u-praise", timestamp: "2026-10-07T10:00:00.000Z", content: "perfect" }),
  entry({ uuid: "u-thumbs", timestamp: "2026-10-08T10:00:00.000Z", content: "👍" }),
  // explicit rating delivered as a text content block rather than a bare string
  entry({
    uuid: "u-blocks",
    timestamp: "2026-10-09T10:00:00.000Z",
    content: [{ type: "text", text: "/rate M:5 S:5 Q:5" }],
  }),

  // two distinct ratings with the SAME timestamp and the SAME text. They are
  // two real ratings and both must survive, which is what separates a uuid
  // dedupe key from the cheaper timestamp-or-content key.
  entry({ uuid: "u-twin-a", timestamp: "2026-10-12T09:00:00.000Z", content: "8" }),
  entry({ uuid: "u-twin-b", timestamp: "2026-10-12T09:00:00.000Z", content: "8" }),

  // ── in range, must NOT be mined ──
  entry({ uuid: "a-assistant", timestamp: "2026-10-05T11:00:00.000Z", type: "assistant", content: "/rate M:1 S:1 Q:1" }),
  entry({
    uuid: "u-toolresult",
    timestamp: "2026-10-05T12:00:00.000Z",
    toolUseResult: { stdout: "9" },
    content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "9 files changed" }],
  }),
  entry({ uuid: "u-sidechain", timestamp: "2026-10-05T13:00:00.000Z", isSidechain: true, content: "/rate M:2 S:2 Q:2" }),
  entry({ uuid: "u-meta", timestamp: "2026-10-05T14:00:00.000Z", isMeta: true, content: "perfect" }),
  entry({ uuid: "u-plain", timestamp: "2026-10-05T15:00:00.000Z", content: "please read the file and tell me what it does" }),
  entry({ uuid: "u-count", timestamp: "2026-10-05T16:00:00.000Z", content: "9 files are still failing" }),
  // a long working prompt that merely contains "+1". Measured over the real
  // transcripts, 4148 of 4148 thumbs matches in the outage window were this
  // shape and none was a real thumbs rating.
  entry({
    uuid: "u-longplus1",
    timestamp: "2026-10-05T17:00:00.000Z",
    content: "please bump the retry counter by +1 in the loop and rerun the suite so we can see the failure",
  }),

  // ── outside the requested range ──
  entry({ uuid: "u-before", timestamp: "2026-09-20T10:00:00.000Z", content: "/rate M:3 S:3 Q:3" }),
  entry({ uuid: "u-after", timestamp: "2026-11-02T10:00:00.000Z", content: "/rate M:4 S:4 Q:4" }),
];

const MINEABLE = ["u-explicit", "u-bare", "u-praise", "u-thumbs", "u-blocks", "u-twin-a", "u-twin-b"];

function writeFixture(): void {
  const nested = join(TRANSCRIPTS, "-Users-someone-project");
  mkdirSync(nested, { recursive: true });
  writeFileSync(
    join(nested, "session-a.jsonl"),
    FIXTURE.map((e) => JSON.stringify(e)).join("\n") + "\n" +
      // a truncated final line — real transcripts get cut off mid-write
      '{"type":"user","uuid":"u-trunc","timestamp":"2026-10-10T',
    "utf-8",
  );
  // a sibling file that holds nothing minable, to prove the walk is recursive
  // and that an empty file does not abort the run
  writeFileSync(join(TRANSCRIPTS, "session-b.jsonl"), "", "utf-8");
}

function mine(overrides: Record<string, unknown> = {}) {
  return mineTranscriptRatings({
    transcriptsDir: TRANSCRIPTS,
    ratingsPath: RATINGS,
    since: "2026-10-01",
    until: "2026-10-31",
    ...overrides,
  });
}

function readRatings(): Record<string, unknown>[] {
  if (!existsSync(RATINGS)) return [];
  return readFileSync(RATINGS, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
  writeFixture();
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

describe("backfill-ratings: extraction", () => {
  test("mines exactly the user prompts a rating parser recognises", async () => {
    const result = await mine();

    expect(result.written).toBe(MINEABLE.length);
    expect(readRatings().map((r) => r.source_uuid).sort()).toEqual([...MINEABLE].sort());
  });

  test("ignores assistant turns, tool results, sidechains and meta entries", async () => {
    await mine();
    const mined = new Set(readRatings().map((r) => r.source_uuid));

    for (const excluded of ["a-assistant", "u-toolresult", "u-sidechain", "u-meta", "u-plain", "u-count", "u-longplus1"]) {
      expect(mined.has(excluded)).toBe(false);
    }
  });

  test("honours the --since/--until window", async () => {
    await mine();
    const mined = new Set(readRatings().map((r) => r.source_uuid));

    expect(mined.has("u-before")).toBe(false);
    expect(mined.has("u-after")).toBe(false);

    const wide = await mine({ since: "2026-09-01", until: "2026-12-01" });
    expect(wide.written).toBe(2); // the two out-of-window ratings, and nothing re-written
    expect(new Set(readRatings().map((r) => r.source_uuid)).has("u-before")).toBe(true);
  });

  test("preserves the transcript timestamp instead of stamping now", async () => {
    await mine();
    const byUuid = new Map(readRatings().map((r) => [r.source_uuid, r]));

    expect(byUuid.get("u-explicit")!.timestamp).toBe("2026-10-05T10:00:00.000Z");
    expect(byUuid.get("u-thumbs")!.timestamp).toBe("2026-10-08T10:00:00.000Z");

    const today = new Date().toISOString().slice(0, 10);
    for (const record of readRatings()) {
      expect(String(record.timestamp).startsWith(today)).toBe(false);
    }
  });

  test("reuses the live parsers' scores, sources and dimensions", async () => {
    await mine();
    const byUuid = new Map(readRatings().map((r) => [r.source_uuid, r]));

    const explicit = byUuid.get("u-explicit")!;
    expect(explicit.source).toBe("explicit");
    expect(explicit.mode).toBe(7);
    expect(explicit.scope).toBe(8);
    expect(explicit.quality).toBe(9);
    expect(explicit.comment).toBe("solid work");
    expect(explicit.rating).toBe(8); // computeComposite(7, 8, 9)

    expect(byUuid.get("u-bare")!.source).toBe("implicit");
    expect(byUuid.get("u-bare")!.rating).toBe(8);
    expect(byUuid.get("u-praise")!.source).toBe("praise");
    expect(byUuid.get("u-thumbs")!.source).toBe("thumbs");
    expect(byUuid.get("u-thumbs")!.rating).toBe(9);
    expect(byUuid.get("u-blocks")!.source).toBe("explicit");
  });

  test("tags every mined record with backfill provenance and its session", async () => {
    await mine();

    for (const record of readRatings()) {
      expect(record.provenance).toBe("backfill");
      expect(record.type).toBe("rating");
      expect(record.session_id).toBe("sess-fixture");
      expect(typeof record.id).toBe("string");
    }
  });
});

describe("backfill-ratings: implicit ratings are gated on prompt length", () => {
  test("does not read a thumbs rating out of a long working prompt", async () => {
    await mine();
    expect(new Set(readRatings().map((r) => r.source_uuid)).has("u-longplus1")).toBe(false);
  });

  test("still mines a short thumbs or bare-number prompt", async () => {
    await mine();
    const mined = new Set(readRatings().map((r) => r.source_uuid));
    expect(mined.has("u-thumbs")).toBe(true);
    expect(mined.has("u-bare")).toBe(true);
  });

  test("an explicit /rate line is mined regardless of comment length", async () => {
    const nested = join(TRANSCRIPTS, "-Users-someone-project");
    writeFileSync(
      join(nested, "session-c.jsonl"),
      JSON.stringify(
        entry({
          uuid: "u-long-explicit",
          timestamp: "2026-10-11T10:00:00.000Z",
          content:
            "/rate M:9 S:9 Q:9 this is a deliberately long trailing comment that runs well past any word cap the implicit parsers apply",
        }),
      ) + "\n",
      "utf-8",
    );

    await mine();
    const record = readRatings().find((r) => r.source_uuid === "u-long-explicit");
    expect(record).toBeDefined();
    expect(record!.source).toBe("explicit");
  });
});

describe("backfill-ratings: idempotency", () => {
  test("keeps two identical ratings that are two separate transcript entries", async () => {
    await mine();
    const twins = readRatings().filter((r) => r.timestamp === "2026-10-12T09:00:00.000Z");

    expect(twins).toHaveLength(2);
    expect(new Set(twins.map((r) => r.source_uuid))).toEqual(new Set(["u-twin-a", "u-twin-b"]));
  });

  test("a second run over the same range writes nothing new", async () => {
    const first = await mine();
    expect(first.written).toBe(MINEABLE.length);
    const afterFirst = readFileSync(RATINGS, "utf-8");

    const second = await mine();
    expect(second.written).toBe(0);
    expect(second.skippedDuplicate).toBe(MINEABLE.length);
    expect(readFileSync(RATINGS, "utf-8")).toBe(afterFirst);
  });

  test("dedupes against records already in the file from a live capture", async () => {
    mkdirSync(join(TMP_DIR, "signals"), { recursive: true });
    writeFileSync(
      RATINGS,
      JSON.stringify({
        id: "pre-existing",
        type: "rating",
        timestamp: "2026-10-05T10:00:00.000Z",
        session_id: "sess-fixture",
        rating: 8,
        source: "explicit",
        source_uuid: "u-explicit",
      }) + "\n",
      "utf-8",
    );

    const result = await mine();
    expect(result.written).toBe(MINEABLE.length - 1);
    expect(result.skippedDuplicate).toBe(1);
    expect(readRatings().filter((r) => r.source_uuid === "u-explicit")).toHaveLength(1);
  });

  test("preserves records already in the file", async () => {
    mkdirSync(join(TMP_DIR, "signals"), { recursive: true });
    writeFileSync(RATINGS, JSON.stringify({ id: "live-1", type: "rating", rating: 5, source: "explicit" }) + "\n", "utf-8");

    await mine();
    expect(readRatings()[0].id).toBe("live-1");
    expect(readRatings()).toHaveLength(MINEABLE.length + 1);
  });
});

describe("backfill-ratings: dry run", () => {
  test("reports the same counts but writes nothing", async () => {
    const dry = await mine({ dryRun: true });

    expect(dry.dryRun).toBe(true);
    expect(dry.written).toBe(MINEABLE.length);
    expect(existsSync(RATINGS)).toBe(false);

    // and the real run afterwards still writes them — the dry run did not
    // record them as already-seen
    const wet = await mine();
    expect(wet.written).toBe(MINEABLE.length);
  });

  test("a dry run over an already-backfilled file reports zero", async () => {
    await mine();
    const dry = await mine({ dryRun: true });
    expect(dry.written).toBe(0);
  });
});

describe("backfill-ratings: survivability", () => {
  test("a missing transcripts directory reports zero rather than throwing", async () => {
    const result = await mineTranscriptRatings({
      transcriptsDir: join(TMP_DIR, "does-not-exist"),
      ratingsPath: RATINGS,
    });
    expect(result.scannedFiles).toBe(0);
    expect(result.written).toBe(0);
  });

  test("scans every transcript file under the root, recursively", async () => {
    const result = await mine();
    expect(result.scannedFiles).toBe(2);
  });
});
