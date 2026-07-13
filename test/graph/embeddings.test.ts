import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import {
  loadVectorCache,
  saveVectorCache,
  rankByVectorSimilarity,
  computeCentroid,
  computeAndSaveCache,
  LocalEmbeddingProvider,
} from "../../src/graph/embeddings";
import { cosine } from "../../src/graph/embedder";
import type { Graph } from "../../src/graph/types";
import type { GraphNode, EmbeddingProvider } from "../../src/adapters/types";

const TMP_DIR = join(import.meta.dir, ".tmp-embeddings-test");

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
    type: "rule",
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

// Mock embedding provider that returns deterministic vectors
class MockEmbeddingProvider implements EmbeddingProvider {
  dimensions: number;
  callCount = 0;

  constructor(dimensions: number = 384) {
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.callCount++;
    return texts.map((text, i) => {
      const vec = new Array(this.dimensions).fill(0);
      // Create distinguishable vectors using text hash
      const hash = text.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
      for (let j = 0; j < this.dimensions; j++) {
        vec[j] = Math.sin(hash * (j + 1) * 0.01);
      }
      // Normalize
      const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0));
      return vec.map((v: number) => v / norm);
    });
  }
}

describe("vector cache I/O", () => {
  test("save and load roundtrip", () => {
    const cachePath = join(TMP_DIR, "test-cache.json");
    const vectors = new Map<string, number[]>();
    vectors.set("rule_a", [0.1, 0.2, 0.3]);
    vectors.set("rule_b", [0.4, 0.5, 0.6]);

    saveVectorCache(vectors, "test-model", 3, cachePath);
    const loaded = loadVectorCache(cachePath);

    expect(loaded).not.toBeNull();
    expect(loaded!.size).toBe(2);
    expect(loaded!.get("rule_a")).toEqual([0.1, 0.2, 0.3]);
    expect(loaded!.get("rule_b")).toEqual([0.4, 0.5, 0.6]);
  });

  test("load returns null for missing file", () => {
    const result = loadVectorCache(join(TMP_DIR, "nonexistent.json"));
    expect(result).toBeNull();
  });

  test("load returns null for malformed JSON", () => {
    const path = join(TMP_DIR, "bad.json");
    writeFileSync(path, "not json", "utf-8");
    const result = loadVectorCache(path);
    expect(result).toBeNull();
  });

  test("load returns null for JSON without vectors field", () => {
    const path = join(TMP_DIR, "empty.json");
    writeFileSync(path, JSON.stringify({ model: "test" }), "utf-8");
    const result = loadVectorCache(path);
    expect(result).toBeNull();
  });

  test("save creates directories if needed", () => {
    const cachePath = join(TMP_DIR, "nested", "dir", "cache.json");
    const vectors = new Map<string, number[]>();
    vectors.set("a", [1, 2, 3]);
    saveVectorCache(vectors, "test", 3, cachePath);
    expect(existsSync(cachePath)).toBe(true);
  });
});

describe("rankByVectorSimilarity", () => {
  test("returns results sorted by cosine similarity", () => {
    const cache = new Map<string, number[]>();
    cache.set("close", [0.9, 0.1, 0.0]);
    cache.set("far", [0.0, 0.0, 1.0]);
    cache.set("medium", [0.5, 0.5, 0.0]);

    const query = [1.0, 0.0, 0.0];
    const results = rankByVectorSimilarity(query, cache, 10);

    expect(results.length).toBe(3);
    expect(results[0].id).toBe("close");
    expect(results[1].id).toBe("medium");
    expect(results[2].id).toBe("far");
  });

  test("respects limit", () => {
    const cache = new Map<string, number[]>();
    for (let i = 0; i < 20; i++) {
      cache.set(`rule_${i}`, [Math.random(), Math.random(), Math.random()]);
    }

    const results = rankByVectorSimilarity([1, 0, 0], cache, 5);
    expect(results.length).toBe(5);
  });

  test("returns empty for empty cache", () => {
    const results = rankByVectorSimilarity([1, 0, 0], new Map(), 10);
    expect(results.length).toBe(0);
  });
});

