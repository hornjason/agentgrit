import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

const TEMP_DIR = join(import.meta.dir, ".tmp-classify-active");

beforeEach(() => {
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true });
  mkdirSync(TEMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true });
});

describe("classifyActiveRules", () => {
  test("marks rules with >=10 injections as active", async () => {
    const { classifyActiveRules, loadLifecycle } = await import("../../src/promote/lifecycle");

    const stats = [
      { ruleId: "high-injection-rule", injectionCount: 25, avgCorrelatedRating: 7.0, sessionRatings: [], highRatingActivations: 10, lowRatingActivations: 0, lastSeen: "2026-08-19T00:00:00Z" },
      { ruleId: "another-active-rule", injectionCount: 15, avgCorrelatedRating: 6.0, sessionRatings: [], highRatingActivations: 5, lowRatingActivations: 2, lastSeen: "2026-08-19T00:00:00Z" },
    ];
    writeFileSync(join(TEMP_DIR, "rule-stats.json"), JSON.stringify(stats), "utf-8");

    const classified = classifyActiveRules(TEMP_DIR);
    expect(classified).toContain("high-injection-rule");
    expect(classified).toContain("another-active-rule");

    const lifecycle = loadLifecycle(TEMP_DIR);
    expect(lifecycle.rules["high-injection-rule"].state).toBe("active");
    expect(lifecycle.rules["another-active-rule"].state).toBe("active");
    expect(lifecycle.rules["high-injection-rule"].addedBy).toBe("active-classifier");
  });

  test("skips rules with <10 injections", async () => {
    const { classifyActiveRules } = await import("../../src/promote/lifecycle");

    const stats = [
      { ruleId: "low-rule", injectionCount: 5, avgCorrelatedRating: 5.0, sessionRatings: [], highRatingActivations: 1, lowRatingActivations: 0, lastSeen: "2026-08-19T00:00:00Z" },
    ];
    writeFileSync(join(TEMP_DIR, "rule-stats.json"), JSON.stringify(stats), "utf-8");

    const classified = classifyActiveRules(TEMP_DIR);
    expect(classified).not.toContain("low-rule");
  });

  test("skips rules already graduated, evicted, or active", async () => {
    const { classifyActiveRules, transitionRule, loadLifecycle } = await import("../../src/promote/lifecycle");

    const stats = [
      { ruleId: "already-graduated", injectionCount: 20, avgCorrelatedRating: 8.0, sessionRatings: [], highRatingActivations: 10, lowRatingActivations: 0, lastSeen: "2026-08-19T00:00:00Z" },
      { ruleId: "already-evicted", injectionCount: 15, avgCorrelatedRating: 3.0, sessionRatings: [], highRatingActivations: 1, lowRatingActivations: 8, lastSeen: "2026-08-19T00:00:00Z" },
      { ruleId: "already-active", injectionCount: 12, avgCorrelatedRating: 6.5, sessionRatings: [], highRatingActivations: 5, lowRatingActivations: 1, lastSeen: "2026-08-19T00:00:00Z" },
    ];
    writeFileSync(join(TEMP_DIR, "rule-stats.json"), JSON.stringify(stats), "utf-8");
    transitionRule("already-graduated", "graduated", "promoted", "manual", TEMP_DIR);
    transitionRule("already-evicted", "evicted", "low correlation", "daemon", TEMP_DIR);
    transitionRule("already-active", "active", "previously classified", "active-classifier", TEMP_DIR);

    const classified = classifyActiveRules(TEMP_DIR);
    expect(classified).toHaveLength(0);

    const lifecycle = loadLifecycle(TEMP_DIR);
    expect(lifecycle.rules["already-graduated"].state).toBe("graduated");
    expect(lifecycle.rules["already-evicted"].state).toBe("evicted");
    expect(lifecycle.rules["already-active"].state).toBe("active");
  });

  test("is idempotent — does not re-classify already active rules", async () => {
    const { classifyActiveRules, loadLifecycle } = await import("../../src/promote/lifecycle");

    const stats = [
      { ruleId: "rule-x", injectionCount: 20, avgCorrelatedRating: 7.0, sessionRatings: [], highRatingActivations: 8, lowRatingActivations: 1, lastSeen: "2026-08-19T00:00:00Z" },
    ];
    writeFileSync(join(TEMP_DIR, "rule-stats.json"), JSON.stringify(stats), "utf-8");

    const first = classifyActiveRules(TEMP_DIR);
    expect(first).toContain("rule-x");

    const second = classifyActiveRules(TEMP_DIR);
    expect(second).toHaveLength(0);
  });
});

describe("migrateFromEvictedRegistry includes active classification", () => {
  test("classifies active rules during migration", async () => {
    const { migrateFromEvictedRegistry, loadLifecycle } = await import("../../src/promote/lifecycle");

    const stats = [
      { ruleId: "active-rule", injectionCount: 30, avgCorrelatedRating: 7.5, sessionRatings: [], highRatingActivations: 15, lowRatingActivations: 1, lastSeen: "2026-08-19T00:00:00Z" },
      { ruleId: "low-rule", injectionCount: 3, avgCorrelatedRating: 5.0, sessionRatings: [], highRatingActivations: 1, lowRatingActivations: 0, lastSeen: "2026-08-19T00:00:00Z" },
    ];
    writeFileSync(join(TEMP_DIR, "rule-stats.json"), JSON.stringify(stats), "utf-8");
    writeFileSync(join(TEMP_DIR, "evicted-rules.json"), JSON.stringify({ evicted: [] }), "utf-8");

    migrateFromEvictedRegistry(TEMP_DIR);
    const lifecycle = loadLifecycle(TEMP_DIR);

    expect(lifecycle.rules["active-rule"]?.state).toBe("active");
    expect(lifecycle.rules["low-rule"]?.state).toBe("undersampled");
  });
});
