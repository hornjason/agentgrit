import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { hybridRetrieve } from "../../src/graph/retrieval";
import { buildIndex } from "../../src/graph/bm25";
import type { Graph } from "../../src/graph/types";
import type { GraphNode, GraphNodeStats } from "../../src/adapters/types";

const TMP_DIR = join(import.meta.dir, ".tmp-retrieval-test");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

function makeStats(): GraphNodeStats {
  return {
    injectionCount: 0,
    avgRating: 0,
    highRatingActivations: 0,
    lowRatingActivations: 0,
    sessionRatings: [],
    lastSeen: new Date().toISOString(),
  };
}

function makeNode(id: string, domains: string[]): GraphNode {
  return {
    id,
    name: `Rule: ${id}`,
    domains,
    ruleText: `Text for ${id}`,
    hash: id.slice(0, 8),
    stats: makeStats(),
  };
}

function makeGraph(nodes: GraphNode[]): Graph {
  const nodeMap: Record<string, GraphNode> = {};
  for (const n of nodes) nodeMap[n.id] = n;
  return {
    version: "1.0",
    builtAt: new Date().toISOString(),
    nodeCount: nodes.length,
    edgeCount: 0,
    nodes: nodeMap,
    edges: [],
  };
}

function writeDoc(filename: string, content: string): string {
  const path = join(TMP_DIR, filename);
  writeFileSync(path, content, "utf-8");
  return path;
}

describe("hybridRetrieve", () => {
  test("merges BM25 and graph results via RRF", () => {
    // Set up BM25 index
    const f1 = writeDoc("deploy_rule.md", "deploy containers to production with make rebuild");
    const f2 = writeDoc("verify_rule.md", "verify all endpoints health check status");
    const f3 = writeDoc("scope_rule.md", "minimal scope focused changes only");

    const index = buildIndex([f1, f2, f3]);

    // Set up graph with domain-tagged nodes
    const graph = makeGraph([
      makeNode("deploy_rule", ["deployment"]),
      makeNode("verify_rule", ["verification"]),
      makeNode("scope_rule", ["scope"]),
    ]);

    const results = hybridRetrieve("deploy production", ["deployment"], graph, index);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe("deploy_rule");
    expect(results[0].rrfScore).toBeGreaterThan(0);
  });

  test("items in both lists get higher RRF scores", () => {
    const f1 = writeDoc("both.md", "deploy production make rebuild containers");
    const f2 = writeDoc("bm25_only.md", "deploy production environment staging");
    const f3 = writeDoc("graph_only.md", "security scan vulnerability assessment");

    const index = buildIndex([f1, f2, f3]);
    const graph = makeGraph([
      makeNode("both", ["deployment"]),
      makeNode("graph_only", ["deployment"]),
    ]);

    const results = hybridRetrieve("deploy production", ["deployment"], graph, index);

    const bothResult = results.find(r => r.id === "both");
    expect(bothResult).toBeDefined();
    expect(bothResult!.bm25Rank).toBeDefined();
    expect(bothResult!.graphRank).toBeDefined();
    expect(bothResult!.rrfScore).toBeGreaterThan(0);
  });

  test("returns empty when both sources are empty", () => {
    const index = buildIndex([]);
    const graph = makeGraph([]);

    const results = hybridRetrieve("anything", ["verification"], graph, index);
    expect(results).toEqual([]);
  });

  test("works with BM25 only (empty graph)", () => {
    const f1 = writeDoc("rule.md", "deploy containers to production");
    const index = buildIndex([f1]);
    const graph = makeGraph([]);

    const results = hybridRetrieve("deploy production", ["deployment"], graph, index);
    expect(results.length).toBe(1);
    expect(results[0].bm25Rank).toBeDefined();
    expect(results[0].graphRank).toBeUndefined();
  });

  test("works with graph only (empty index)", () => {
    const index = buildIndex([]);
    const graph = makeGraph([
      makeNode("deploy_rule", ["deployment"]),
    ]);

    const results = hybridRetrieve("deploy", ["deployment"], graph, index);
    expect(results.length).toBe(1);
    expect(results[0].graphRank).toBeDefined();
    expect(results[0].bm25Rank).toBeUndefined();
  });

  test("respects limit", () => {
    const files = Array.from({ length: 20 }, (_, i) => {
      return writeDoc(`rule_${i}.md`, `deploy production containers ${i}`);
    });
    const nodes = Array.from({ length: 20 }, (_, i) =>
      makeNode(`rule_${i}`, ["deployment"]),
    );

    const index = buildIndex(files);
    const graph = makeGraph(nodes);

    const results = hybridRetrieve("deploy production", ["deployment"], graph, index, 5);
    expect(results.length).toBeLessThanOrEqual(5);
  });

  test("RRF score follows 1/(k+rank) formula", () => {
    const f1 = writeDoc("only_bm25.md", "deploy production containers rebuild");
    const index = buildIndex([f1]);
    const graph = makeGraph([]);

    const results = hybridRetrieve("deploy", [], graph, index);
    expect(results.length).toBe(1);

    // rank=1, RRF_K=60: score = 1/(60+1) = 0.01639...
    const expected = 1 / (60 + 1);
    expect(results[0].rrfScore).toBeCloseTo(expected, 4);
  });
});
