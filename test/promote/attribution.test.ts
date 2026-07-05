import { describe, test, expect } from "bun:test";
import { trackAttributedRules } from "../../src/promote/rules";
import { Tier, SCHEMA_VERSION, type Rule } from "../../src/adapters/types";

function makeRule(id: string, overrides: Partial<Rule> = {}): Rule {
  return {
    id,
    text: `Rule ${id} text`,
    tier: Tier.Global,
    tags: [],
    created: "2024-01-01T00:00:00Z",
    correlationScore: 0,
    sourceSignals: [],
    schemaVersion: SCHEMA_VERSION,
    ...overrides,
  };
}

describe("trackAttributedRules", () => {
  test("only tracks rules whose IDs are in the attribution set", () => {
    const rules = [
      makeRule("r1", { injectionCount: 0 }),
      makeRule("r2", { injectionCount: 0 }),
      makeRule("r3", { injectionCount: 0 }),
    ];
    const updated = trackAttributedRules(rules, ["r1", "r3"], 8);
    expect(updated[0].injectionCount).toBe(1);
    expect(updated[0].sessionRatings).toContain(8);
    expect(updated[1].injectionCount).toBe(0);
    expect(updated[1].sessionRatings).toBeUndefined();
    expect(updated[2].injectionCount).toBe(1);
    expect(updated[2].sessionRatings).toContain(8);
  });

  test("returns all rules unchanged when attribution set is empty", () => {
    const rules = [
      makeRule("r1", { injectionCount: 5 }),
      makeRule("r2", { injectionCount: 3 }),
    ];
    const updated = trackAttributedRules(rules, [], 8);
    expect(updated[0].injectionCount).toBe(5);
    expect(updated[1].injectionCount).toBe(3);
  });

  test("handles attribution IDs not present in rules", () => {
    const rules = [makeRule("r1", { injectionCount: 0 })];
    const updated = trackAttributedRules(rules, ["r1", "nonexistent"], 7);
    expect(updated).toHaveLength(1);
    expect(updated[0].injectionCount).toBe(1);
  });

  test("tracks high/low rating activations correctly", () => {
    const rules = [makeRule("r1", { highRatingActivations: 0, lowRatingActivations: 0 })];
    const highRated = trackAttributedRules(rules, ["r1"], 9);
    expect(highRated[0].highRatingActivations).toBe(1);
    expect(highRated[0].lowRatingActivations).toBe(0);
    const lowRated = trackAttributedRules(rules, ["r1"], 3);
    expect(lowRated[0].lowRatingActivations).toBe(1);
  });

  test("computes avgCorrelatedRating for attributed rules only", () => {
    const rules = [
      makeRule("r1", { sessionRatings: [6, 8] }),
      makeRule("r2", { sessionRatings: [4, 6] }),
    ];
    const updated = trackAttributedRules(rules, ["r1"], 10);
    expect(updated[0].avgCorrelatedRating).toBe(8);
    expect(updated[1].avgCorrelatedRating).toBeUndefined();
  });
});
