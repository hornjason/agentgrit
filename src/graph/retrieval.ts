import type { Graph, RankedCluster, BM25Index, RetrievalResult } from "./types";
import { queryGraph } from "./query";
import { searchIndex } from "./bm25";

// RRF constant (standard value from Cormack et al.)
const RRF_K = 60;

// ── RRF Merge ──

interface RRFEntry {
  id: string;
  score: number;
  bm25Rank?: number;
  graphRank?: number;
}

function rrfMerge(
  bm25List: Array<{ id: string; rank: number }>,
  graphList: Array<{ id: string; rank: number }>,
): Map<string, RRFEntry> {
  const scores = new Map<string, RRFEntry>();

  for (const item of bm25List) {
    const contribution = 1 / (RRF_K + item.rank);
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
    const contribution = 1 / (RRF_K + item.rank);
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

  // Step 3: RRF merge
  const merged = rrfMerge(bm25List, graphList);

  // Sort by RRF score descending
  const sorted = Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return sorted.map(entry => ({
    id: entry.id,
    rrfScore: entry.score,
    bm25Rank: entry.bm25Rank,
    graphRank: entry.graphRank,
  }));
}
