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
});

describe("aggregateRecallScores", () => {
  test("aggregates with CI", () => { const s = [evaluateSessionRecall("s1", "t1", ["a", "b"], ["a", "b", "c", "d", "e"]), evaluateSessionRecall("s2", "t2", ["x"], ["x", "y", "z", "w", "v"])]; const r = aggregateRecallScores(s, 1); expect(r.sessionsEvaluated).toBe(2); expect(r.sessionsSkipped).toBe(1); expect(r.meanRecall5).toBe(1); });
});
