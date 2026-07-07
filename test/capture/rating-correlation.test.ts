import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { captureRating } from "../../src/capture/rating";
import { loadRuleStats, ruleStatsPath } from "../../src/promote/rules";

const TMP_DIR = join(import.meta.dir, ".tmp-rating-correlation-test");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

describe("captureRating → rule stats feedback loop", () => {
  test("updates rule-stats.json when ruleIds provided", async () => {
    const signal = await captureRating("/rate M:8 S:8 Q:8", "test-session", {
      ruleIds: ["rule-abc", "rule-def"],
    });
    expect(signal).not.toBeNull();

    const stateDir = join(TMP_DIR, "state");
    const statsMap = loadRuleStats(stateDir);
    expect(statsMap.size).toBe(2);

    const abc = statsMap.get("rule-abc");
    expect(abc).toBeDefined();
    expect(abc!.injectionCount).toBe(1);
    expect(abc!.avgCorrelatedRating).toBeGreaterThan(0);

    const def = statsMap.get("rule-def");
    expect(def).toBeDefined();
    expect(def!.injectionCount).toBe(1);
  });

  test("accumulates stats across multiple ratings", async () => {
    await captureRating("/rate M:9 S:9 Q:9", "sess-1", {
      ruleIds: ["rule-x"],
    });
    await captureRating("/rate M:3 S:3 Q:3", "sess-2", {
      ruleIds: ["rule-x"],
    });

    const stateDir = join(TMP_DIR, "state");
    const statsMap = loadRuleStats(stateDir);
    const x = statsMap.get("rule-x");
    expect(x).toBeDefined();
    expect(x!.injectionCount).toBe(2);
    expect(x!.sessionRatings).toHaveLength(2);
    expect(x!.highRatingActivations).toBe(1);
    expect(x!.lowRatingActivations).toBe(1);
  });

  test("does not write stats when ruleIds is empty", async () => {
    await captureRating("/rate M:8 S:8 Q:8", "test-session", {
      ruleIds: [],
    });

    const stateDir = join(TMP_DIR, "state");
    expect(existsSync(ruleStatsPath(stateDir))).toBe(false);
  });

  test("does not write stats when no ruleIds option", async () => {
    await captureRating("/rate M:8 S:8 Q:8", "test-session");

    const stateDir = join(TMP_DIR, "state");
    expect(existsSync(ruleStatsPath(stateDir))).toBe(false);
  });
});
