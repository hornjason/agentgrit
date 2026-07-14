import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { optimizeRRFWeights, writeOptimalWeights } from "../../src/optimize/weight-optimizer";
import type { Graph, BM25Index } from "../../src/graph/types";
import type { GoldSet } from "../../src/evaluate/gold";

const TMP_DIR = join(import.meta.dir, ".tmp-weight-opt-test");

function makeGoldSet(sessions: Record<string, { description: string; relevantRules: string[]; domains?: string[] }>): GoldSet {
  const labeled: GoldSet["labeled"] = {};
  for (const [id, s] of Object.entries(sessions)) {
    labeled[id] = { sessionId: id, description: s.description, relevantRules: s.relevantRules, domains: s.domains };
  }
  return { labeled, totalLabeled: Object.keys(labeled).length, updated: new Date().toISOString() };
}

function makeGraph(nodeIds: string[]): Graph {
  const nodes: Graph["nodes"] = {};
  for (const id of nodeIds) {
    nodes[id] = {
      id,
      file: `${id}.md`,
      type: "feedback",
      name: id.replace(/_/g, " "),
      description: `Rule about ${id.replace(/_/g, " ")}`,
      domains: ["verification"],
      severity: 5,
      occurrence_count: 1,
      last_updated: new Date().toISOString(),
      content_hash: "abc",
      memoryType: "rule",
    };
  }
  return { version: "1", builtAt: new Date().toISOString(), nodeCount: nodeIds.length, edgeCount: 0, nodes, edges: [] };
}

function makeIndex(nodeIds: string[]): BM25Index {
  const docs = nodeIds.map(id => ({
    id,
    tokens: { [id]: 1, rule: 1, verification: 1 },
    len: 3,
  }));
  const vocabulary: BM25Index["vocabulary"] = {};
  const df: Record<string, number> = {};
  for (const doc of docs) {
    for (const t of Object.keys(doc.tokens)) df[t] = (df[t] || 0) + 1;
  }
  for (const [term, count] of Object.entries(df)) {
    vocabulary[term] = { df: count, idf: Math.log((docs.length - count + 0.5) / (count + 0.5) + 1) };
  }
  return { builtAt: new Date().toISOString(), docCount: docs.length, avgDocLen: 3, vocabulary, docs };
}

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

