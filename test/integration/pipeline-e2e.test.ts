import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import {
  trackRule,
  correlateRules,
  computeDifferentialLift,
  loadRuleStats,
  persistRuleStats,
} from "../../src/promote/rules";
import { shouldEvict } from "../../src/promote/auto-eviction";
import {
  transitionRule,
  getFilteredRuleIds,
  loadLifecycle,
  saveLifecycle,
} from "../../src/promote/lifecycle";
import { Tier } from "../../src/adapters/types";
import type { Rule } from "../../src/adapters/types";
import type { RuleStats } from "../../src/promote/rules";

const TMP_DIR = join(import.meta.dir, ".tmp-pipeline-e2e");
const STATE_DIR = join(TMP_DIR, "state");

function makeRule(id: string, text: string, overrides?: Partial<Rule>): Rule {
  return {
    id,
    text,
    tier: Tier.Graph,
    tags: [],
    created: new Date().toISOString(),
    correlationScore: 0.5,
    sourceSignals: [],
    schemaVersion: 1,
    ...overrides,
  };
}

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

describe("pipeline end-to-end", () => {
  test("rating → attribution: processRatingAttribution computes differentialLift with real variance", async () => {
    mkdirSync(STATE_DIR, { recursive: true });

    const { processRatingAttribution } = await import("../../src/capture/rating");

    await processRatingAttribution(9, ["rule-good-a", "rule-good-b"]);
    await processRatingAttribution(3, ["rule-bad-c"]);

    const statsMap = loadRuleStats(STATE_DIR);
    expect(statsMap.size).toBeGreaterThanOrEqual(3);

    const goodA = statsMap.get("rule-good-a");
    const badC = statsMap.get("rule-bad-c");
    expect(goodA).toBeDefined();
    expect(badC).toBeDefined();
    expect(goodA!.avgCorrelatedRating).toBeGreaterThan(badC!.avgCorrelatedRating);

    const allStats = correlateRules(
      ["rule-good-a", "rule-good-b", "rule-bad-c"].map((id) => {
        const s = statsMap.get(id)!;
        return makeRule(id, "", {
          injectionCount: s.injectionCount,
          avgCorrelatedRating: s.avgCorrelatedRating,
          sessionRatings: s.sessionRatings,
          highRatingActivations: s.highRatingActivations,
          lowRatingActivations: s.lowRatingActivations,
          lastSeen: s.lastSeen,
        });
      }),
      6.0,
    );

    const lifts = allStats.map((s) => s.differentialLift).filter((d) => d !== undefined);
    expect(lifts.length).toBe(3);
    const uniqueLifts = new Set(lifts);
    expect(uniqueLifts.size).toBeGreaterThan(1);
  });

  test("attribution → eviction: bad stats trigger shouldEvict with correct trigger", () => {
    const badStats: RuleStats = {
      ruleId: "feedback_worthless_rule",
      injectionCount: 160,
      avgCorrelatedRating: 2.8,
      sessionRatings: Array(20).fill(2.8),
      highRatingActivations: 0,
      lowRatingActivations: 160,
      lastSeen: new Date().toISOString(),
    };

    const result = shouldEvict(badStats);
    expect(result).not.toBeNull();
    expect(result!.trigger).toBe("high-injection-low-value");

    const goodStats: RuleStats = {
      ruleId: "feedback_good_rule",
      injectionCount: 100,
      avgCorrelatedRating: 8.5,
      sessionRatings: Array(20).fill(8.5),
      highRatingActivations: 100,
      lowRatingActivations: 0,
      lastSeen: new Date().toISOString(),
    };

    const goodResult = shouldEvict(goodStats);
    expect(goodResult).toBeNull();
  });

  test("eviction → lifecycle: transitionRule moves to evicted, getFilteredRuleIds returns it", () => {
    transitionRule(
      "feedback_evicted_rule",
      "evicted",
      "avg 2.8 < 4.0 with 160 injections",
      "auto-eviction-daemon",
      STATE_DIR,
    );

    const evictedIds = getFilteredRuleIds(["evicted"], STATE_DIR);
    expect(evictedIds.has("feedback_evicted_rule")).toBe(true);

    const lifecycle = loadLifecycle(STATE_DIR);
    const entry = lifecycle.rules["feedback_evicted_rule"];
    expect(entry).toBeDefined();
    expect(entry.state).toBe("evicted");
    expect(entry.addedBy).toBe("auto-eviction-daemon");

    const activeIds = getFilteredRuleIds(["active"], STATE_DIR);
    expect(activeIds.has("feedback_evicted_rule")).toBe(false);
  });

  test("full loop: multi-session tracking → eviction → lifecycle filtering", async () => {
    let ruleA = makeRule("rule-stellar", "Always verify before deploying");
    let ruleB = makeRule("rule-terrible", "Skip tests when in a hurry");

    for (let session = 0; session < 20; session++) {
      ruleA = trackRule(ruleA, 9);
      ruleB = trackRule(ruleB, 2);
    }

    expect(ruleA.injectionCount).toBe(20);
    expect(ruleB.injectionCount).toBe(20);
    expect(ruleA.avgCorrelatedRating).toBeGreaterThan(7);
    expect(ruleB.avgCorrelatedRating).toBeLessThan(4);

    const globalAvg = 6.0;
    const stats = correlateRules([ruleA, ruleB], globalAvg);
    persistRuleStats(stats, STATE_DIR);

    const liftA = stats.find((s) => s.ruleId === "rule-stellar")!.differentialLift!;
    const liftB = stats.find((s) => s.ruleId === "rule-terrible")!.differentialLift!;
    expect(liftA).toBeGreaterThan(0);
    expect(liftB).toBeLessThan(0);

    // Simulate continued poor performance to cross eviction thresholds
    for (let session = 20; session < 170; session++) {
      ruleB = trackRule(ruleB, 2);
    }

    const evictionCheck = shouldEvict({
      ruleId: ruleB.id,
      injectionCount: ruleB.injectionCount!,
      avgCorrelatedRating: ruleB.avgCorrelatedRating!,
      sessionRatings: ruleB.sessionRatings!,
      highRatingActivations: ruleB.highRatingActivations!,
      lowRatingActivations: ruleB.lowRatingActivations!,
      lastSeen: ruleB.lastSeen!,
    });
    expect(evictionCheck).not.toBeNull();
    expect(evictionCheck!.trigger).toBe("high-injection-low-value");

    transitionRule(
      ruleB.id,
      "evicted",
      evictionCheck!.reason,
      "pipeline-e2e-test",
      STATE_DIR,
    );

    const evictedIds = getFilteredRuleIds(["evicted"], STATE_DIR);
    expect(evictedIds.has("rule-terrible")).toBe(true);
    expect(evictedIds.has("rule-stellar")).toBe(false);

    const activeIds = getFilteredRuleIds(["active"], STATE_DIR);
    expect(activeIds.has("rule-terrible")).toBe(false);

    const persistedStats = loadRuleStats(STATE_DIR);
    expect(persistedStats.size).toBe(2);
  });
});
