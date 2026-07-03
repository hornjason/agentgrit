import { describe, expect, test } from "bun:test";
import { evaluateRecall } from "../../src/evaluate/recall";
import type { Rule } from "../../src/adapters/types";
import { Tier } from "../../src/adapters/types";

function makeRule(id: string, tags: string[]): Rule {
  return {
    id, text: `Rule: ${id}`, tier: Tier.Graph, tags,
    created: new Date().toISOString(), correlationScore: 0.5,
    sourceSignals: [], schemaVersion: 1,
  };
}

describe("evaluateRecall", () => {
  test("perfect rule recall", () => {
    const rules = [
      makeRule("r1", ["testing"]), makeRule("r2", ["testing"]), makeRule("r3", ["deployment"]),
    ];
    const result = evaluateRecall(["testing"], rules, [], []);
    expect(result.ruleRecall).toBe(1);
    expect(result.ruleHits).toEqual(["r1", "r2"]);
    expect(result.ruleMisses).toHaveLength(0);
    expect(result.totalExpectedRules).toBe(2);
  });

  test("partial rule recall with availableRules", () => {
    const allRules = [makeRule("r1", ["testing"]), makeRule("r2", ["testing"])];
    const injected = [makeRule("r1", ["testing"])];
    const result = evaluateRecall(["testing"], injected, [], [], allRules);
    expect(result.ruleRecall).toBe(0.5);
    expect(result.ruleHits).toEqual(["r1"]);
    expect(result.ruleMisses).toEqual(["r2"]);
  });

  test("zero rule recall when none match", () => {
    const rules = [makeRule("r1", ["testing"])];
    const result = evaluateRecall(["deployment"], rules, [], []);
    expect(result.ruleRecall).toBe(1);
    expect(result.totalExpectedRules).toBe(0);
  });

  test("perfect skill recall", () => {
    const result = evaluateRecall(["testing"], [], ["ship", "verify", "tdd"], ["ship", "verify"]);
    expect(result.skillRecall).toBe(1);
    expect(result.skillHits).toEqual(["ship", "verify"]);
    expect(result.skillMisses).toHaveLength(0);
  });

  test("partial skill recall", () => {
    const result = evaluateRecall(["testing"], [], ["ship"], ["ship", "verify", "tdd"]);
    expect(result.skillRecall).toBeCloseTo(0.333, 2);
    expect(result.skillHits).toEqual(["ship"]);
    expect(result.skillMisses).toEqual(["verify", "tdd"]);
  });

  test("no expected skills returns recall 1", () => {
    const result = evaluateRecall(["testing"], [], ["ship"], []);
    expect(result.skillRecall).toBe(1);
  });

  test("combined rule and skill evaluation", () => {
    const rules = [makeRule("r1", ["testing"]), makeRule("r2", ["testing"])];
    const result = evaluateRecall(["testing"], rules, ["ship", "verify"], ["ship", "verify", "tdd"]);
    expect(result.ruleRecall).toBe(1);
    expect(result.skillRecall).toBeCloseTo(0.667, 2);
    expect(result.totalInjectedRules).toBe(2);
    expect(result.totalInvokedSkills).toBe(2);
    expect(result.totalExpectedSkills).toBe(3);
  });
});