describe("computeCentroid", () => {
  test("averages vectors of given IDs", () => {
    const cache = new Map<string, number[]>();
    cache.set("a", [1.0, 0.0, 0.0]);
    cache.set("b", [0.0, 1.0, 0.0]);
    cache.set("c", [0.0, 0.0, 1.0]);

    const centroid = computeCentroid(["a", "b"], cache);
    expect(centroid).not.toBeNull();
    expect(centroid![0]).toBeCloseTo(0.5);
    expect(centroid![1]).toBeCloseTo(0.5);
    expect(centroid![2]).toBeCloseTo(0.0);
  });

  test("returns null when no IDs match cache", () => {
    const cache = new Map<string, number[]>();
    cache.set("a", [1, 0, 0]);
    const result = computeCentroid(["x", "y"], cache);
    expect(result).toBeNull();
  });

  test("skips missing IDs gracefully", () => {
    const cache = new Map<string, number[]>();
    cache.set("a", [1.0, 0.0]);
    const centroid = computeCentroid(["a", "missing"], cache);
    expect(centroid).not.toBeNull();
    expect(centroid![0]).toBeCloseTo(1.0);
    expect(centroid![1]).toBeCloseTo(0.0);
  });
});

describe("EmbeddingProvider interface", () => {
  test("MockEmbeddingProvider satisfies the interface", async () => {
    const provider: EmbeddingProvider = new MockEmbeddingProvider(384);
    const result = await provider.embed(["hello world"]);
    expect(result.length).toBe(1);
    expect(result[0].length).toBe(384);
  });

  test("returns number[][] with 384 dimensions", async () => {
    const provider = new MockEmbeddingProvider(384);
    const result = await provider.embed(["test input", "another input"]);
    expect(result.length).toBe(2);
    expect(result[0].length).toBe(384);
    expect(result[1].length).toBe(384);
    expect(typeof result[0][0]).toBe("number");
  });

  test("vectors are normalized (unit length)", async () => {
    const provider = new MockEmbeddingProvider(384);
    const result = await provider.embed(["normalize check"]);
    const norm = Math.sqrt(result[0].reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 4);
  });
});

describe("computeAndSaveCache", () => {
  test("computes vectors for all graph nodes and saves", async () => {
    const graph = makeGraph([
      makeNode("rule_a", ["deployment"], "Deploy with containers"),
      makeNode("rule_b", ["verification"], "Verify before asserting"),
    ]);

    const provider = new MockEmbeddingProvider(384);
    const cachePath = join(TMP_DIR, "computed-cache.json");

    await computeAndSaveCache(graph, provider, cachePath);

    expect(existsSync(cachePath)).toBe(true);
    const loaded = loadVectorCache(cachePath);
    expect(loaded).not.toBeNull();
    expect(loaded!.size).toBe(2);
    expect(loaded!.get("rule_a")!.length).toBe(384);
    expect(loaded!.get("rule_b")!.length).toBe(384);
  });

  test("handles empty graph", async () => {
    const graph = makeGraph([]);
    const provider = new MockEmbeddingProvider(384);
    const cachePath = join(TMP_DIR, "empty-cache.json");

    await computeAndSaveCache(graph, provider, cachePath);
    expect(existsSync(cachePath)).toBe(false);
  });

  test("batches embeddings", async () => {
    const nodes = Array.from({ length: 25 }, (_, i) =>
      makeNode(`rule_${i}`, ["test"], `Description for rule ${i}`),
    );
    const graph = makeGraph(nodes);
    const provider = new MockEmbeddingProvider(384);
    const cachePath = join(TMP_DIR, "batched-cache.json");

    await computeAndSaveCache(graph, provider, cachePath, 10);

    expect(provider.callCount).toBe(3); // 10 + 10 + 5
    const loaded = loadVectorCache(cachePath);
    expect(loaded!.size).toBe(25);
  });
});
