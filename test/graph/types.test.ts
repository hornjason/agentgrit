import { describe, test, expect } from "bun:test";
import type {
  Graph,
  RankedCluster,
  ConnectedNode,
  BM25Index,
  SearchResult,
  RetrievalResult,
  EmbedConfig,
  Embedding,
  GraphNode,
  GraphEdge,
  Rule,
} from "../../src/graph/types";

describe("graph types", () => {
  test("Graph structure is constructible", () => {
    const graph: Graph = {
      version: "1.0",
      builtAt: new Date().toISOString(),
      nodeCount: 0,
      edgeCount: 0,
      nodes: {},
      edges: [],
    };
    expect(graph.version).toBe("1.0");
    expect(graph.nodeCount).toBe(0);
  });

  test("RankedCluster is constructible", () => {
    const cluster: RankedCluster = {
      primary: {
        id: "test",
        name: "test",
        domains: ["verification"],
        stats: {
          injectionCount: 0,
          avgRating: 0,
          highRatingActivations: 0,
          lowRatingActivations: 0,
          sessionRatings: [],
          lastSeen: "",
        },
      },
      connected: [],
      score: 0.5,
      domains: ["verification"],
    };
    expect(cluster.score).toBe(0.5);
  });

  test("BM25Index is constructible", () => {
    const index: BM25Index = {
      builtAt: new Date().toISOString(),
      docCount: 0,
      avgDocLen: 0,
      vocabulary: {},
      docs: [],
    };
    expect(index.docCount).toBe(0);
  });

  test("SearchResult is constructible", () => {
    const result: SearchResult = { id: "test", score: 1.5 };
    expect(result.score).toBe(1.5);
  });

  test("RetrievalResult is constructible", () => {
    const result: RetrievalResult = {
      id: "test",
      rrfScore: 0.016,
      bm25Rank: 1,
      graphRank: 2,
    };
    expect(result.rrfScore).toBeGreaterThan(0);
  });

  test("Embedding is constructible", () => {
    const emb: Embedding = { id: "test", vector: [1, 2, 3] };
    expect(emb.vector.length).toBe(3);
  });

  test("EmbedConfig is constructible", () => {
    const config: EmbedConfig = {
      apiKey: "test-key",
      model: "voyage-3-lite",
      batchSize: 20,
      maxEdgesPerNode: 8,
      similarityFloor: 0.6,
    };
    expect(config.apiKey).toBe("test-key");
  });

  test("re-exported GraphNode from adapters works", () => {
    const node: GraphNode = {
      id: "test",
      name: "test",
      domains: ["verification"],
      stats: {
        injectionCount: 0,
        avgRating: 0,
        highRatingActivations: 0,
        lowRatingActivations: 0,
        sessionRatings: [],
        lastSeen: "",
      },
    };
    expect(node.id).toBe("test");
  });

  test("re-exported GraphEdge from adapters works", () => {
    const edge: GraphEdge = {
      source: "a",
      target: "b",
      type: "reinforces",
      strength: 0.8,
    };
    expect(edge.type).toBe("reinforces");
  });
});
