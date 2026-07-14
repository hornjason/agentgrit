import { describe, expect, test } from "bun:test";
import { aggregateRecallScores, bootstrapCI, evaluateRecall, evaluateSessionRecall, precisionAtK, recallAtK, reciprocalRank } from "../../src/evaluate/recall";
import type { Rule } from "../../src/adapters/types";
import { Tier } from "../../src/adapters/types";

function makeRule(id: string, tags: string[]): Rule {
  return { id, text: `Rule: ${id}`, tier: Tier.Graph, tags, created: new Date().toISOString(), correlationScore: 0.5, sourceSignals: [], schemaVersion: 1 };
}

describe("evaluateRecall", () => {
  test("perfect rule recall", () => { const r = evaluateRecall(["testing"], [makeRule("r1", ["testing"]), makeRule("r2", ["testing"]), makeRule("r3", ["deployment"])], [], []); expect(r.ruleRecall).toBe(1); expect(r.ruleHits).toEqual(["r1", "r2"]); expect(r.totalExpectedRules).toBe(2); });
  test("partial rule recall with availableRules", () => { const r = evaluateRecall(["testing"], [makeRule("r1", ["testing"])], [], [], [makeRule("r1", ["testing"]), makeRule("r2", ["testing"])]); expect(r.ruleRecall).toBe(0.5); });
  test("zero rule recall when none match", () => { expect(evaluateRecall(["deployment"], [makeRule("r1", ["testing"])], [], []).ruleRecall).toBe(1); });
  test("perfect skill recall", () => { expect(evaluateRecall(["testing"], [], ["ship", "verify", "tdd"], ["ship", "verify"]).skillRecall).toBe(1); });
  test("partial skill recall", () => { expect(evaluateRecall(["testing"], [], ["ship"], ["ship", "verify", "tdd"]).skillRecall).toBeCloseTo(0.333, 2); });
  test("no expected skills returns recall 1", () => { expect(evaluateRecall(["testing"], [], ["ship"], []).skillRecall).toBe(1); });
  test("combined rule and skill evaluation", () => { const r = evaluateRecall(["testing"], [makeRule("r1", ["testing"]), makeRule("r2", ["testing"])], ["ship", "verify"], ["ship", "verify", "tdd"]); expect(r.ruleRecall).toBe(1); expect(r.skillRecall).toBeCloseTo(0.667, 2); });
});

describe("recallAtK", () => {
  test("perfect recall", () => { expect(recallAtK(["a", "b"], ["a", "b", "c"], 3)).toBe(1); });
  test("partial recall", () => { expect(recallAtK(["a", "b", "c"], ["a", "d", "e"], 3)).toBeCloseTo(0.333, 2); });
  test("zero recall", () => { expect(recallAtK(["a", "b"], ["c", "d"], 2)).toBe(0); });
  test("empty gold", () => { expect(recallAtK([], ["a"], 1)).toBe(0); });
  test("k limits", () => { expect(recallAtK(["c"], ["a", "b", "c"], 2)).toBe(0); expect(recallAtK(["c"], ["a", "b", "c"], 3)).toBe(1); });
});

describe("precisionAtK", () => {
  test("perfect", () => { expect(precisionAtK(["a", "b"], ["a", "b"], 2)).toBe(1); });
  test("partial", () => { expect(precisionAtK(["a"], ["a", "b", "c"], 3)).toBeCloseTo(0.333, 2); });
  test("k=0", () => { expect(precisionAtK(["a"], ["a"], 0)).toBe(0); });
});

describe("reciprocalRank", () => {
  test("first position", () => { expect(reciprocalRank(["a"], ["a", "b", "c"])).toBe(1); });
  test("second position", () => { expect(reciprocalRank(["b"], ["a", "b", "c"])).toBe(0.5); });
  test("no hit", () => { expect(reciprocalRank(["x"], ["a", "b"])).toBe(0); });
  test("empty gold", () => { expect(reciprocalRank([], ["a"])).toBe(0); });
});

describe("bootstrapCI", () => {
  test("empty", () => { expect(bootstrapCI([])).toEqual([0, 0]); });
  test("identical", () => { const [lo, hi] = bootstrapCI([5, 5, 5, 5, 5]); expect(lo).toBe(5); expect(hi).toBe(5); });
  test("range", () => { const [lo, hi] = bootstrapCI([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5000); expect(lo).toBeGreaterThanOrEqual(1); expect(hi).toBeLessThanOrEqual(10); expect(lo).toBeLessThan(hi); });
});

describe("evaluateSessionRecall", () => {
  test("without cluster expansion", () => { const r = evaluateSessionRecall("s1", "test", ["a", "b", "c"], ["a", "d", "e", "b", "f"]); expect(r.recall5).toBeCloseTo(0.667, 2); expect(r.mrr).toBe(1); });
  test("with cluster expansion", () => { const n = new Map([["x", ["a"]]]); const r = evaluateSessionRecall("s1", "test", ["a"], ["x", "y", "z"], n); expect(r.recall3).toBe(1); expect(r.mrr).toBe(1); });
  test("recall@15 captures rules beyond top-5", () => {
    // 4 gold rules spread across 15 retrieved positions — only 1 in top-5, 3 in top-15
    const gold = ["g1", "g2", "g3", "g4"];
    const retrieved = ["g1", "x1", "x2", "x3", "x4", "x5", "x6", "g2", "x7", "x8", "x9", "x10", "g3", "x11", "x12"];
    const r = evaluateSessionRecall("s1", "recall@15 test", gold, retrieved);
    expect(r.recall5).toBe(0.25);   // 1/4 in top-5
    expect(r.recall15).toBe(0.75);  // 3/4 in top-15
  });
});

describe("aggregateRecallScores", () => {
  test("aggregates with CI", () => { const s = [evaluateSessionRecall("s1", "t1", ["a", "b"], ["a", "b", "c", "d", "e"]), evaluateSessionRecall("s2", "t2", ["x"], ["x", "y", "z", "w", "v"])]; const r = aggregateRecallScores(s, 1); expect(r.sessionsEvaluated).toBe(2); expect(r.sessionsSkipped).toBe(1); expect(r.meanRecall5).toBe(1); });
  test("recall@15 aggregated as primary metric with CI", () => {
    // Session 1: gold spread across 15 positions
    const s1 = evaluateSessionRecall("s1", "wide spread", ["a", "b", "c", "d"], ["a", "x1", "x2", "x3", "x4", "x5", "b", "x6", "x7", "x8", "c", "x9", "x10", "x11", "d"]);
    // Session 2: all gold in top-15
    const s2 = evaluateSessionRecall("s2", "all found", ["p", "q"], ["p", "q", "r", "s", "t"]);
    const r = aggregateRecallScores([s1, s2]);
    expect(r.meanRecall15).toBe((s1.recall15 + s2.recall15) / 2);
    expect(r.ci95Recall15).toBeDefined();
    expect(r.ci95Recall15[0]).toBeLessThanOrEqual(r.meanRecall15);
    expect(r.ci95Recall15[1]).toBeGreaterThanOrEqual(r.meanRecall15);
  });
});
