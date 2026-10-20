import type { GraphNode, GraphEdge, Rule } from "../adapters/types";

// ── Graph Container ──

/**
 * Which corpus a graph was built from.
 *
 * Without this a wrong-directory build is indistinguishable from a correct
 * one: both produce a graph that answers every query. Issue #290 — a 47-node
 * graph sat in place of a 600-node corpus and nothing in the file said which
 * directory had been walked.
 */
export interface CorpusProvenance {
  /** Absolute path of the directory `discoverRuleFiles()` walked. */
  dir: string;
  /** How many indexable rule files that directory held at build time. */
  fileCount: number;
}

export interface Graph {
  version: string;
  builtAt: string;
  nodeCount: number;
  edgeCount: number;
  nodes: Record<string, GraphNode>;
  edges: GraphEdge[];
  /** Optional: graphs written before this field existed do not carry it. */
  builtFrom?: CorpusProvenance;
}

// ── Query Results ──

export interface RankedCluster {
  primary: GraphNode;
  connected: ConnectedNode[];
  score: number;
  domains: string[];
}

export interface ConnectedNode {
  node: GraphNode;
  relationship: string;
  strength: number;
}

// ── BM25 Index ──

export interface DocEntry {
  id: string;
  /** Path the doc was indexed from, so its body text can be read back. */
  file?: string;
  tokens: Record<string, number>;
  len: number;
}

export interface VocabEntry {
  idf: number;
  df: number;
}

export interface BM25Index {
  builtAt: string;
  docCount: number;
  avgDocLen: number;
  vocabulary: Record<string, VocabEntry>;
  docs: DocEntry[];
}

// ── Search Results ──

export interface SearchResult {
  id: string;
  score: number;
}

// ── Retrieval Results ──

export interface RetrievalResult {
  id: string;
  rrfScore: number;
  bm25Rank?: number;
  graphRank?: number;
  vectorRank?: number;
}

// ── Embeddings ──

export interface EmbedConfig {
  apiKey: string;
  model?: string;
  batchSize?: number;
  maxEdgesPerNode?: number;
  similarityFloor?: number;
}

export interface Embedding {
  id: string;
  vector: number[];
}

// ── Vector Cache ──

export interface VectorCache {
  model: string;
  dimensions: number;
  builtAt: string;
  vectors: Record<string, number[]>;
}

// ── Re-exports for convenience ──

export type { GraphNode, GraphEdge, EdgeType, EdgeSource, Rule, EmbeddingProvider } from "../adapters/types";
