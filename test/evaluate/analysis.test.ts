import { describe, expect, test } from "bun:test";
import { analyzeImpact, analyzeScores, analyzeToolAudit, detectTrends } from "../../src/evaluate/analysis";
import type { Score } from "../../src/adapters/types";

function makeScore(dim: string, val: number, daysAgo = 0): Score {
  return { traceId: `t-${Math.random()}`, dimension: dim, value: val, rubric: "Score 1-5", judgeModel: "test", timestamp: new Date(Date.now() - daysAgo * 86400000).toISOString(), schemaVersion: 1 };
}

describe("analyzeScores", () => {
  test("single dimension stats", () => { const r = analyzeScores([makeScore("a", 3), makeScore("a", 5), makeScore("a", 4), makeScore("a", 2)]); expect(r[0].avg).toBe(3.5); expect(r[0].min).toBe(2); expect(r[0].max).toBe(5); expect(r[0].stddev).toBeGreaterThan(0); });
  test("sorted by avg", () => { const r = analyzeScores([makeScore("a", 4), makeScore("a", 5), makeScore("b", 2), makeScore("b", 3)]); expect(r[0].dimension).toBe("b"); expect(r[1].dimension).toBe("a"); });
  test("empty", () => { expect(analyzeScores([])).toEqual([]); });
  test("single", () => { expect(analyzeScores([makeScore("a", 4)])[0].stddev).toBe(0); });
});

describe("detectTrends", () => {
  test("improving", () => { expect(detectTrends([makeScore("a", 2, 14), makeScore("a", 2, 10), makeScore("a", 4, 3), makeScore("a", 5, 1)], 7)[0].direction).toBe("improving"); });
  test("declining", () => { expect(detectTrends([makeScore("a", 5, 14), makeScore("a", 4, 10), makeScore("a", 2, 3), makeScore("a", 1, 1)], 7)[0].direction).toBe("declining"); });
  test("stable", () => { expect(detectTrends([makeScore("a", 3, 14), makeScore("a", 3, 10), makeScore("a", 3, 3), makeScore("a", 3, 1)], 7)[0].direction).toBe("stable"); });
  test("empty", () => { expect(detectTrends([])).toEqual([]); });
  test("all recent", () => { expect(detectTrends([makeScore("a", 4, 1), makeScore("a", 5, 2)], 7)).toHaveLength(0); });
  test("multi dim", () => { const t = detectTrends([makeScore("a", 2, 14), makeScore("a", 5, 1), makeScore("b", 5, 14), makeScore("b", 2, 1)], 7); expect(t.find((x) => x.dimension === "a")?.direction).toBe("improving"); expect(t.find((x) => x.dimension === "b")?.direction).toBe("declining"); });
});

describe("analyzeImpact", () => {
  test("empty", () => { expect(analyzeImpact([]).totalSessions).toBe(0); });
  test("improvement", () => { const ratings = []; for (let i = 0; i < 20; i++) ratings.push({ timestamp: "2026-01-01T00:00:00Z", rating: 4 }); for (let i = 0; i < 20; i++) ratings.push({ timestamp: "2026-06-01T00:00:00Z", rating: 8 }); const r = analyzeImpact(ratings); expect(r.first20Avg).toBe(4); expect(r.last20Avg).toBe(8); expect(r.improvement).toBe(4); });
  test("attribution", () => { expect(analyzeImpact([{ timestamp: "2026-01-01T00:00:00Z", rating: 7, ruleIds: ["r1"] }, { timestamp: "2026-01-02T00:00:00Z", rating: 5 }, { timestamp: "2026-01-03T00:00:00Z", rating: 6, ruleIds: ["r2"] }]).ruleAttributionRate).toBe(67); });
  test("weekly trends", () => { const r = analyzeImpact([{ timestamp: "2026-01-06T00:00:00Z", rating: 5 }, { timestamp: "2026-01-13T00:00:00Z", rating: 9 }]); expect(r.weeklyTrends.length).toBeGreaterThan(0); expect(r.weeklyTrends[0].week).toMatch(/^\d{4}-W\d{2}$/); });
});

describe("analyzeToolAudit", () => {
  test("aggregates", () => { const r = analyzeToolAudit([{ tool: "Read", ok: true }, { tool: "Read", ok: true }, { tool: "Read", ok: false }, { tool: "Bash", ok: true }, { tool: "Bash", ok: false }]); expect(r.totalCalls).toBe(5); expect(r.toolCount).toBe(2); });
  test("flags above threshold", () => { const r = analyzeToolAudit([{ tool: "f", ok: false }, { tool: "f", ok: false }, { tool: "f", ok: true }, { tool: "s", ok: true }, { tool: "s", ok: true }], 0.10); expect(r.flaggedCount).toBe(1); expect(r.flaggedTools[0].tool).toBe("f"); });
  test("sort by error rate", () => { const r = analyzeToolAudit([{ tool: "a", ok: true }, { tool: "a", ok: true }, { tool: "b", ok: false }, { tool: "b", ok: true }, { tool: "c", ok: false }, { tool: "c", ok: false }]); expect(r.tools[0].tool).toBe("c"); });
  test("empty", () => { expect(analyzeToolAudit([]).totalCalls).toBe(0); });
  test("missing tool field", () => { expect(analyzeToolAudit([{ ok: true }, { ok: false }]).tools[0].tool).toBe("unknown"); });
});
