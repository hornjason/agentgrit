import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { runReview } from "../../src/promote/review";

const TMP_DIR = join(import.meta.dir, ".tmp-review-test");
const SIGNAL_DIR = join(TMP_DIR, "signals");
const STATE_DIR = join(TMP_DIR, "state");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(SIGNAL_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

function writeRatings(entries: Array<{ rating: number; sentiment_summary?: string; timestamp?: string }>) {
  const lines = entries.map((e) =>
    JSON.stringify({
      rating: e.rating,
      sentiment_summary: e.sentiment_summary,
      timestamp: e.timestamp ?? new Date().toISOString(),
      source: "explicit",
    }),
  );
  Bun.write(join(SIGNAL_DIR, "ratings.jsonl"), lines.join("\n") + "\n");
}

describe("runReview", () => {
  test("returns empty result when no ratings file exists", async () => {
    const result = await runReview(
      join(TMP_DIR, "nonexistent"),
      STATE_DIR,
    );
    expect(result.patternsFound).toBe(0);
    expect(result.candidatesProposed).toBe(0);
    expect(result.candidates).toEqual([]);
  });

  test("detects pattern from similar low-rated summaries", async () => {
    writeRatings([
      { rating: 2, sentiment_summary: "wrong scope answered different question" },
      { rating: 3, sentiment_summary: "wrong scope misread the question" },
      { rating: 2, sentiment_summary: "wrong scope gave general answer" },
    ]);

    const result = await runReview(SIGNAL_DIR, STATE_DIR);
    expect(result.candidatesProposed).toBeGreaterThanOrEqual(1);
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    expect(result.candidates[0].frequency).toBeGreaterThanOrEqual(3);
  });

  test("skips clusters with high average rating", async () => {
    writeRatings([
      { rating: 8, sentiment_summary: "great work done correctly" },
      { rating: 9, sentiment_summary: "great work completed well" },
      { rating: 7, sentiment_summary: "great work finished properly" },
    ]);

    const result = await runReview(SIGNAL_DIR, STATE_DIR);
    expect(result.candidatesProposed).toBe(0);
  });

  test("skips clusters smaller than minimum pattern size", async () => {
    writeRatings([
      { rating: 2, sentiment_summary: "wrong scope answered different question" },
      { rating: 3, sentiment_summary: "wrong scope misread the question" },
    ]);

    const result = await runReview(SIGNAL_DIR, STATE_DIR);
    expect(result.candidatesProposed).toBe(0);
  });

  test("computes score trend correctly", async () => {
    writeRatings([
      { rating: 3, timestamp: "2024-01-01T00:00:00Z" },
      { rating: 4, timestamp: "2024-01-02T00:00:00Z" },
      { rating: 7, timestamp: "2024-01-03T00:00:00Z" },
      { rating: 8, timestamp: "2024-01-04T00:00:00Z" },
    ]);

    const result = await runReview(SIGNAL_DIR, STATE_DIR);
    expect(result.scoreTrend.count).toBe(4);
    expect(result.scoreTrend.direction).toBe("up");
  });

  test("flat trend for consistent ratings", async () => {
    writeRatings([
      { rating: 5, timestamp: "2024-01-01T00:00:00Z" },
      { rating: 5, timestamp: "2024-01-02T00:00:00Z" },
      { rating: 5, timestamp: "2024-01-03T00:00:00Z" },
      { rating: 5, timestamp: "2024-01-04T00:00:00Z" },
    ]);

    const result = await runReview(SIGNAL_DIR, STATE_DIR);
    expect(result.scoreTrend.direction).toBe("flat");
  });
});
