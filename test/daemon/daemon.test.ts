import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import type { AgentGritConfig, Pattern } from "../../src/adapters/types";

const TEST_DIR = "/tmp/agentgrit-daemon-test-" + process.pid;
const SIGNAL_DIR = join(TEST_DIR, "signals");
const STATE_DIR = join(TEST_DIR, "state");

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

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("daemon cycle", () => {
  test("runDaemonCycle returns result with all fields", async () => {
    const { runDaemonCycle } = await import("../../src/daemon/daemon");
    const config = makeConfig();
    const result = await runDaemonCycle(config);

    expect(result).toHaveProperty("timestamp");
    expect(result).toHaveProperty("scores");
    expect(result).toHaveProperty("patterns");
    expect(result).toHaveProperty("promoted");
    expect(result).toHaveProperty("pruned");
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

  test("autoPromote=false yields zero pruning", async () => {
    const { runDaemonCycle } = await import("../../src/daemon/daemon");
    const config = makeConfig({ rules: { globalBudget: 25, projectBudget: 25, autoPromote: false } });
    const result = await runDaemonCycle(config);

    expect(result.pruned).toBe(0);
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

describe("daemon promote step", () => {
  test("autoPromote=true with patterns triggers promoteRule", async () => {
    const { runDaemonCycle } = await import("../../src/daemon/daemon");
    const config = makeConfig({
      signalDir: SIGNAL_DIR,
      rules: { globalBudget: 25, projectBudget: 25, autoPromote: true },
    });

    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(SIGNAL_DIR, { recursive: true });
    mkdirSync(STATE_DIR, { recursive: true });

    const result = await runDaemonCycle(config);
    expect(result).toHaveProperty("promoted");
    expect(typeof result.promoted).toBe("number");
  });

  test("promote is capped at MAX_PROMOTIONS_PER_CYCLE", async () => {
    const { runDaemonCycle } = await import("../../src/daemon/daemon");
    const config = makeConfig({
      signalDir: SIGNAL_DIR,
      rules: { globalBudget: 250, projectBudget: 250, autoPromote: true },
    });

    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(SIGNAL_DIR, { recursive: true });
    mkdirSync(STATE_DIR, { recursive: true });

    const result = await runDaemonCycle(config);
    expect(result.promoted).toBeLessThanOrEqual(3);
  });
});

describe("daemon optimize step", () => {
  test("optimize flag reflects low score detection", async () => {
    const { runDaemonCycle } = await import("../../src/daemon/daemon");
    const config = makeConfig({ signalDir: SIGNAL_DIR });

    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(SIGNAL_DIR, { recursive: true });

    const result = await runDaemonCycle(config);
    expect(typeof result.optimized).toBe("boolean");
  });

  test("optimize stays false when no low scores", async () => {
    const { runDaemonCycle } = await import("../../src/daemon/daemon");
    const config = makeConfig({ signalDir: SIGNAL_DIR });

    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(SIGNAL_DIR, { recursive: true });

    const result = await runDaemonCycle(config);
    expect(result.optimized).toBe(false);
  });
});

describe("daemon cleanup step", () => {
  test("cleanup stats present in cycle result", async () => {
    const { runDaemonCycle } = await import("../../src/daemon/daemon");
    const config = makeConfig({ signalDir: SIGNAL_DIR });

    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(SIGNAL_DIR, { recursive: true });
    mkdirSync(STATE_DIR, { recursive: true });

    const result = await runDaemonCycle(config);
    expect(result).toHaveProperty("cleanup");
    expect(result.cleanup).toHaveProperty("staleFilesRemoved");
    expect(result.cleanup).toHaveProperty("sessionStatesCleared");
    expect(result.cleanup).toHaveProperty("signalsRotated");
    expect(result.cleanup).toHaveProperty("sessionsCompressed");
    expect(result.cleanup).toHaveProperty("counts");
  });

  test("cleanup calls rotateSignals on signal files", async () => {
    const { runDaemonCycle } = await import("../../src/daemon/daemon");
    const config = makeConfig({ signalDir: SIGNAL_DIR });

    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(SIGNAL_DIR, { recursive: true });
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(join(SIGNAL_DIR, "test.jsonl"), '{"x":1}\n');

    const result = await runDaemonCycle(config);
    expect(typeof result.cleanup.signalsRotated).toBe("number");
  });

  test("cleanup calls updateCounts", async () => {
    const { runDaemonCycle } = await import("../../src/daemon/daemon");
    const config = makeConfig({ signalDir: SIGNAL_DIR });

    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(SIGNAL_DIR, { recursive: true });
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(join(SIGNAL_DIR, "ratings.jsonl"), JSON.stringify({ session_id: "s1", timestamp: new Date().toISOString(), type: "rating", rating: 5 }) + "\n");

    process.env.AGENTGRIT_DIR = TEST_DIR;
    try {
      const result = await runDaemonCycle(config);
      expect(result.cleanup.counts).not.toBeNull();
      expect(result.cleanup.counts).toHaveProperty("signalFiles");
      expect(result.cleanup.counts).toHaveProperty("ruleFiles");
      expect(result.cleanup.counts).toHaveProperty("graphNodes");
    } finally {
      delete process.env.AGENTGRIT_DIR;
    }
  });
});

describe("daemon eviction review step", () => {
  test("cycle result includes evictionCandidatesCount", async () => {
    const { runDaemonCycle } = await import("../../src/daemon/daemon");
    const config = makeConfig({ signalDir: SIGNAL_DIR });

    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(SIGNAL_DIR, { recursive: true });
    mkdirSync(STATE_DIR, { recursive: true });

    const result = await runDaemonCycle(config);
    expect(typeof result.evictionCandidatesCount).toBe("number");
  });

  test("writes eviction-candidates.json to state dir", async () => {
    const { runDaemonCycle } = await import("../../src/daemon/daemon");
    const { persistRuleStats } = await import("../../src/promote/rules");
    const config = makeConfig({ signalDir: SIGNAL_DIR });

    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(SIGNAL_DIR, { recursive: true });
    mkdirSync(STATE_DIR, { recursive: true });

    process.env.AGENTGRIT_DIR = TEST_DIR;
    try {
      persistRuleStats([
        { ruleId: "low-corr", injectionCount: 15, avgCorrelatedRating: 2.5, sessionRatings: [2, 3], highRatingActivations: 0, lowRatingActivations: 10, lastSeen: "2026-01-01" },
        { ruleId: "high-corr", injectionCount: 20, avgCorrelatedRating: 8.0, sessionRatings: [8, 8], highRatingActivations: 15, lowRatingActivations: 0, lastSeen: "2026-01-01" },
      ]);

      const result = await runDaemonCycle(config);

      const evPath = join(STATE_DIR, "eviction-candidates.json");
      expect(existsSync(evPath)).toBe(true);

      const candidates = JSON.parse(readFileSync(evPath, "utf-8"));
      expect(candidates.some((c: { ruleId: string }) => c.ruleId === "low-corr")).toBe(true);
      expect(candidates.some((c: { ruleId: string }) => c.ruleId === "high-corr")).toBe(false);
    } finally {
      delete process.env.AGENTGRIT_DIR;
    }
  });

  test("anti-criterion: rules with <5 injections excluded from eviction", async () => {
    const { runDaemonCycle } = await import("../../src/daemon/daemon");
    const { persistRuleStats } = await import("../../src/promote/rules");
    const config = makeConfig({ signalDir: SIGNAL_DIR });

    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(SIGNAL_DIR, { recursive: true });
    mkdirSync(STATE_DIR, { recursive: true });

    process.env.AGENTGRIT_DIR = TEST_DIR;
    try {
      persistRuleStats([
        { ruleId: "too-few", injectionCount: 3, avgCorrelatedRating: 1.0, sessionRatings: [1], highRatingActivations: 0, lowRatingActivations: 3, lastSeen: "2026-01-01" },
        { ruleId: "borderline", injectionCount: 5, avgCorrelatedRating: 2.0, sessionRatings: [2, 2], highRatingActivations: 0, lowRatingActivations: 5, lastSeen: "2026-01-01" },
      ]);

      await runDaemonCycle(config);

      const evPath = join(STATE_DIR, "eviction-candidates.json");
      expect(existsSync(evPath)).toBe(true);

      const candidates = JSON.parse(readFileSync(evPath, "utf-8"));
      expect(candidates.some((c: { ruleId: string }) => c.ruleId === "too-few")).toBe(false);
      // borderline has 5 injections but needs >10 for eviction
      expect(candidates.some((c: { ruleId: string }) => c.ruleId === "borderline")).toBe(false);
    } finally {
      delete process.env.AGENTGRIT_DIR;
    }
  });
});

describe("doctor dedup", () => {
  test("doctorCommand uses src/daemon/doctor runDoctor", async () => {
    const srcDoctor = await import("../../src/daemon/doctor");
    expect(typeof srcDoctor.runDoctor).toBe("function");

    const cliDoctor = await import("../../bin/commands/doctor");
    expect(typeof cliDoctor.doctorCommand).toBe("function");
    expect(typeof cliDoctor.runDoctor).toBe("function");
  });

  test("src/daemon/doctor.runDoctor returns section-based report", async () => {
    const { runDoctor } = await import("../../src/daemon/doctor");
    const config = makeConfig({ signalDir: SIGNAL_DIR });

    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(SIGNAL_DIR, { recursive: true });

    const report = await runDoctor(config);
    expect(report).toHaveProperty("sections");
    expect(report).toHaveProperty("overall");
    expect(report.sections.length).toBe(7);
  });
});
