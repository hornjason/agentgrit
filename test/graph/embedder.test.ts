import { describe, test, expect } from "bun:test";
import { cosine, findEmbeddingEdges, semanticSearch } from "../../src/graph/embedder";
import type { Embedding } from "../../src/graph/types";

describe("cosine", () => {
  test("identical vectors return 1.0", () => {
    const v = [1, 2, 3, 4, 5];
    expect(cosine(v, v)).toBeCloseTo(1.0, 5);
  });

  test("orthogonal vectors return 0.0", () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0.0, 5);
  });

  test("opposite vectors return -1.0", () => {
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1.0, 5);
  });

  test("handles zero vector", () => {
    expect(cosine([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  test("computes similarity for non-trivial vectors", () => {
    const a = [1, 2, 3];
    const b = [2, 3, 4];
    const result = cosine(a, b);
    expect(result).toBeGreaterThan(0.9);
    expect(result).toBeLessThan(1.0);
  });
});

describe("findEmbeddingEdges", () => {
  test("finds edges between similar embeddings", () => {
    const embeddings: Embedding[] = [
      { id: "a", vector: [1.0, 0.0, 0.0] },
      { id: "b", vector: [0.99, 0.1, 0.0] },
      { id: "c", vector: [0.0, 0.0, 1.0] },
    ];

    const edges = findEmbeddingEdges(embeddings, { similarityFloor: 0.5 });

    const abEdge = edges.find(
      e => (e.source === "a" && e.target === "b") || (e.source === "b" && e.target === "a"),
    );
    expect(abEdge).toBeDefined();
    expect(abEdge!.strength).toBeGreaterThan(0);

    // a and c are orthogonal — no edge
    const acEdge = edges.find(
      e => (e.source === "a" && e.target === "c") || (e.source === "c" && e.target === "a"),
    );
    expect(acEdge).toBeUndefined();
  });

  test("respects maxEdgesPerNode", () => {
    // Create 10 similar vectors
    const embeddings: Embedding[] = Array.from({ length: 10 }, (_, i) => ({
      id: `node-${i}`,
      vector: [1.0 + i * 0.001, 0.1, 0.1],
    }));

    const edges = findEmbeddingEdges(embeddings, { maxEdgesPerNode: 2, similarityFloor: 0.5 });

    // Each node creates at most 2 edges — but deduplication means total might be less
    // than 10*2. Verify no node appears in more edges than the cap.
    const edgeCounts: Record<string, number> = {};
    for (const e of edges) {
      edgeCounts[e.source] = (edgeCounts[e.source] || 0) + 1;
    }
    // The source side should have at most maxEdgesPerNode per node
    for (const count of Object.values(edgeCounts)) {
      expect(count).toBeLessThanOrEqual(2);
    }
  });

  test("assigns tiered strengths", () => {
    // Two very similar vectors (cosine ~ 0.99) → strength 1.0
    const embeddings: Embedding[] = [
      { id: "a", vector: [1.0, 0.0, 0.0] },
      { id: "b", vector: [0.999, 0.01, 0.0] },
    ];

    const edges = findEmbeddingEdges(embeddings, { similarityFloor: 0.6 });
    expect(edges.length).toBe(1);
    expect(edges[0].strength).toBe(1.0);
  });

  test("deduplicates edges", () => {
    const embeddings: Embedding[] = [
      { id: "x", vector: [1.0, 0.1, 0.0] },
      { id: "y", vector: [0.99, 0.1, 0.0] },
    ];

    const edges = findEmbeddingEdges(embeddings, { similarityFloor: 0.5 });
    // Should be 1 edge, not 2 (one from each direction)
    expect(edges.length).toBe(1);
  });

  test("returns empty for empty embeddings", () => {
    const edges = findEmbeddingEdges([]);
    expect(edges).toEqual([]);
  });

  test("returns empty for single embedding", () => {
    const edges = findEmbeddingEdges([{ id: "a", vector: [1, 0, 0] }]);
    expect(edges).toEqual([]);
  });
});

describe("semanticSearch", () => {
  test("returns empty without query embedding", () => {
    const embeddings: Embedding[] = [{ id: "a", vector: [1, 0, 0] }];
    const results = semanticSearch("test", embeddings, 10);
    expect(results).toEqual([]);
  });

  test("returns ranked results with query embedding", () => {
    const embeddings: Embedding[] = [
      { id: "close", vector: [1.0, 0.1, 0.0] },
      { id: "far", vector: [0.0, 0.0, 1.0] },
    ];

    const queryVec = [1.0, 0.0, 0.0];
    const results = semanticSearch("test", embeddings, 10, queryVec);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe("close");
  });

  test("respects limit", () => {
    const embeddings: Embedding[] = Array.from({ length: 20 }, (_, i) => ({
      id: `node-${i}`,
      vector: [1.0 + i * 0.001, 0.1, 0.1],
    }));

    const results = semanticSearch("test", embeddings, 3, [1.0, 0.1, 0.1]);
    expect(results.length).toBeLessThanOrEqual(3);
  });
});
