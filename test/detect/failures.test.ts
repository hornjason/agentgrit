import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { appendSignal } from "../../src/adapters/jsonl";
import { detectFailurePatterns } from "../../src/detect/failures";
import type { CorrectionSignal } from "../../src/adapters/types";
import { SCHEMA_VERSION } from "../../src/adapters/types";

const TMP_DIR = join(import.meta.dir, ".tmp-failures-test");

function makeCorrection(
  id: string,
  sessionId: string,
  correctionPhrase: string,
): CorrectionSignal {
  return {
    id,
    type: "correction",
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    schemaVersion: SCHEMA_VERSION,
    correction_phrase: correctionPhrase,
    context: `Context for ${correctionPhrase}`,
  };
}

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

describe("detectFailurePatterns", () => {
  test("5 identical corrections produce 1 pattern", async () => {
    const file = join(TMP_DIR, "corrections.jsonl");
    for (let i = 0; i < 5; i++) {
      await appendSignal(
        file,
        makeCorrection(`c${i}`, `session-${i}`, "stop doing that wrong thing"),
      );
    }

    const patterns = await detectFailurePatterns(TMP_DIR, 5);
    expect(patterns.length).toBe(1);
    expect(patterns[0].type).toBe("failure");
    expect(patterns[0].frequency).toBeGreaterThanOrEqual(5);
    expect(patterns[0].candidateRule).toBeDefined();
  });

  test("2 corrections below threshold produce 0 patterns", async () => {
    const file = join(TMP_DIR, "corrections.jsonl");
    for (let i = 0; i < 2; i++) {
      await appendSignal(
        file,
        makeCorrection(`c${i}`, `session-${i}`, "stop doing that wrong thing"),
      );
    }

    const patterns = await detectFailurePatterns(TMP_DIR, 5);
    expect(patterns.length).toBe(0);
  });

  test("noise corrections with no overlap produce 0 patterns", async () => {
    const file = join(TMP_DIR, "corrections.jsonl");
    const uniqueTriggers = [
      "alpha bravo charlie delta echo foxtrot",
      "golf hotel india juliet kilo lima",
      "mike november oscar papa quebec romeo",
    ];

    for (let i = 0; i < uniqueTriggers.length; i++) {
      await appendSignal(
        file,
        makeCorrection(`c${i}`, `session-${i}`, uniqueTriggers[i]),
      );
    }

    const patterns = await detectFailurePatterns(TMP_DIR, 5);
    expect(patterns.length).toBe(0);
  });

  test("empty signal dir produces 0 patterns", async () => {
    const patterns = await detectFailurePatterns(TMP_DIR, 5);
    expect(patterns.length).toBe(0);
  });

  test("patterns include session ids and timestamps", async () => {
    const file = join(TMP_DIR, "corrections.jsonl");
    for (let i = 0; i < 6; i++) {
      await appendSignal(
        file,
        makeCorrection(`c${i}`, `sess-${i}`, "verify before asserting claims"),
      );
    }

    const patterns = await detectFailurePatterns(TMP_DIR, 5);
    expect(patterns.length).toBe(1);
    expect(patterns[0].sessions.length).toBeGreaterThanOrEqual(5);
    expect(patterns[0].severity).toBeGreaterThan(0);
    expect(patterns[0].firstSeen).toBeDefined();
    expect(patterns[0].lastSeen).toBeDefined();
  });
});
