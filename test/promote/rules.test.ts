import { describe, test, expect } from "bun:test";
import { trackRule, getEvictionCandidates, correlateRules, computeDecayedAverage, computeDifferentialLift, bootstrapDifferentialStats } from "../../src/promote/rules";
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

  test("computes decay-weighted average correlated rating", () => {
    let rule = makeRule("r1", { sessionRatings: [6, 8] });
    rule = trackRule(rule, 10);
    // Decay-weighted: newest ratings weigh more than older ones
    expect(rule.avgCorrelatedRating).toBeGreaterThan(8);
    expect(rule.avgCorrelatedRating).toBeLessThan(10);
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

describe("computeDecayedAverage", () => {
  test("returns 0 for empty ratings", () => {
    expect(computeDecayedAverage([])).toBe(0);
  });

  test("single rating returns the rating itself", () => {
    expect(computeDecayedAverage([7])).toBeCloseTo(7, 5);
  });

  test("equal ratings return that value regardless of decay", () => {
    expect(computeDecayedAverage([5, 5, 5, 5, 5])).toBeCloseTo(5, 5);
  });

  test("recent ratings weighted more heavily", () => {
    // [3, 3, 3, 3, 9] — the 9 is newest and should pull average above flat mean of 4.2
    const flatAvg = (3 + 3 + 3 + 3 + 9) / 5;
    const decayed = computeDecayedAverage([3, 3, 3, 3, 9]);
    expect(decayed).toBeGreaterThan(flatAvg);
  });

  test("old ratings weighted less heavily", () => {
    // [9, 3, 3, 3, 3] — the 9 is oldest and should pull average below flat mean of 4.2
    const flatAvg = (9 + 3 + 3 + 3 + 3) / 5;
    const decayed = computeDecayedAverage([9, 3, 3, 3, 3]);
    expect(decayed).toBeLessThan(flatAvg);
  });

  test("custom halfLife affects decay rate", () => {
    const ratings = [1, 1, 1, 1, 1, 1, 1, 1, 1, 10];
    const shortHalf = computeDecayedAverage(ratings, 3);
    const longHalf = computeDecayedAverage(ratings, 50);
    // Shorter halfLife = more weight on recent = higher (since 10 is newest)
    expect(shortHalf).toBeGreaterThan(longHalf);
  });

  test("very large halfLife approximates flat average", () => {
    const ratings = [2, 4, 6, 8, 10];
    const flatAvg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
    const decayed = computeDecayedAverage(ratings, 10000);
    expect(decayed).toBeCloseTo(flatAvg, 1);
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

  test("computes differentialLift when globalAvg is provided", () => {
    const rules = [
      makeRule("r1", {
        sessionRatings: [8, 9, 7],
        avgCorrelatedRating: 8.0,
      }),
      makeRule("r2", {
        sessionRatings: [3, 2, 4],
        avgCorrelatedRating: 3.0,
      }),
    ];
    const stats = correlateRules(rules, 5.0);
    expect(stats[0].differentialLift).toBeCloseTo(3.0, 1);
    expect(stats[1].differentialLift).toBeCloseTo(-2.0, 1);
  });

  test("differentialLift is undefined when globalAvg is not provided", () => {
    const rules = [makeRule("r1", { sessionRatings: [8, 9] })];
    const stats = correlateRules(rules);
    expect(stats[0].differentialLift).toBeUndefined();
  });
});

describe("computeDifferentialLift", () => {
  test("returns positive lift when rule avg exceeds global avg", () => {
    const lift = computeDifferentialLift([8, 9, 10], 5.0);
    expect(lift).toBeGreaterThan(0);
  });

  test("returns negative lift when rule avg is below global avg", () => {
    const lift = computeDifferentialLift([2, 3, 1], 5.0);
    expect(lift).toBeLessThan(0);
  });

  test("returns 0 when rule avg equals global avg", () => {
    const lift = computeDifferentialLift([5, 5, 5], 5.0);
    expect(lift).toBeCloseTo(0, 5);
  });

  test("returns 0 for empty ratings", () => {
    const lift = computeDifferentialLift([], 5.0);
    expect(lift).toBe(0);
  });

  test("rounds to 3 decimal places", () => {
    const lift = computeDifferentialLift([7], 5.0);
    const decimalPlaces = lift.toString().split(".")[1]?.length ?? 0;
    expect(decimalPlaces).toBeLessThanOrEqual(3);
  });
});

describe("bootstrapDifferentialStats", () => {
  const { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require("fs");
  const { join } = require("path");
  const tmpDir = join(process.env.HOME!, ".agentgrit", "test-bootstrap-" + Date.now());

  function setup(ruleStats: any[], ratings: any[]) {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "rule-stats.json"), JSON.stringify(ruleStats));
    writeFileSync(
      join(tmpDir, "ratings.jsonl"),
      ratings.map((r: any) => JSON.stringify(r)).join("\n") + "\n",
    );
  }

  function cleanup() {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  test("computes differentialLift for all rules", () => {
    const ruleStats = [
      { ruleId: "r1", sessionRatings: [8, 9, 7], injectionCount: 3, avgCorrelatedRating: 8, highRatingActivations: 3, lowRatingActivations: 0, lastSeen: "" },
      { ruleId: "r2", sessionRatings: [2, 3, 4], injectionCount: 3, avgCorrelatedRating: 3, highRatingActivations: 0, lowRatingActivations: 3, lastSeen: "" },
    ];
    const ratings = [
      { timestamp: "2026-01-01", rating: 5 },
      { timestamp: "2026-01-02", rating: 6 },
      { timestamp: "2026-01-03", rating: 4 },
    ];
    setup(ruleStats, ratings);
    const result = bootstrapDifferentialStats(
      join(tmpDir, "rule-stats.json"),
      join(tmpDir, "ratings.jsonl"),
      tmpDir,
    );
    expect(result.rulesProcessed).toBe(2);
    expect(result.globalAvg).toBeCloseTo(5.0, 1);

    const updated = JSON.parse(readFileSync(join(tmpDir, "rule-stats.json"), "utf-8"));
    expect(updated[0].differentialLift).toBeGreaterThan(0);
    expect(updated[1].differentialLift).toBeLessThan(0);
    cleanup();
  });

  test("returns early when files are missing", () => {
    const result = bootstrapDifferentialStats(
      "/nonexistent/rule-stats.json",
      "/nonexistent/ratings.jsonl",
    );
    expect(result.rulesProcessed).toBe(0);
    expect(result.globalAvg).toBe(0);
  });

  test("produces distinct lift values across rules with different ratings", () => {
    const ruleStats = Array.from({ length: 10 }, (_, i) => ({
      ruleId: `r${i}`,
      sessionRatings: [i + 1, i + 2],
      injectionCount: 2,
      avgCorrelatedRating: (i + 1 + i + 2) / 2,
      highRatingActivations: 0,
      lowRatingActivations: 0,
      lastSeen: "",
    }));
    const ratings = Array.from({ length: 20 }, (_, i) => ({
      timestamp: `2026-01-${String(i + 1).padStart(2, "0")}`,
      rating: (i % 10) + 1,
    }));
    setup(ruleStats, ratings);
    const result = bootstrapDifferentialStats(
      join(tmpDir, "rule-stats.json"),
      join(tmpDir, "ratings.jsonl"),
      tmpDir,
    );
    const updated = JSON.parse(readFileSync(join(tmpDir, "rule-stats.json"), "utf-8"));
    const uniqueLifts = new Set(updated.map((r: any) => r.differentialLift?.toFixed(3)));
    expect(uniqueLifts.size).toBeGreaterThanOrEqual(5);
    expect(result.rulesProcessed).toBe(10);
    cleanup();
  });
});
