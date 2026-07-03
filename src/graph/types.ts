import type { GraphNode, GraphEdge, Rule } from "../adapters/types";

// ── Graph Container ──

export interface Graph {
  version: string;
  builtAt: string;
  nodeCount: number;
  edgeCount: number;
  nodes: Record<string, GraphNode>;
  edges: GraphEdge[];
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

// ── Re-exports for convenience ──

export type { GraphNode, GraphEdge, EdgeType, EdgeSource, Rule } from "../adapters/types";
