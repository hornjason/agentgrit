/**
 * Covers #254 — a correction record with no `correction_phrase` aborted the
 * whole detection pass.
 *
 * The real signal file carries 21 such records out of 3011: cross-session
 * message captures that store the text as `user_text`. `failures.ts` reached
 * straight for `.correction_phrase.slice(...)`, so one unreadable record meant
 * zero patterns from a file that was 99% readable — and it took `agentgrit
 * inbox` down with it.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { detectFailurePatterns } from "../../src/detect/failures";

let dir: string;

/** Enough matching records to clear DEFAULT_THRESHOLD (5) and form one group. */
function readableRecords(count: number, phrase: string): string[] {
  return Array.from({ length: count }, (_, i) =>
    JSON.stringify({
      type: "correction",
      timestamp: `2026-10-0${(i % 9) + 1}T10:00:00.000Z`,
      session_id: `session-${i}`,
      correction_phrase: phrase,
      context: "Assistant: asserted something without checking the source first",
    }),
  );
}

/** The shape that crashed: a capture carrying `user_text` and no phrase. */
const USER_TEXT_ONLY = JSON.stringify({
  type: "correction",
  timestamp: "2026-10-05T10:00:00.000Z",
  session_id: "session-cross",
  user_text: "Another Claude session sent a message: verify before asserting",
  context: "Assistant: cross-session relay",
});

/** Neither field — must be skipped, not rendered as an empty group. */
const NO_TEXT_AT_ALL = JSON.stringify({
  type: "correction",
  timestamp: "2026-10-05T11:00:00.000Z",
  session_id: "session-empty",
  context: "Assistant: nothing usable here",
});

function writeSignals(lines: string[]): void {
  mkdirSync(join(dir, "signals"), { recursive: true });
  writeFileSync(join(dir, "signals", "corrections.jsonl"), lines.join("\n") + "\n", "utf-8");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ag-254-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("#254: a record with no correction_phrase must not abort detection", () => {
  test("a user_text-only record does not throw", async () => {
    writeSignals([USER_TEXT_ONLY, ...readableRecords(6, "verify before asserting")]);

    // The assertion that matters is that this resolves at all. Pre-fix it threw
    // TypeError: undefined is not an object (evaluating 'signal.correction_phrase.slice').
    const patterns = await detectFailurePatterns(join(dir, "signals"));
    expect(Array.isArray(patterns)).toBe(true);
  });

  test("the readable records still produce their pattern", async () => {
    writeSignals([USER_TEXT_ONLY, ...readableRecords(6, "verify before asserting")]);

    const patterns = await detectFailurePatterns(join(dir, "signals"));

    // Pre-fix this was 0 — one bad record cost every pattern in the file.
    expect(patterns.length).toBeGreaterThanOrEqual(1);
    expect(patterns[0].frequency).toBeGreaterThanOrEqual(5);
  });

  test("a record carrying neither field is skipped, not grouped as empty text", async () => {
    writeSignals([NO_TEXT_AT_ALL, ...readableRecords(6, "verify before asserting")]);

    const patterns = await detectFailurePatterns(join(dir, "signals"));

    // An empty-text record must not become its own group with a blank
    // representative, and must not be counted into a real group's frequency.
    for (const p of patterns) {
      expect(p.candidateRule.trim().length).toBeGreaterThan(0);
    }
    expect(patterns.reduce((n, p) => n + p.frequency, 0)).toBe(6);
  });

  test("user_text is READ, not merely skipped — it can form a pattern of its own", async () => {
    // The distinction this case exists for: AC1 allows skipping or falling
    // back, and the two are indistinguishable while user_text records are too
    // few to clear the threshold. Give them their own quorum and the
    // difference becomes observable — a skip yields no pattern here, a
    // fallback yields one carrying the user_text wording.
    const userTextQuorum = Array.from({ length: 6 }, (_, i) =>
      JSON.stringify({
        type: "correction",
        timestamp: `2026-10-0${(i % 9) + 1}T12:00:00.000Z`,
        session_id: `relay-${i}`,
        user_text: "stop regenerating the manifest on every deploy",
        context: "Assistant: regenerated the manifest unprompted",
      }),
    );
    writeSignals([NO_TEXT_AT_ALL, ...userTextQuorum]);

    const patterns = await detectFailurePatterns(join(dir, "signals"));

    expect(patterns.length).toBe(1);
    expect(patterns[0].frequency).toBe(6);
    // The no-text record contributed nothing, and the wording came from user_text.
    expect(patterns[0].candidateRule).toContain("regenerating the manifest");
  });
});
