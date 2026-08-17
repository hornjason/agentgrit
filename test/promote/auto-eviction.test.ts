import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { shouldEvict, loadEvictionAllowlist, type EvictionTrigger } from "../../src/promote/auto-eviction";
import type { RuleStats } from "../../src/promote/rules";

const TEMP_DIR = join(import.meta.dir, ".tmp-auto-eviction");

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
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true });
  mkdirSync(TEMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true });
});

describe("shouldEvict — trigger 1: low avg + high volume", () => {
  test("evicts rule with avg < 4.0 and injections 51-149", () => {
    const stats = makeStats({ avgCorrelatedRating: 3.0, injectionCount: 100 });
    const result = shouldEvict(stats);
    expect(result).not.toBeNull();
    expect(result!.trigger).toBe("low-avg-high-volume");
  });

  test("does not evict rule with avg >= 4.0", () => {
    const stats = makeStats({ avgCorrelatedRating: 4.0, injectionCount: 100 });
    const result = shouldEvict(stats);
    expect(result).toBeNull();
  });

  test("does not evict rule with injections <= 50", () => {
    const stats = makeStats({ avgCorrelatedRating: 3.0, injectionCount: 50 });
    const result = shouldEvict(stats);
    // might hit trigger 3 depending on high/low, but not trigger 1
    if (result) {
      expect(result.trigger).not.toBe("low-avg-high-volume");
    }
  });
});

describe("shouldEvict — trigger 2: never helped", () => {
  test("evicts rule with highRatingActivations === 0 and injections >= 5", () => {
    const stats = makeStats({
      highRatingActivations: 0,
      lowRatingActivations: 3,
      injectionCount: 10,
      avgCorrelatedRating: 5.0,
    });
    const result = shouldEvict(stats);
    expect(result).not.toBeNull();
    expect(result!.trigger).toBe("never-helped");
  });

  test("does not evict rule with highRatingActivations > 0", () => {
    const stats = makeStats({
      highRatingActivations: 1,
      lowRatingActivations: 0,
      injectionCount: 10,
      avgCorrelatedRating: 5.0,
    });
    const result = shouldEvict(stats);
    expect(result).toBeNull();
  });
});

describe("shouldEvict — trigger 3: net negative ROI", () => {
  test("evicts rule with low > high * 2 and injections >= 10", () => {
    const stats = makeStats({
      lowRatingActivations: 21,
      highRatingActivations: 10,
      injectionCount: 50,
      avgCorrelatedRating: 5.0,
    });
    const result = shouldEvict(stats);
    expect(result).not.toBeNull();
    expect(result!.trigger).toBe("net-negative-roi");
  });

  test("does not evict when low <= high * 2", () => {
    const stats = makeStats({
      lowRatingActivations: 9,
      highRatingActivations: 5,
      injectionCount: 50,
      avgCorrelatedRating: 5.0,
    });
    const result = shouldEvict(stats);
    expect(result).toBeNull();
  });

  test("does not evict when injections < 10", () => {
    const stats = makeStats({
      lowRatingActivations: 9,
      highRatingActivations: 3,
      injectionCount: 9,
      avgCorrelatedRating: 5.0,
    });
    const result = shouldEvict(stats);
    expect(result).toBeNull();
  });
});

describe("shouldEvict — safety threshold", () => {
  test("never evicts rules with injection_count < 5", () => {
    const stats = makeStats({
      injectionCount: 4,
      avgCorrelatedRating: 1.0,
      highRatingActivations: 0,
      lowRatingActivations: 4,
    });
    const result = shouldEvict(stats);
    expect(result).toBeNull();
  });

  test("never evicts rules with injection_count === 0", () => {
    const stats = makeStats({
      injectionCount: 0,
      avgCorrelatedRating: 0,
      highRatingActivations: 0,
      lowRatingActivations: 0,
    });
    const result = shouldEvict(stats);
    expect(result).toBeNull();
  });
});

