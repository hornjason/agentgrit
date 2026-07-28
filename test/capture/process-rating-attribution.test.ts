import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const TMP_DIR = join(import.meta.dir, ".tmp-process-attribution-test");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

describe("processRatingAttribution", () => {
  test("calls updateEdgeWeightsFromRating when session context exists", async () => {
    // Set up session context so updateEdgeWeightsFromRating has something to work with
    const stateDir = join(TMP_DIR, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "session-context.json"),
      JSON.stringify({
        ruleIds: ["rule-a", "rule-b"],
        domains: ["test"],
        domain_source: "keyword",
        timestamp: new Date().toISOString(),
        ttl: 86400000,
        rulesInjectedCount: 2,
        rulesInjectedKB: 0.1,
        totalContextLines: 10,
      }),
      "utf-8",
    );

    // Set up a graph with co_occurred edges (graph lives in state dir)
    writeFileSync(
      join(stateDir, "knowledge-graph.json"),
      JSON.stringify({
        nodes: { "rule-a": { name: "rule-a" }, "rule-b": { name: "rule-b" } },
        edges: [
          { from: "rule-a", to: "rule-b", relationship: "co_occurred", strength: 1.0 },
        ],
      }),
      "utf-8",
    );

    const { processRatingAttribution } = await import("../../src/capture/rating");
    await processRatingAttribution(8, ["rule-a", "rule-b"]);

    // Verify edge weights were updated — high rating should increase strength
    const { readFileSync } = await import("fs");
    const graph = JSON.parse(readFileSync(join(stateDir, "knowledge-graph.json"), "utf-8"));
    const edge = graph.edges[0];
    expect(edge.strength).toBeGreaterThan(1.0);
  });

  test("preserves existing noisePenalty when updating stats", async () => {
    const stateDir = join(TMP_DIR, "state");
    mkdirSync(stateDir, { recursive: true });

    // Pre-seed rule stats with existing noisePenalty
    const { persistRuleStats } = await import("../../src/promote/rules");
    persistRuleStats([
      {
        ruleId: "rule-noisy",
        injectionCount: 5,
        avgCorrelatedRating: 6.0,
        sessionRatings: [6, 6, 6, 6, 6],
        highRatingActivations: 0,
        lowRatingActivations: 0,
        lastSeen: "2026-07-28T00:00:00Z",
        noisePenalty: 0.5,
      },
    ]);

    const { processRatingAttribution } = await import("../../src/capture/rating");
    await processRatingAttribution(7, ["rule-noisy"]);

    const { loadRuleStats } = await import("../../src/promote/rules");
    const statsMap = loadRuleStats(stateDir);
    const stat = statsMap.get("rule-noisy");
    expect(stat).toBeDefined();
    // noisePenalty should be preserved (>= 0.5), not reset to 0
    expect(stat!.noisePenalty).toBeGreaterThanOrEqual(0.5);
  });

  test("runs relevance scan when tool-audit data exists", async () => {
    const stateDir = join(TMP_DIR, "state");
    mkdirSync(stateDir, { recursive: true });

    const sessionTs = new Date().toISOString();

    // Write session context with file paths to trigger relevance check
    writeFileSync(
      join(stateDir, "session-context.json"),
      JSON.stringify({
        ruleIds: ["rule-irrelevant"],
        domains: ["scraping"],
        domain_source: "keyword",
        timestamp: sessionTs,
        ttl: 86400000,
        rulesInjectedCount: 1,
        rulesInjectedKB: 0.1,
        totalContextLines: 5,
        filePathsTouched: ["src/scraper/index.ts"],
      }),
      "utf-8",
    );

    // Write a graph node with description unrelated to session context
    writeFileSync(
      join(stateDir, "knowledge-graph.json"),
      JSON.stringify({
        nodes: {
          "rule-irrelevant": {
            name: "rule-irrelevant",
            description: "authentication login oauth token refresh completely unrelated topic",
          },
        },
        edges: [],
      }),
      "utf-8",
    );

    const { processRatingAttribution } = await import("../../src/capture/rating");
    await processRatingAttribution(5, ["rule-irrelevant"]);

    const { loadRuleStats } = await import("../../src/promote/rules");
    const statsMap = loadRuleStats(stateDir);
    const stat = statsMap.get("rule-irrelevant");
    expect(stat).toBeDefined();
    // Low relevance rule should get noise penalty
    expect(stat!.noisePenalty).toBeGreaterThan(0);
  });

  test("skips when ruleIds is empty", async () => {
    const { processRatingAttribution } = await import("../../src/capture/rating");
    // Should return without error and without writing anything
    await processRatingAttribution(8, []);

    const stateDir = join(TMP_DIR, "state");
    const { ruleStatsPath } = await import("../../src/promote/rules");
    expect(existsSync(ruleStatsPath(stateDir))).toBe(false);
  });
});
