import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { appendSignal, normalizeRating, readSignals, rotateFile } from "../../src/adapters/jsonl";
import type { RatingSignal } from "../../src/adapters/types";
import { SCHEMA_VERSION } from "../../src/adapters/types";

const TMP_DIR = join(import.meta.dir, ".tmp-jsonl-test");
const TEST_FILE = join(TMP_DIR, "test-signals.jsonl");

function makeSignal(id: string, rating = 8): RatingSignal {
  return {
    id,
    type: "rating",
    timestamp: new Date().toISOString(),
    session_id: "test-session",
    schemaVersion: SCHEMA_VERSION,
    rating,
    source: "explicit",
  };
}

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

describe("appendSignal", () => {
  test("creates file and writes one signal", async () => {
    const signal = makeSignal("s1");
    await appendSignal(TEST_FILE, signal);

    expect(existsSync(TEST_FILE)).toBe(true);
    const content = readFileSync(TEST_FILE, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).id).toBe("s1");
  });

  test("appends multiple signals", async () => {
    await appendSignal(TEST_FILE, makeSignal("s1"));
    await appendSignal(TEST_FILE, makeSignal("s2"));
    await appendSignal(TEST_FILE, makeSignal("s3"));

    const content = readFileSync(TEST_FILE, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2]).id).toBe("s3");
  });

  test("creates parent directories", async () => {
    const nested = join(TMP_DIR, "deep", "nested", "file.jsonl");
    await appendSignal(nested, makeSignal("s1"));
    expect(existsSync(nested)).toBe(true);
  });
});

describe("readSignals", () => {
  test("returns empty array for missing file", async () => {
    const result = await readSignals(join(TMP_DIR, "nonexistent.jsonl"));
    expect(result).toEqual([]);
  });

  test("reads all signals", async () => {
    await appendSignal(TEST_FILE, makeSignal("s1"));
    await appendSignal(TEST_FILE, makeSignal("s2"));

    const result = await readSignals(TEST_FILE);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("s1");
    expect(result[1].id).toBe("s2");
  });

  test("supports offset and limit", async () => {
    for (let i = 0; i < 5; i++) {
      await appendSignal(TEST_FILE, makeSignal(`s${i}`));
    }

    const result = await readSignals(TEST_FILE, { offset: 1, limit: 2 });
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("s1");
    expect(result[1].id).toBe("s2");
  });

  test("skips malformed lines", async () => {
    await Bun.write(TEST_FILE, '{"id":"s1","type":"rating","timestamp":"2024-01-01T00:00:00Z","session_id":"x","schemaVersion":1,"rating":8,"source":"explicit"}\nnot-json\n{"id":"s2","type":"rating","timestamp":"2024-01-01T00:00:00Z","session_id":"x","schemaVersion":1,"rating":9,"source":"explicit"}\n');

    const result = await readSignals(TEST_FILE);
    expect(result).toHaveLength(2);
  });
});

describe("normalizeRating", () => {
  test("maps PAI M/S/Q/avg fields to mode/scope/quality/rating", () => {
    const entry = { M: 4, S: 5, Q: 3, avg: 4.0, type: "rating" };
    const result = normalizeRating(entry);
    expect(result.mode).toBe(4);
    expect(result.scope).toBe(5);
    expect(result.quality).toBe(3);
    expect(result.rating).toBe(4.0);
  });

  test("does not overwrite existing mode/scope/quality/rating", () => {
    const entry = { M: 4, S: 5, Q: 3, avg: 4.0, mode: 7, scope: 8, quality: 9, rating: 6.5 };
    const result = normalizeRating(entry);
    expect(result.mode).toBe(7);
    expect(result.scope).toBe(8);
    expect(result.quality).toBe(9);
    expect(result.rating).toBe(6.5);
  });

  test("handles entries with no PAI fields", () => {
    const entry = { type: "rating", rating: 5, mode: 6, scope: 7, quality: 8 };
    const result = normalizeRating(entry);
    expect(result.mode).toBe(6);
    expect(result.scope).toBe(7);
    expect(result.quality).toBe(8);
    expect(result.rating).toBe(5);
  });
});

describe("readSignals — PAI normalization", () => {
  test("normalizes PAI M/S/Q fields on read", async () => {
    const paiEntry = JSON.stringify({
      type: "rating",
      M: 4,
      S: 5,
      Q: 3,
      avg: 4.0,
      timestamp: "2026-03-21T19:41:03Z",
      session_id: "test-session",
    });
    await Bun.write(TEST_FILE, paiEntry + "\n");

    const result = await readSignals(TEST_FILE);
    expect(result).toHaveLength(1);
    const rating = result[0] as RatingSignal;
    expect(rating.mode).toBe(4);
    expect(rating.scope).toBe(5);
    expect(rating.quality).toBe(3);
    expect(rating.rating).toBe(4.0);
  });
});

describe("rotateFile", () => {
  test("does not rotate small files", async () => {
    await appendSignal(TEST_FILE, makeSignal("s1"));

    const result = await rotateFile(TEST_FILE, 1_000_000);
    expect(result.rotated).toBe(false);
    expect(result.archivePath).toBeUndefined();
  });

  test("rotates file exceeding threshold", async () => {
    const bigData = "x".repeat(100) + "\n";
    await Bun.write(TEST_FILE, bigData.repeat(100));

    const result = await rotateFile(TEST_FILE, 500);
    expect(result.rotated).toBe(true);
    expect(result.archivePath).toBeDefined();
    expect(existsSync(result.archivePath!)).toBe(true);

    const remaining = readFileSync(TEST_FILE, "utf-8");
    expect(remaining).toBe("");
  });

  test("returns false for missing file", async () => {
    const result = await rotateFile(join(TMP_DIR, "nope.jsonl"), 100);
    expect(result.rotated).toBe(false);
  });
});
