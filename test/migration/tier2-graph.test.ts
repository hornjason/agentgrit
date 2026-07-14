import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from "fs";
import { join } from "path";
import { resolveMemoryDir } from "../../src/adapters/paths";
import { buildGraph } from "../../src/graph/builder";
import { buildIndexFromDir, searchIndex } from "../../src/graph/bm25";
import { hybridRetrieve } from "../../src/graph/retrieval";
import { queryGraph } from "../../src/graph/query";
import type { Graph } from "../../src/graph/types";

const memoryDir = resolveMemoryDir();
const hasMemory = existsSync(memoryDir);

const TEMP_STATE = join(import.meta.dir, ".tmp-graph-state");

describe("Tier 2: Graph Pipeline", () => {
  test("T7 — Build graph from PAI memory files", async () => {
    if (!hasMemory) return expect().pass();
    mkdirSync(TEMP_STATE, { recursive: true });
    try {
      const graph = await buildGraph(memoryDir, TEMP_STATE);
      expect(Object.keys(graph.nodes).length).toBeGreaterThanOrEqual(200);
      expect(graph.edges.length).toBeGreaterThan(0);
    } finally {
      if (existsSync(TEMP_STATE)) rmSync(TEMP_STATE, { recursive: true });
    }
  });

  test("T8 — Graph domain classification", async () => {
    if (!hasMemory) return expect().pass();
    mkdirSync(TEMP_STATE, { recursive: true });
    try {
      const graph = await buildGraph(memoryDir, TEMP_STATE);
      const nodes = Object.values(graph.nodes);
      expect(nodes.length).toBeGreaterThanOrEqual(20);

      const sample = nodes.sort(() => Math.random() - 0.5).slice(0, 20);
      const withDomains = sample.filter(
        (n) => Array.isArray(n.domains) && n.domains.length > 0 && n.domains[0].length > 0,
      );
      const agreement = withDomains.length / sample.length;
      // 53% coverage measured 2026-07-14; #112 tracks improving to 80%+
      expect(agreement).toBeGreaterThanOrEqual(0.4);
    } finally {
      if (existsSync(TEMP_STATE)) rmSync(TEMP_STATE, { recursive: true });
    }
  });

  test("T9 — BM25 search on built graph", () => {
    if (!hasMemory) return expect().pass();
    const index = buildIndexFromDir(memoryDir);
    expect(index.docCount).toBeGreaterThan(0);

    const results = searchIndex(index, "verification");
    expect(results.length).toBeGreaterThanOrEqual(5);
    expect(results[0].score).toBeGreaterThan(0);
  });

  test("T10 — Hybrid retrieval returns ranked results", async () => {
    if (!hasMemory) return expect().pass();
    mkdirSync(TEMP_STATE, { recursive: true });
    try {
      const graph = await buildGraph(memoryDir, TEMP_STATE);
      const index = buildIndexFromDir(memoryDir);

      const results = hybridRetrieve("verification", ["verification"], graph, index);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].rrfScore).toBeGreaterThan(0);
    } finally {
      if (existsSync(TEMP_STATE)) rmSync(TEMP_STATE, { recursive: true });
    }
  });

  test("T11 — Graph query by domain", async () => {
    if (!hasMemory) return expect().pass();
    mkdirSync(TEMP_STATE, { recursive: true });
    try {
      const graph = await buildGraph(memoryDir, TEMP_STATE);
      const clusters = queryGraph(graph, ["verification"]);
      expect(clusters.length).toBeGreaterThanOrEqual(2);
      for (const cluster of clusters) {
        expect(cluster.primary).toBeDefined();
        expect(cluster.score).toBeGreaterThan(0);
      }
    } finally {
      if (existsSync(TEMP_STATE)) rmSync(TEMP_STATE, { recursive: true });
    }
  });

  test("T12 — Incremental rebuild (change 1 file)", async () => {
    if (!hasMemory) return expect().pass();

    const tmpMemory = join(import.meta.dir, ".tmp-incr-memory");
    const tmpState1 = join(import.meta.dir, ".tmp-incr-state1");
    const tmpState2 = join(import.meta.dir, ".tmp-incr-state2");

    try {
      cpSync(memoryDir, tmpMemory, { recursive: true });
      mkdirSync(tmpState1, { recursive: true });
      mkdirSync(tmpState2, { recursive: true });

      const graph1 = await buildGraph(tmpMemory, tmpState1);
      const nodeCount1 = Object.keys(graph1.nodes).length;
      expect(nodeCount1).toBeGreaterThan(0);

      const graphFile1 = join(tmpState1, "knowledge-graph.json");
      const stateDir = join(import.meta.dir, "../../.agentgrit/state");
      const mainGraphPath = join(stateDir, "knowledge-graph.json");
      const originalGraph = existsSync(mainGraphPath)
        ? readFileSync(mainGraphPath, "utf-8")
        : null;

      mkdirSync(stateDir, { recursive: true });
      cpSync(graphFile1, mainGraphPath);

      const testFile = join(tmpMemory, "_test_incremental_rebuild.md");
      writeFileSync(
        testFile,
        "---\nname: test-incr\ndescription: Test incremental rebuild\nmetadata:\n  type: feedback\n---\n\nThis is a test rule for incremental rebuild verification.\n",
      );

      const graph2 = await buildGraph(tmpMemory, tmpState2);
      const nodeCount2 = Object.keys(graph2.nodes).length;

      expect(nodeCount2).toBe(nodeCount1 + 1);
      expect(graph2.nodes["_test_incremental_rebuild"]).toBeDefined();

      const unchangedNodes = Object.values(graph2.nodes).filter(
        (n) =>
          n.id !== "_test_incremental_rebuild" &&
          graph1.nodes[n.id] &&
          n.content_hash === graph1.nodes[n.id].content_hash,
      );
      expect(unchangedNodes.length).toBe(nodeCount1);

      if (originalGraph) {
        writeFileSync(mainGraphPath, originalGraph);
      }
    } finally {
      for (const d of [tmpMemory, tmpState1, tmpState2]) {
        if (existsSync(d)) rmSync(d, { recursive: true });
      }
    }
  });
});