describe("shouldEvict — allowlist", () => {
  test("does not evict rule on the allowlist", () => {
    const allowlistPath = join(TEMP_DIR, "eviction-allowlist.json");
    writeFileSync(allowlistPath, JSON.stringify(["bad-rule"]), "utf-8");

    const stats = makeStats({
      ruleId: "bad-rule",
      avgCorrelatedRating: 1.0,
      injectionCount: 200,
      highRatingActivations: 0,
      lowRatingActivations: 50,
    });

    const allowlist = loadEvictionAllowlist(allowlistPath);
    const result = shouldEvict(stats, allowlist);
    expect(result).toBeNull();
  });

  test("evicts rule not on the allowlist", () => {
    const allowlistPath = join(TEMP_DIR, "eviction-allowlist.json");
    writeFileSync(allowlistPath, JSON.stringify(["other-rule"]), "utf-8");

    const stats = makeStats({
      ruleId: "bad-rule",
      avgCorrelatedRating: 1.0,
      injectionCount: 200,
      highRatingActivations: 0,
      lowRatingActivations: 50,
    });

    const allowlist = loadEvictionAllowlist(allowlistPath);
    const result = shouldEvict(stats, allowlist);
    expect(result).not.toBeNull();
  });

  test("returns empty set when allowlist file does not exist", () => {
    const allowlist = loadEvictionAllowlist(join(TEMP_DIR, "nonexistent.json"));
    expect(allowlist.size).toBe(0);
  });
});

describe("shouldEvict — trigger priority", () => {
  test("trigger 1 takes priority over trigger 3 when injections 51-149", () => {
    const stats = makeStats({
      avgCorrelatedRating: 2.0,
      injectionCount: 100,
      lowRatingActivations: 40,
      highRatingActivations: 10,
    });
    const result = shouldEvict(stats);
    expect(result).not.toBeNull();
    expect(result!.trigger).toBe("low-avg-high-volume");
  });

  test("trigger 4 takes priority over trigger 1 when injections >= 150", () => {
    const stats = makeStats({
      avgCorrelatedRating: 2.0,
      injectionCount: 200,
      lowRatingActivations: 40,
      highRatingActivations: 10,
    });
    const result = shouldEvict(stats);
    expect(result).not.toBeNull();
    expect(result!.trigger).toBe("high-injection-low-value");
  });
});

describe("shouldEvict — trigger 4: high-injection-low-value", () => {
  test("evicts rule with injections >= 150 and avg < 4.0", () => {
    const stats = makeStats({
      avgCorrelatedRating: 2.8,
      injectionCount: 200,
      highRatingActivations: 50,
      lowRatingActivations: 10,
    });
    const result = shouldEvict(stats);
    expect(result).not.toBeNull();
    expect(result!.trigger).toBe("high-injection-low-value");
  });

  test("fires at exact threshold boundary (150 injections, 3.9 avg)", () => {
    const stats = makeStats({
      avgCorrelatedRating: 3.9,
      injectionCount: 150,
      highRatingActivations: 50,
      lowRatingActivations: 10,
    });
    const result = shouldEvict(stats);
    expect(result).not.toBeNull();
    expect(result!.trigger).toBe("high-injection-low-value");
  });

  test("does not fire when avg >= 4.0 even with 200 injections", () => {
    const stats = makeStats({
      avgCorrelatedRating: 4.0,
      injectionCount: 200,
      highRatingActivations: 50,
      lowRatingActivations: 10,
    });
    const result = shouldEvict(stats);
    expect(result).toBeNull();
  });

  test("does not fire when injections < 150 and avg >= 4.0", () => {
    const stats = makeStats({
      avgCorrelatedRating: 4.5,
      injectionCount: 149,
      highRatingActivations: 50,
      lowRatingActivations: 10,
    });
    const result = shouldEvict(stats);
    expect(result).toBeNull();
  });
});

describe("shouldEvict — edge cases from garbage test", () => {
  test("AC-2: rule with 4 injections not evicted (below threshold)", () => {
    const stats = makeStats({
      injectionCount: 4,
      avgCorrelatedRating: 1.0,
      highRatingActivations: 0,
      lowRatingActivations: 4,
    });
    expect(shouldEvict(stats)).toBeNull();
  });

  test("AC-3: rule with high=5, low=9 not evicted (9 < 5*2=10)", () => {
    const stats = makeStats({
      highRatingActivations: 5,
      lowRatingActivations: 9,
      injectionCount: 20,
      avgCorrelatedRating: 5.0,
    });
    expect(shouldEvict(stats)).toBeNull();
  });
});
