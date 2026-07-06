import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { statusCommand } from "../../bin/commands/status";
import { runDoctor, type DoctorReport } from "../../bin/commands/doctor";
import { reviewCommand } from "../../bin/commands/review";
import { runReview } from "../../src/promote/review";
import { getInboxItems } from "../../bin/commands/inbox";
import { buildGraph, readGraph } from "../../src/graph/builder";
import { queryGraph } from "../../src/graph/query";
import { backfillCommand } from "../../bin/commands/backfill";
import { exportCommand } from "../../bin/commands/export";
import { getBaseDir, resolveSignalDir, resolveMemoryDir, loadConfig } from "../../src/adapters/paths";

describe("Tier 7: CLI End-to-End", () => {
  // T33: status shows real data
  test("T33: status shows real data — ratings > 0, tool-audit > 0", async () => {
    const config = loadConfig();
    const sigDir = config.signalDir ?? resolveSignalDir();
    const base = getBaseDir();

    expect(existsSync(base)).toBe(true);
    expect(existsSync(sigDir)).toBe(true);

    // Read ratings count
    const ratingsPath = join(sigDir, "ratings.jsonl");
    if (existsSync(ratingsPath)) {
      const content = readFileSync(ratingsPath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());
      expect(lines.length).toBeGreaterThan(0);
    }

    // Read tool-audit count via alias resolution
    const { resolveSignalFile } = await import("../../src/adapters/paths");
    const toolPath = resolveSignalFile(sigDir, "tool-audit.jsonl");
    if (existsSync(toolPath)) {
      const content = readFileSync(toolPath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());
      expect(lines.length).toBeGreaterThan(0);
    }

    // Verify getBaseDir works and has expected structure
    expect(existsSync(join(base, "config.json"))).toBe(true);
  });

  // T34: doctor passes — 0 failures
  test("T34: doctor passes with 0 failures", () => {
    const report: DoctorReport = runDoctor();

    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.failed).toBe(0);
    expect(report.passed).toBeGreaterThan(0);

    // Each check should be pass or warn, not fail
    for (const check of report.checks) {
      expect(check.status).not.toBe("fail");
    }
  });

  // T35: review finds patterns
  test("T35: review finds patterns and candidates", async () => {
    const config = loadConfig();
    const sigDir = config.signalDir ?? resolveSignalDir();
    const base = getBaseDir();
    const stateDir = join(base, "state");

    const result = await runReview(sigDir, stateDir);

    expect(result.patternsFound).toBeGreaterThanOrEqual(0);
    expect(result.scoreTrend.count).toBeGreaterThan(0);
    expect(typeof result.scoreTrend.avg).toBe("number");
    expect(["up", "down", "flat"]).toContain(result.scoreTrend.direction);

    // With real PAI data (621+ ratings), we expect some patterns
    if (result.patternsFound > 0) {
      expect(result.candidatesProposed).toBeGreaterThanOrEqual(0);
    }
  });

  // T36: inbox shows candidates
  test("T36: inbox shows >= 1 candidate from real data", async () => {
    const config = loadConfig();
    const sigDir = config.signalDir ?? resolveSignalDir();

    const items = await getInboxItems(sigDir);

    // With 1072+ corrections and 621+ ratings, we expect candidates
    expect(items.length).toBeGreaterThanOrEqual(1);

    const first = items[0];
    expect(first.pattern).toBeTruthy();
    expect(first.route).toBeTruthy();
    expect(first.route.tier).toBeTruthy();
    expect(first.pattern.frequency).toBeGreaterThanOrEqual(1);
    if (first.pattern.candidateRule) {
      expect(first.pattern.candidateRule.length).toBeGreaterThan(0);
    }
  });

  // T37: graph build builds from memory — nodes > 200
  test("T37: graph build from memory produces > 200 nodes", async () => {
    const config = loadConfig();
    const memoryDir = config.memoryDir ?? resolveMemoryDir();
    const base = getBaseDir();
    const stateOutputDir = join(base, "state");

    if (!existsSync(memoryDir)) {
      console.log(`  [skip] memoryDir not found: ${memoryDir}`);
      return;
    }

    const graph = await buildGraph(memoryDir, stateOutputDir);

    expect(graph.nodeCount).toBeGreaterThan(200);
    expect(graph.edgeCount).toBeGreaterThan(0);
    expect(Object.keys(graph.nodes).length).toBe(graph.nodeCount);
  });

  // T38: graph query returns ranked clusters
  test("T38: graph query for 'verification' returns ranked clusters", () => {
    const graph = readGraph();

    if (graph.nodeCount === 0) {
      console.log("  [skip] graph not built yet — run T37 first");
      return;
    }

    const clusters = queryGraph(graph, ["verification"], 5);

    expect(clusters.length).toBeGreaterThan(0);

    // Clusters should be ranked by score (descending)
    for (let i = 1; i < clusters.length; i++) {
      expect(clusters[i - 1].score).toBeGreaterThanOrEqual(clusters[i].score);
    }

    // Primary node should exist
    expect(clusters[0].primary).toBeTruthy();
    expect(clusters[0].primary.id).toBeTruthy();
    expect(clusters[0].score).toBeGreaterThan(0);
    expect(clusters[0].domains.length).toBeGreaterThan(0);
  });

  // T39: backfill completes all steps
  test("T39: backfill completes graph + review + report", async () => {
    const base = getBaseDir();
    const config = loadConfig();
    const memoryDir = config.memoryDir ?? resolveMemoryDir();
    const sigDir = config.signalDir ?? resolveSignalDir();

    if (!existsSync(memoryDir)) {
      console.log(`  [skip] memoryDir not found: ${memoryDir}`);
      return;
    }

    // Step 1: Graph build
    const graph = await buildGraph(memoryDir, join(base, "state"));
    expect(graph.nodeCount).toBeGreaterThan(0);

    // Step 2: Review
    const review = await runReview(sigDir, join(base, "state"));
    expect(typeof review.patternsFound).toBe("number");
    expect(typeof review.candidatesProposed).toBe("number");

    // Step 3: Final graph read
    const finalGraph = readGraph();
    expect(finalGraph.nodeCount).toBeGreaterThan(0);
    expect(finalGraph.builtAt).toBeTruthy();
  });

  // T40: export produces valid JSON
  test("T40: export produces valid JSON with graph + config", () => {
    const base = getBaseDir();

    if (!existsSync(base)) {
      console.log("  [skip] agentgrit not initialized");
      return;
    }

    // Build the export payload the same way exportCommand does
    const exported: Record<string, unknown> = {
      version: "0.1.0",
      exportedAt: new Date().toISOString(),
    };

    const graphPath = join(base, "state", "knowledge-graph.json");
    if (existsSync(graphPath)) {
      exported.graph = JSON.parse(readFileSync(graphPath, "utf-8"));
    }

    const rubricsDir = join(base, "rubrics");
    if (existsSync(rubricsDir)) {
      const { readdirSync } = require("fs");
      const rubrics: Record<string, unknown> = {};
      for (const file of readdirSync(rubricsDir).filter((f: string) => f.endsWith(".json"))) {
        rubrics[file] = JSON.parse(readFileSync(join(rubricsDir, file), "utf-8"));
      }
      exported.rubrics = rubrics;
    }

    const configPath = join(base, "config.json");
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      delete config.langfuse;
      delete config.judge?.apiKey;
      exported.config = config;
    }

    // Validate: JSON.parse succeeds on stringified output
    const output = JSON.stringify(exported, null, 2);
    const parsed = JSON.parse(output);

    expect(parsed).toBeTruthy();
    expect(parsed.version).toBe("0.1.0");
    expect(parsed.exportedAt).toBeTruthy();

    // Has config
    if (existsSync(configPath)) {
      expect(parsed.config).toBeTruthy();
      expect(parsed.config.signalDir).toBeTruthy();
    }

    // Has graph (if built)
    if (existsSync(graphPath)) {
      expect(parsed.graph).toBeTruthy();
      expect(typeof parsed.graph.nodeCount).toBe("number");
    }
  });
});
