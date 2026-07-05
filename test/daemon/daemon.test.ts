import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { AgentGritConfig } from "../../src/adapters/types";

function makeConfig(overrides?: Partial<AgentGritConfig>): AgentGritConfig {
  return {
    signalDir: "/tmp/agentgrit-test/signals",
    adapter: "local",
    rubrics: [],
    rules: { globalBudget: 25, projectBudget: 25, autoPromote: false },
    daemon: { interval: "30m", weeklyDay: "sunday" },
    ...overrides,
  };
}

describe("daemon cycle", () => {
  test("runDaemonCycle returns result with all fields", async () => {
    const { runDaemonCycle } = await import("../../src/daemon/daemon");
    const config = makeConfig();
    const result = await runDaemonCycle(config);

    expect(result).toHaveProperty("timestamp");
    expect(result).toHaveProperty("scores");
    expect(result).toHaveProperty("patterns");
    expect(result).toHaveProperty("promoted");
    expect(result).toHaveProperty("synced");
    expect(result).toHaveProperty("optimized");
    expect(result).toHaveProperty("feedbackGenerated");
    expect(result).toHaveProperty("successGenerated");
    expect(result).toHaveProperty("errors");
    expect(Array.isArray(result.scores)).toBe(true);
    expect(Array.isArray(result.patterns)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
  });

  test("cycle runs without judge when no API key", async () => {
    const { runDaemonCycle } = await import("../../src/daemon/daemon");
    const config = makeConfig({ judge: undefined });
    const result = await runDaemonCycle(config);

    expect(result.scores).toEqual([]);
  });

  test("cycle does not sync when adapter is local", async () => {
    const { runDaemonCycle } = await import("../../src/daemon/daemon");
    const config = makeConfig({ adapter: "local" });
    const result = await runDaemonCycle(config);

    expect(result.synced).toBe(false);
  });

  test("cycle handles missing signal directory gracefully", async () => {
    const { runDaemonCycle } = await import("../../src/daemon/daemon");
    const config = makeConfig({ signalDir: "/tmp/agentgrit-nonexistent-" + Date.now() });
    const result = await runDaemonCycle(config);

    expect(result.patterns).toEqual([]);
    expect(typeof result.timestamp).toBe("string");
  });

  test("autoPromote=false yields zero promotions", async () => {
    const { runDaemonCycle } = await import("../../src/daemon/daemon");
    const config = makeConfig({ rules: { globalBudget: 25, projectBudget: 25, autoPromote: false } });
    const result = await runDaemonCycle(config);

    expect(result.promoted).toBe(0);
  });

  test("timestamp is valid ISO string", async () => {
    const { runDaemonCycle } = await import("../../src/daemon/daemon");
    const config = makeConfig();
    const result = await runDaemonCycle(config);

    const parsed = new Date(result.timestamp);
    expect(parsed.getTime()).not.toBeNaN();
  });
});

describe("isWeeklyDay", () => {
  test("returns boolean", async () => {
    const { isWeeklyDay } = await import("../../src/daemon/daemon");
    const config = makeConfig();
    const result = isWeeklyDay(config);

    expect(typeof result).toBe("boolean");
  });

  test("returns false for invalid day name", async () => {
    const { isWeeklyDay } = await import("../../src/daemon/daemon");
    const config = makeConfig({ daemon: { interval: "30m", weeklyDay: "notaday" } });

    expect(isWeeklyDay(config)).toBe(false);
  });
});

describe("weekly review", () => {
  test("runWeeklyReview returns result with all fields", async () => {
    const { runWeeklyReview } = await import("../../src/daemon/daemon");
    const config = makeConfig();
    const result = await runWeeklyReview(config);

    expect(result).toHaveProperty("timestamp");
    expect(result).toHaveProperty("review");
    expect(result).toHaveProperty("graphRebuilt");
    expect(result).toHaveProperty("budgetStatus");
    expect(result).toHaveProperty("errors");
    expect(result.review).toHaveProperty("patternsFound");
    expect(result.review).toHaveProperty("candidatesProposed");
    expect(result.review).toHaveProperty("scoreTrend");
  });

  test("review handles missing signal directory", async () => {
    const { runWeeklyReview } = await import("../../src/daemon/daemon");
    const config = makeConfig({ signalDir: "/tmp/agentgrit-nonexistent-" + Date.now() });
    const result = await runWeeklyReview(config);

    expect(result.review.patternsFound).toBe(0);
    expect(typeof result.timestamp).toBe("string");
  });

  test("budgetStatus has global and project keys", async () => {
    const { runWeeklyReview } = await import("../../src/daemon/daemon");
    const config = makeConfig();
    const result = await runWeeklyReview(config);

    expect(result.budgetStatus).toHaveProperty("global");
    expect(result.budgetStatus).toHaveProperty("project");
  });
});
