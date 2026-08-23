import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { RuleStats } from "../../src/promote/rules";
import { shouldEvict, loadEvictionAllowlist } from "../../src/promote/auto-eviction";

const TMP_DIR = join(import.meta.dir, ".tmp-evict-dryrun");

function makeStats(overrides: Partial<RuleStats> = {}): RuleStats {
  return {
    ruleId: "test-rule",
    injectionCount: 100,
    avgCorrelatedRating: 5.0,
    sessionRatings: [5, 5, 5],
    highRatingActivations: 10,
    lowRatingActivations: 2,
    lastSeen: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

describe("dry-run eviction scan", () => {
  test("identifies frequency-cap candidates from a set of rules", () => {
    const rules: RuleStats[] = [
      makeStats({ ruleId: "always-on-no-help", injectionCount: 80, differentialLift: 0.0 }),
      makeStats({ ruleId: "always-on-helpful", injectionCount: 80, differentialLift: 0.6 }),
      makeStats({ ruleId: "rarely-used", injectionCount: 5, differentialLift: -0.3 }),
    ];
    const totalSessions = 100;

    const candidates = rules
      .map(s => ({ ruleId: s.ruleId, result: shouldEvict(s, undefined, totalSessions) }))
      .filter(c => c.result !== null);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].ruleId).toBe("always-on-no-help");
    expect(candidates[0].result!.trigger).toBe("frequency-cap");
  });

  test("identifies negative-lift candidates", () => {
    const rules: RuleStats[] = [
      makeStats({ ruleId: "bad-rule", injectionCount: 20, differentialLift: -0.8 }),
      makeStats({ ruleId: "ok-rule", injectionCount: 20, differentialLift: 0.1 }),
    ];

    const candidates = rules
      .map(s => ({ ruleId: s.ruleId, result: shouldEvict(s) }))
      .filter(c => c.result !== null);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].ruleId).toBe("bad-rule");
    expect(candidates[0].result!.trigger).toBe("negative-lift");
  });

  test("allowlisted rules are excluded from dry-run scan", () => {
    const allowlistPath = join(TMP_DIR, "eviction-allowlist.json");
    writeFileSync(allowlistPath, JSON.stringify(["protected-rule"]), "utf-8");

    const rules: RuleStats[] = [
      makeStats({ ruleId: "protected-rule", injectionCount: 30, differentialLift: -1.0 }),
      makeStats({ ruleId: "unprotected-rule", injectionCount: 30, differentialLift: -1.0 }),
    ];

    const allowlist = loadEvictionAllowlist(allowlistPath);
    const candidates = rules
      .map(s => ({ ruleId: s.ruleId, result: shouldEvict(s, allowlist) }))
      .filter(c => c.result !== null);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].ruleId).toBe("unprotected-rule");
  });
});
