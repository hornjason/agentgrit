import { describe, expect, test } from "bun:test";
import { analyzeScores, detectTrends } from "../../src/evaluate/analysis";
import type { Score } from "../../src/adapters/types";

function makeScore(dimension: string, value: number, daysAgo = 0): Score {
  const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return {
    traceId: `trace-${Math.random()}`, dimension, value,
    rubric: "Score 1-5", judgeModel: "test-model",
    timestamp: ts.toISOString(), schemaVersion: 1,
  };
}

describe("analyzeScores", () => {
  test("computes correct stats for single dimension", () => {
    const scores = [
      makeScore("accuracy", 3), makeScore("accuracy", 5),
      makeScore("accuracy", 4), makeScore("accuracy", 2),
    ];
    const results = analyzeScores(scores);
    expect(results).toHaveLength(1);
    const accuracy = results[0];
    expect(accuracy.dimension).toBe("accuracy");
    expect(accuracy.avg).toBe(3.5);
    expect(accuracy.min).toBe(2);
    expect(accuracy.max).toBe(5);
    expect(accuracy.count).toBe(4);
    expect(accuracy.stddev).toBeGreaterThan(0);
  });

  test("handles multiple dimensions sorted by avg ascending", () => {
    const scores = [
      makeScore("accuracy", 4), makeScore("accuracy", 5),
      makeScore("conciseness", 2), makeScore("conciseness", 3),
    ];
    const results = analyzeScores(scores);
    expect(results).toHaveLength(2);
    expect(results[0].dimension).toBe("conciseness");
    expect(results[0].avg).toBe(2.5);
    expect(results[1].dimension).toBe("accuracy");
    expect(results[1].avg).toBe(4.5);
  });

  test("empty scores returns empty array", () => {
    expect(analyzeScores([])).toEqual([]);
  });

  test("single score computes with stddev 0", () => {
    const results = analyzeScores([makeScore("accuracy", 4)]);
    expect(results[0].stddev).toBe(0);
    expect(results[0].avg).toBe(4);
    expect(results[0].min).toBe(4);
    expect(results[0].max).toBe(4);
  });
});

describe("detectTrends", () => {
  test("detects improving trend", () => {
    const scores = [
      makeScore("accuracy", 2, 14), makeScore("accuracy", 2, 10),
      makeScore("accuracy", 4, 3), makeScore("accuracy", 5, 1),
    ];
    const trends = detectTrends(scores, 7);
    expect(trends).toHaveLength(1);
    expect(trends[0].dimension).toBe("accuracy");
    expect(trends[0].direction).toBe("improving");
    expect(trends[0].delta).toBeGreaterThan(0);
  });

  test("detects declining trend", () => {
    const scores = [
      makeScore("accuracy", 5, 14), makeScore("accuracy", 4, 10),
      makeScore("accuracy", 2, 3), makeScore("accuracy", 1, 1),
    ];
    const trends = detectTrends(scores, 7);
    expect(trends).toHaveLength(1);
    expect(trends[0].direction).toBe("declining");
    expect(trends[0].delta).toBeLessThan(0);
  });

  test("detects stable trend", () => {
    const scores = [
      makeScore("accuracy", 3, 14), makeScore("accuracy", 3, 10),
      makeScore("accuracy", 3, 3), makeScore("accuracy", 3, 1),
    ];
    const trends = detectTrends(scores, 7);
    expect(trends).toHaveLength(1);
    expect(trends[0].direction).toBe("stable");
  });

  test("empty scores returns empty array", () => {
    expect(detectTrends([])).toEqual([]);
  });

  test("all scores in recent window returns no trends", () => {
    const scores = [makeScore("accuracy", 4, 1), makeScore("accuracy", 5, 2)];
    const trends = detectTrends(scores, 7);
    expect(trends).toHaveLength(0);
  });

  test("handles multiple dimensions independently", () => {
    const scores = [
      makeScore("accuracy", 2, 14), makeScore("accuracy", 5, 1),
      makeScore("conciseness", 5, 14), makeScore("conciseness", 2, 1),
    ];
    const trends = detectTrends(scores, 7);
    expect(trends).toHaveLength(2);
    expect(trends.find((t) => t.dimension === "accuracy")?.direction).toBe("improving");
    expect(trends.find((t) => t.dimension === "conciseness")?.direction).toBe("declining");
  });
});
