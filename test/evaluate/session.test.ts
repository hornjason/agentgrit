import { describe, expect, test } from "bun:test";
import { scoreSession } from "../../src/evaluate/session";
import type { CorrectionSignal, RatingSignal, SentimentSignal } from "../../src/adapters/types";

function makeRating(rating: number): RatingSignal {
  return {
    id: `r-${Math.random()}`, timestamp: new Date().toISOString(),
    sessionId: "test-session", schemaVersion: 1, type: "rating",
    rating, source: "explicit",
  };
}

function makeCorrection(severity: number): CorrectionSignal {
  return {
    id: `c-${Math.random()}`, timestamp: new Date().toISOString(),
    sessionId: "test-session", schemaVersion: 1, type: "correction",
    trigger: "no", context: "test context", severity,
  };
}

function makeSentiment(rating: number): SentimentSignal {
  return {
    id: `s-${Math.random()}`, timestamp: new Date().toISOString(),
    sessionId: "test-session", schemaVersion: 1, type: "sentiment",
    rating, source: "transcript-analysis", confidence: 0.8,
    corrections: 0, approvals: 1, reprompts: 0,
  };
}

describe("scoreSession", () => {
  test("perfect session scores high", () => {
    const score = scoreSession({
      ratings: [makeRating(10)], corrections: [], sentiment: [makeSentiment(10)],
    });
    expect(score).toBeGreaterThan(0.9);
    expect(score).toBeLessThanOrEqual(1.0);
  });

  test("terrible session scores low", () => {
    const score = scoreSession({
      ratings: [makeRating(1)],
      corrections: [makeCorrection(5), makeCorrection(5)],
      sentiment: [makeSentiment(1)],
    });
    expect(score).toBeLessThan(0.2);
  });

  test("empty signals returns baseline", () => {
    const score = scoreSession({ ratings: [], corrections: [], sentiment: [] });
    expect(score).toBeCloseTo(0.65, 1);
  });

  test("corrections reduce score", () => {
    const without = scoreSession({
      ratings: [makeRating(7)], corrections: [], sentiment: [makeSentiment(7)],
    });
    const with_ = scoreSession({
      ratings: [makeRating(7)],
      corrections: [makeCorrection(3), makeCorrection(2)],
      sentiment: [makeSentiment(7)],
    });
    expect(with_).toBeLessThan(without);
  });

  test("multiple ratings are averaged", () => {
    const score = scoreSession({
      ratings: [makeRating(10), makeRating(6)], corrections: [], sentiment: [makeSentiment(5)],
    });
    const expected = 0.4 * (8 / 10) + 0.3 * 1.0 + 0.3 * (5 / 10);
    expect(score).toBeCloseTo(expected, 2);
  });

  test("score is clamped between 0 and 1", () => {
    const score = scoreSession({
      ratings: [makeRating(0)],
      corrections: [makeCorrection(10), makeCorrection(10)],
      sentiment: [makeSentiment(0)],
    });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});
