import { describe, test, expect } from "bun:test";
import { trackRule, getEvictionCandidates, correlateRules } from "../../src/promote/rules";
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

describe("trackRule", () => {
  test("increments injection count", () => {
    const rule = makeRule("r1", { injectionCount: 3 });
    const updated = trackRule(rule, 8);
    expect(updated.injectionCount).toBe(4);
  });

  test("records session rating", () => {
    const rule = makeRule("r1");
    const updated = trackRule(rule, 7);
    expect(updated.sessionRatings).toContain(7);
  });

  test("computes average correlated rating", () => {
    let rule = makeRule("r1", { sessionRatings: [6, 8] });
    rule = trackRule(rule, 10);
    expect(rule.avgCorrelatedRating).toBe(8);
  });

  test("caps session ratings at 20", () => {
    const ratings = Array.from({ length: 25 }, (_, i) => i + 1);
    const rule = makeRule("r1", { sessionRatings: ratings });
    const updated = trackRule(rule, 5);
    expect(updated.sessionRatings!.length).toBe(20);
  });

  test("tracks high rating activations", () => {
    const rule = makeRule("r1", { highRatingActivations: 2 });
    const updated = trackRule(rule, 9);
    expect(updated.highRatingActivations).toBe(3);
  });

  test("tracks low rating activations", () => {
    const rule = makeRule("r1", { lowRatingActivations: 1 });
    const updated = trackRule(rule, 3);
    expect(updated.lowRatingActivations).toBe(2);
  });

  test("mid-range rating does not increment high or low", () => {
    const rule = makeRule("r1", {
      highRatingActivations: 1,
      lowRatingActivations: 1,
    });
    const updated = trackRule(rule, 5);
    expect(updated.highRatingActivations).toBe(1);
    expect(updated.lowRatingActivations).toBe(1);
  });

  test("sets lastSeen to current timestamp", () => {
    const rule = makeRule("r1");
    const updated = trackRule(rule, 5);
    expect(updated.lastSeen).toBeDefined();
    expect(new Date(updated.lastSeen!).getTime()).toBeGreaterThan(0);
  });
});

describe("getEvictionCandidates", () => {
  test("returns rules sorted by lowest avg rating", () => {
    const rules = [
      makeRule("r1", { injectionCount: 10, avgCorrelatedRating: 6.0 }),
      makeRule("r2", { injectionCount: 10, avgCorrelatedRating: 3.0 }),
      makeRule("r3", { injectionCount: 10, avgCorrelatedRating: 8.0 }),
    ];
    const candidates = getEvictionCandidates(rules);
    expect(candidates[0].id).toBe("r2");
    expect(candidates[1].id).toBe("r1");
  });

  test("filters out rules with low injection count", () => {
    const rules = [
      makeRule("r1", { injectionCount: 2, avgCorrelatedRating: 1.0 }),
      makeRule("r2", { injectionCount: 10, avgCorrelatedRating: 5.0 }),
    ];
    const candidates = getEvictionCandidates(rules);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe("r2");
  });

  test("respects topN parameter", () => {
    const rules = Array.from({ length: 10 }, (_, i) =>
      makeRule(`r${i}`, { injectionCount: 10, avgCorrelatedRating: i }),
    );
    const candidates = getEvictionCandidates(rules, 3);
    expect(candidates).toHaveLength(3);
  });

  test("returns empty array when no rules qualify", () => {
    const rules = [
      makeRule("r1", { injectionCount: 1, avgCorrelatedRating: 2.0 }),
    ];
    expect(getEvictionCandidates(rules)).toEqual([]);
  });

  test("stale rules (lastSeen > 60 days) get priority eviction", () => {
    const recent = new Date().toISOString();
    const stale = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const rules = [
      makeRule("fresh", { injectionCount: 10, avgCorrelatedRating: 3.0, lastSeen: recent }),
      makeRule("stale", { injectionCount: 10, avgCorrelatedRating: 7.0, lastSeen: stale }),
    ];
    const candidates = getEvictionCandidates(rules);
    expect(candidates[0].id).toBe("stale");
  });
});

describe("correlateRules", () => {
  test("extracts stats from rules", () => {
    const rules = [
      makeRule("r1", {
        injectionCount: 5,
        avgCorrelatedRating: 7.5,
        sessionRatings: [7, 8],
        highRatingActivations: 2,
        lowRatingActivations: 0,
        lastSeen: "2024-06-01",
      }),
    ];
    const stats = correlateRules(rules);
    expect(stats).toHaveLength(1);
    expect(stats[0].ruleId).toBe("r1");
    expect(stats[0].injectionCount).toBe(5);
    expect(stats[0].avgCorrelatedRating).toBe(7.5);
  });

  test("handles missing optional fields", () => {
    const rules = [makeRule("r1")];
    const stats = correlateRules(rules);
    expect(stats[0].injectionCount).toBe(0);
    expect(stats[0].sessionRatings).toEqual([]);
  });
});
