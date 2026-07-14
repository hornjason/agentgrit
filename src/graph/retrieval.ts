import type { Graph, RankedCluster, BM25Index, RetrievalResult } from "./types";
import { queryGraph } from "./query";
import { searchIndex } from "./bm25";
import { loadConfig } from "../adapters/paths";

// RRF constant (standard value from Cormack et al.)
const RRF_K = 60;

// ── RRF Signal Weights ──

export interface RRFWeights {
  bm25: number;
  graph: number;
  vector: number;
}

const _rrfCfg = loadConfig().rrfWeights;
export const RRF_WEIGHTS: RRFWeights = {
  bm25: _rrfCfg?.bm25 ?? 2,
  graph: _rrfCfg?.graph ?? 0.5,
  vector: _rrfCfg?.vector ?? 1,
};

// ── RRF Merge ──

interface RRFEntry {
  id: string;
  score: number;
  bm25Rank?: number;
  graphRank?: number;
  vectorRank?: number;
}

export function rrfMerge(
  bm25List: Array<{ id: string; rank: number }>,
  graphList: Array<{ id: string; rank: number }>,
  vectorList?: Array<{ id: string; rank: number }>,
  weights?: Partial<RRFWeights>,
): Map<string, RRFEntry> {
  const w = { ...RRF_WEIGHTS, ...weights };
  const scores = new Map<string, RRFEntry>();

  for (const item of bm25List) {
    const contribution = w.bm25 * (1 / (RRF_K + item.rank));
    const existing = scores.get(item.id);
    if (existing) {
      existing.score += contribution;
      existing.bm25Rank = item.rank;
    } else {
      scores.set(item.id, {
        id: item.id,
        score: contribution,
        bm25Rank: item.rank,
      });
    }
  }

  for (const item of graphList) {
    const contribution = w.graph * (1 / (RRF_K + item.rank));
    const existing = scores.get(item.id);
    if (existing) {
      existing.score += contribution;
      existing.graphRank = item.rank;
    } else {
      scores.set(item.id, {
        id: item.id,
        score: contribution,
        graphRank: item.rank,
      });
    }
  }

  if (vectorList) {
    for (const item of vectorList) {
      const contribution = w.vector * (1 / (RRF_K + item.rank));
      const existing = scores.get(item.id);
      if (existing) {
        existing.score += contribution;
        existing.vectorRank = item.rank;
      } else {
        scores.set(item.id, {
          id: item.id,
          score: contribution,
          vectorRank: item.rank,
        });
      }
    }
  }

  return scores;
}

// ── Hybrid Retrieve ──

export function hybridRetrieve(
  query: string,
  domains: string[],
  graph: Graph,
  index: BM25Index,
  limit: number = 15,
): RetrievalResult[] {
  // Step 1: BM25 keyword search (top 50)
  const bm25Results = searchIndex(index, query, 50);
  const bm25List = bm25Results.map((r, i) => ({ id: r.id, rank: i + 1 }));

  // Step 2: Graph domain traversal (top 50)
  const clusters: RankedCluster[] = queryGraph(graph, domains, 50);
  const graphList = clusters.map((c, i) => ({ id: c.primary.id, rank: i + 1 }));

  if (bm25List.length === 0 && graphList.length === 0) return [];

  // Step 3: RRF merge (uses global RRF_WEIGHTS)
  const merged = rrfMerge(bm25List, graphList, undefined, RRF_WEIGHTS);

  // Sort by RRF score descending
  const sorted = Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return sorted.map(entry => ({
    id: entry.id,
    rrfScore: entry.score,
    bm25Rank: entry.bm25Rank,
    graphRank: entry.graphRank,
    vectorRank: entry.vectorRank,
  }));
}