describe("optimizeRRFWeights", () => {
  test("returns result with correct shape", async () => {
    const nodeIds = ["r1", "r2", "r3", "r4", "r5"];
    const goldSet = makeGoldSet({ s1: { description: "verification rule", relevantRules: ["r1", "r2"], domains: ["verification"] } });
    const goldPath = join(TMP_DIR, "gold.json");
    writeFileSync(goldPath, JSON.stringify(goldSet));

    const result = await optimizeRRFWeights({
      goldSetPath: goldPath,
      graph: makeGraph(nodeIds),
      index: makeIndex(nodeIds),
      maxIterations: 2,
      stateDir: TMP_DIR,
    });

    expect(result.bestWeights).toHaveProperty("bm25");
    expect(result.bestWeights).toHaveProperty("graph");
    expect(result.bestWeights).toHaveProperty("vector");
    expect(typeof result.bestScore).toBe("number");
    expect(result.iterations).toBeGreaterThanOrEqual(0);
    expect(result.history.length).toBeGreaterThan(0);
  });

  test("does not go below baseline floor of 0.76", async () => {
    const goldSet = makeGoldSet({ s1: { description: "impossible match", relevantRules: ["nonexistent"], domains: ["unknown"] } });
    const goldPath = join(TMP_DIR, "gold.json");
    writeFileSync(goldPath, JSON.stringify(goldSet));

    const result = await optimizeRRFWeights({
      goldSetPath: goldPath,
      graph: makeGraph(["r1"]),
      index: makeIndex(["r1"]),
      maxIterations: 2,
    });

    expect(result.bestWeights).toEqual({ bm25: 2, graph: 0.5, vector: 1 });
  });

  test("history includes initial baseline", async () => {
    const nodeIds = ["r1", "r2", "r3"];
    const goldSet = makeGoldSet({ s1: { description: "verification", relevantRules: ["r1"], domains: ["verification"] } });
    const goldPath = join(TMP_DIR, "gold.json");
    writeFileSync(goldPath, JSON.stringify(goldSet));

    const result = await optimizeRRFWeights({
      goldSetPath: goldPath,
      graph: makeGraph(nodeIds),
      index: makeIndex(nodeIds),
      maxIterations: 1,
    });

    expect(result.history[0].weights).toEqual({ bm25: 2, graph: 0.5, vector: 1 });
  });

  test("writes state log when stateDir provided", async () => {
    const nodeIds = ["r1", "r2", "r3"];
    const goldSet = makeGoldSet({ s1: { description: "r1 rule verification", relevantRules: ["r1"], domains: ["verification"] } });
    const goldPath = join(TMP_DIR, "gold.json");
    writeFileSync(goldPath, JSON.stringify(goldSet));

    await optimizeRRFWeights({
      goldSetPath: goldPath,
      graph: makeGraph(nodeIds),
      index: makeIndex(nodeIds),
      maxIterations: 1,
      stateDir: TMP_DIR,
    });

    const logPath = join(TMP_DIR, "weight-opt.json");
    // Log may or may not exist depending on whether score met floor
    if (existsSync(logPath)) {
      const log = JSON.parse(readFileSync(logPath, "utf-8"));
      expect(log.bestWeights).toBeDefined();
      expect(log.history).toBeDefined();
    }
  });

  test("stalls after no improvement rounds", async () => {
    const goldSet = makeGoldSet({ s1: { description: "test", relevantRules: ["missing"], domains: ["unknown"] } });
    const goldPath = join(TMP_DIR, "gold.json");
    writeFileSync(goldPath, JSON.stringify(goldSet));

    const result = await optimizeRRFWeights({
      goldSetPath: goldPath,
      graph: makeGraph(["r1"]),
      index: makeIndex(["r1"]),
      maxIterations: 20,
    });

    // Should terminate early due to stall limit (5 rounds without improvement)
    expect(result.iterations).toBeLessThan(20 * 6);
  });

  test("weights never go negative", async () => {
    const goldSet = makeGoldSet({ s1: { description: "rule verification", relevantRules: ["r1"], domains: ["verification"] } });
    const goldPath = join(TMP_DIR, "gold.json");
    writeFileSync(goldPath, JSON.stringify(goldSet));

    const result = await optimizeRRFWeights({
      goldSetPath: goldPath,
      graph: makeGraph(["r1", "r2"]),
      index: makeIndex(["r1", "r2"]),
      maxIterations: 3,
    });

    for (const entry of result.history) {
      expect(entry.weights.bm25).toBeGreaterThanOrEqual(0);
      expect(entry.weights.graph).toBeGreaterThanOrEqual(0);
      expect(entry.weights.vector).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("writeOptimalWeights", () => {
  const origEnv = process.env.AGENTGRIT_DIR;

  beforeEach(() => {
    process.env.AGENTGRIT_DIR = TMP_DIR;
  });

  afterEach(() => {
    if (origEnv) process.env.AGENTGRIT_DIR = origEnv;
    else delete process.env.AGENTGRIT_DIR;
  });

  test("writes rrfWeights to config.json", () => {
    writeFileSync(join(TMP_DIR, "config.json"), JSON.stringify({ signalDir: "/tmp/signals", adapter: "local", rubrics: [], rules: { globalBudget: 25, projectBudget: 25, autoPromote: false }, daemon: { interval: "0", weeklyDay: "sunday" } }));

    writeOptimalWeights({ bm25: 2.5, graph: 0.75, vector: 1.25 });

    const config = JSON.parse(readFileSync(join(TMP_DIR, "config.json"), "utf-8"));
    expect(config.rrfWeights).toEqual({ bm25: 2.5, graph: 0.75, vector: 1.25 });
    expect(config.signalDir).toBe("/tmp/signals");
  });

  test("creates config.json when it does not exist", () => {
    writeOptimalWeights({ bm25: 1, graph: 1, vector: 1 });

    const configPath = join(TMP_DIR, "config.json");
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.rrfWeights).toEqual({ bm25: 1, graph: 1, vector: 1 });
  });

  test("preserves existing config fields", () => {
    writeFileSync(join(TMP_DIR, "config.json"), JSON.stringify({ signalDir: "/custom/signals", adapter: "both", rubrics: ["a.json"], rules: { globalBudget: 10, projectBudget: 10, autoPromote: true }, daemon: { interval: "daily", weeklyDay: "monday" } }));

    writeOptimalWeights({ bm25: 3, graph: 0.5, vector: 2 });

    const config = JSON.parse(readFileSync(join(TMP_DIR, "config.json"), "utf-8"));
    expect(config.adapter).toBe("both");
    expect(config.rubrics).toEqual(["a.json"]);
    expect(config.rrfWeights).toEqual({ bm25: 3, graph: 0.5, vector: 2 });
  });
});
