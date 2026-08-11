import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { cosine } from "../../src/graph/embedder";
import { loadVectorCache, rankByVectorSimilarity } from "../../src/graph/embeddings";
import { retrieveByEmbeddingSeed } from "../../src/graph/context";
import { tokenize } from "../../src/graph/bm25";
import type { Graph, BM25Index } from "../../src/graph/types";
import type { GraphNode } from "../../src/adapters/types";

const TMP_DIR = join(import.meta.dir, ".tmp-embed-strat-test");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

function makeNode(id: string, domains: string[], description?: string): GraphNode {
  return {
    id,
    file: `${id}.md`,
    type: "feedback",
    name: `Rule: ${id}`,
    description: description || `Text for ${id}`,
    domains,
    severity: 3,
    occurrence_count: 0,
    last_updated: new Date().toISOString(),
    content_hash: id.slice(0, 8),
    memoryType: "behavioral-rule",
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

function buildTestIndex(docs: Array<{ id: string; text: string }>): BM25Index {
  const entries = docs.map(d => {
    const tokens = tokenize(d.text);
    const counts: Record<string, number> = {};
    for (const t of tokens) counts[t] = (counts[t] || 0) + 1;
    return { id: d.id, tokens: counts, len: tokens.length };
  });

  const N = entries.length;
  const avgDocLen = N > 0 ? entries.reduce((s, d) => s + d.len, 0) / N : 0;

  const df: Record<string, number> = {};
  for (const doc of entries) {
    for (const term of Object.keys(doc.tokens)) {
      df[term] = (df[term] || 0) + 1;
    }
  }

  const vocabulary: Record<string, { idf: number; df: number }> = {};
  for (const [term, dfVal] of Object.entries(df)) {
    vocabulary[term] = {
      idf: Math.log((N - dfVal + 0.5) / (dfVal + 0.5) + 1),
      df: dfVal,
    };
  }

  return { builtAt: new Date().toISOString(), docCount: N, avgDocLen, vocabulary, docs: entries };
}

function randomVec(dim: number, seed: number): number[] {
  const v: number[] = [];
  let s = seed;
  for (let i = 0; i < dim; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    v.push((s / 0x7fffffff) * 2 - 1);
  }
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
  return v.map(x => x / norm);
}

function similarVec(base: number[], noise: number): number[] {
  const v = base.map((x, i) => x + (Math.sin(i * noise) * 0.1));
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
  return v.map(x => x / norm);
}

describe("retrieveByEmbeddingSeed", () => {
  test("returns rules scored by cosine similarity to BM25 seeds", () => {
    const dim = 384;
    const baseVec = randomVec(dim, 42);
    const cache = new Map<string, number[]>();

    cache.set("seed_rule", baseVec);
    cache.set("similar_rule_1", similarVec(baseVec, 1));
    cache.set("similar_rule_2", similarVec(baseVec, 2));
    cache.set("dissimilar_rule", randomVec(dim, 999));

    const graph = makeGraph([
      makeNode("seed_rule", ["algorithm"], "fix path deduplication"),
      makeNode("similar_rule_1", ["algorithm"], "semantic neighbor 1"),
      makeNode("similar_rule_2", ["algorithm"], "semantic neighbor 2"),
      makeNode("dissimilar_rule", ["deployment"], "unrelated deployment rule"),
    ]);

    const docs = [
      { id: "seed_rule", text: "fix path deduplication" },
      { id: "similar_rule_1", text: "semantic neighbor 1" },
      { id: "similar_rule_2", text: "semantic neighbor 2" },
      { id: "dissimilar_rule", text: "unrelated deployment rule" },
    ];
    const index = buildTestIndex(docs);

    const results = retrieveByEmbeddingSeed(
      "fix path deduplication",
      graph,
      index,
      cache,
      10,
    );

    expect(results.length).toBeGreaterThan(0);

    const ids = results.map(r => r.id);
    expect(ids).toContain("seed_rule");
    expect(ids).toContain("similar_rule_1");
    expect(ids).toContain("similar_rule_2");
  });

  test("returns empty when cache is empty", () => {
    const cache = new Map<string, number[]>();
    const graph = makeGraph([makeNode("r1", ["algo"], "test")]);
    const docs = [{ id: "r1", text: "test" }];
    const index = buildTestIndex(docs);

    const results = retrieveByEmbeddingSeed("test", graph, index, cache, 10);
    expect(results).toEqual([]);
  });

  test("respects limit parameter", () => {
    const dim = 384;
    const baseVec = randomVec(dim, 42);
    const cache = new Map<string, number[]>();
    const nodes: GraphNode[] = [];
    const docs: Array<{ id: string; text: string }> = [];

    for (let i = 0; i < 20; i++) {
      const id = `rule_${i}`;
      cache.set(id, similarVec(baseVec, i));
      nodes.push(makeNode(id, ["algorithm"], `rule text ${i}`));
      docs.push({ id, text: `rule text ${i}` });
    }

    const graph = makeGraph(nodes);
    const index = buildTestIndex(docs);

    const results = retrieveByEmbeddingSeed("rule text 0", graph, index, cache, 5);
    expect(results.length).toBeLessThanOrEqual(5);
  });

  test("different from BM25 — finds semantically similar nodes that BM25 misses", () => {
    const dim = 384;
    const baseVec = randomVec(dim, 42);
    const cache = new Map<string, number[]>();

    cache.set("bm25_hit", baseVec);
    cache.set("semantic_neighbor", similarVec(baseVec, 1));
    cache.set("no_keyword_match", similarVec(baseVec, 2));

    const graph = makeGraph([
      makeNode("bm25_hit", ["algorithm"], "fix path deduplication bug"),
      makeNode("semantic_neighbor", ["algorithm"], "resolve duplicate route entries"),
      makeNode("no_keyword_match", ["algorithm"], "consolidate overlapping records"),
    ]);

    const docs = [
      { id: "bm25_hit", text: "fix path deduplication bug" },
      { id: "semantic_neighbor", text: "resolve duplicate route entries" },
      { id: "no_keyword_match", text: "consolidate overlapping records" },
    ];
    const index = buildTestIndex(docs);

    const results = retrieveByEmbeddingSeed("fix path deduplication bug", graph, index, cache, 10);
    const ids = results.map(r => r.id);

    expect(ids).toContain("semantic_neighbor");
    expect(ids).toContain("no_keyword_match");
  });
});

describe("evaluatePrecision with strategy", () => {
  test("computePrecisionAtK still works for both strategies", async () => {
    const { computePrecisionAtK } = await import("../../src/evaluate/precision");
    const retrieved = ["A", "B", "C", "D", "E"];
    const expected = ["A", "C", "F"];
    expect(computePrecisionAtK(retrieved, expected, 5)).toBeCloseTo(0.4, 5);
  });
});
