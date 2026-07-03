import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { captureRating, parseRating, scoreSentiment } from "../../src/capture/rating";

const TMP_DIR = join(import.meta.dir, ".tmp-rating-test");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

describe("parseRating", () => {
  test("parses /rate M:7 S:8 Q:6", () => {
    const result = parseRating("/rate M:7 S:8 Q:6");
    expect(result).not.toBeNull();
    expect(result!.mode).toBe(7);
    expect(result!.scope).toBe(8);
    expect(result!.quality).toBe(6);
    expect(result!.comment).toBeUndefined();
  });

  test("parses /rate with comment", () => {
    const result = parseRating("/rate M:9 S:9 Q:10 excellent session");
    expect(result).not.toBeNull();
    expect(result!.mode).toBe(9);
    expect(result!.quality).toBe(10);
    expect(result!.comment).toBe("excellent session");
  });

  test("returns null for non-rate messages", () => {
    expect(parseRating("hello world")).toBeNull();
    expect(parseRating("/help")).toBeNull();
    expect(parseRating("M:7 S:8 Q:6")).toBeNull();
  });

  test("returns null for out-of-range values", () => {
    expect(parseRating("/rate M:0 S:8 Q:6")).toBeNull();
    expect(parseRating("/rate M:7 S:11 Q:6")).toBeNull();
  });

  test("case insensitive", () => {
    const result = parseRating("/RATE m:7 s:8 q:6");
    expect(result).not.toBeNull();
    expect(result!.mode).toBe(7);
  });
});

describe("scoreSentiment", () => {
  test("detects positive sentiment", () => {
    const result = scoreSentiment("excellent amazing work");
    expect(result).not.toBeNull();
    expect(result!.summary).toContain("Positive");
    expect(result!.confidence).toBeGreaterThan(0.5);
  });

  test("detects negative sentiment", () => {
    const result = scoreSentiment("terrible broken failure");
    expect(result).not.toBeNull();
    expect(result!.summary).toContain("Negative");
  });

  test("returns null for neutral text", () => {
    const result = scoreSentiment("please check the logs");
    expect(result).toBeNull();
  });
});

describe("captureRating", () => {
  test("writes signal for valid /rate command", async () => {
    const signal = await captureRating("/rate M:7 S:8 Q:6", "test-session");
    expect(signal).not.toBeNull();
    expect(signal!.type).toBe("rating");
    expect(signal!.source).toBe("explicit");
    expect(signal!.rating).toBeGreaterThan(0);
    expect(signal!.session_id).toBe("test-session");

    const filePath = join(TMP_DIR, "signals", "ratings.jsonl");
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.type).toBe("rating");
  });

  test("returns null for non-rate messages", async () => {
    const signal = await captureRating("hello", "test-session");
    expect(signal).toBeNull();
  });

  test("computes composite rating", async () => {
    const signal = await captureRating("/rate M:10 S:10 Q:10", "test-session");
    expect(signal).not.toBeNull();
    expect(signal!.rating).toBe(10);
  });
});
