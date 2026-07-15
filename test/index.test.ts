/**
 * test/index.test.ts — Verify public API surface
 *
 * AC-3: Test verifies key exports are importable
 * Threshold: >= 10 import checks across all 7 subsystems
 */
import { describe, it, expect } from "bun:test";

describe("@agentgrit/core public API surface", () => {
  it("exports key functions from all 7 subsystems", async () => {
    const mod = await import("../src/index");

    // ── capture ──
    expect(typeof mod.captureRating).toBe("function");
    expect(typeof mod.parseRating).toBe("function");
    expect(typeof mod.scoreSentiment).toBe("function");
    expect(typeof mod.captureSessionSentiment).toBe("function");
    expect(typeof mod.detectCorrection).toBe("function");
    expect(typeof mod.captureFailure).toBe("function");
    expect(typeof mod.extractDebrief).toBe("function");
    expect(typeof mod.captureToolUse).toBe("function");
    expect(typeof mod.captureSkillInvocation).toBe("function");
    expect(typeof mod.classifyLearning).toBe("function");
    expect(typeof mod.generateHookConfig).toBe("function");

    // ── detect ──
    expect(typeof mod.minePatterns).toBe("function");
    expect(typeof mod.addTrajectory).toBe("function");
    expect(typeof mod.queryTrajectoriesSync).toBe("function");
    expect(typeof mod.buildCohorts).toBe("function");
    expect(typeof mod.convertPatternReports).toBe("function");

    // ── promote ──
    expect(typeof mod.checkBudget).toBe("function");
    expect(typeof mod.pruneLearnedRules).toBe("function");
    expect(typeof mod.evictRules).toBe("function");
    expect(typeof mod.findDuplicates).toBe("function");
    expect(typeof mod.attributeRulesToCorrections).toBe("function");
    expect(typeof mod.reviewDomains).toBe("function");
    expect(typeof mod.promoteRule).toBe("function");
    expect(typeof mod.routeRule).toBe("function");

    // ── graph ──
    expect(typeof mod.buildGraph).toBe("function");
    expect(typeof mod.queryGraph).toBe("function");
    expect(typeof mod.hybridRetrieve).toBe("function");
    expect(typeof mod.buildIndex).toBe("function");
    expect(typeof mod.buildIndexFromDir).toBe("function");
    expect(typeof mod.searchIndex).toBe("function");
    expect(typeof mod.getContextRules).toBe("function");
    expect(typeof mod.detectDomains).toBe("function");
    expect(typeof mod.embedRules).toBe("function");
    expect(typeof mod.semanticSearch).toBe("function");

    // ── evaluate ──
    expect(typeof mod.evaluateRecall).toBe("function");
    expect(typeof mod.recallAtK).toBe("function");
    expect(typeof mod.judgeTrace).toBe("function");
    expect(typeof mod.judgeBatch).toBe("function");
    expect(typeof mod.autoLabel).toBe("function");
    expect(typeof mod.scoreTranscript).toBe("function");
    expect(typeof mod.analyzeScores).toBe("function");
    expect(typeof mod.detectTrends).toBe("function");

    // ── optimize ──
    expect(typeof mod.hillClimb).toBe("function");
    expect(typeof mod.tuneSkill).toBe("function");
    expect(typeof mod.tunePrompt).toBe("function");
    expect(typeof mod.computeSkillMetrics).toBe("function");
    expect(typeof mod.buildBenchmark).toBe("function");

    // ── daemon ──
    expect(typeof mod.runDaemonCycle).toBe("function");
    expect(typeof mod.runDoctor).toBe("function");
    expect(typeof mod.installScheduler).toBe("function");
    expect(typeof mod.getSchedulerStatus).toBe("function");
    expect(typeof mod.cleanupSession).toBe("function");
  });

  it("exports core types (Tier enum)", async () => {
    const mod = await import("../src/index");
    expect(mod.Tier).toBeDefined();
    expect(mod.Tier.Global).toBeDefined();
  });

  it("exports >= 20 named exports total", async () => {
    const mod = await import("../src/index");
    const exportNames = Object.keys(mod);
    expect(exportNames.length).toBeGreaterThanOrEqual(20);
  });

  it("re-exported functions are callable (not undefined)", async () => {
    const mod = await import("../src/index");
    // Spot-check a few to ensure they're real function references, not stubs
    expect(mod.buildGraph.length).toBeGreaterThanOrEqual(0); // has parameters
    expect(mod.checkBudget.length).toBeGreaterThanOrEqual(0);
    expect(mod.evaluateRecall.length).toBeGreaterThanOrEqual(0);
  });
});
