import type { Graph, RankedCluster, BM25Index, RetrievalResult } from "./types";
import { queryGraph } from "./query";
import { searchIndex, searchIndexExpanded } from "./bm25";
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

function flattenClusters(clusters: RankedCluster[]): Array<{ id: string; rank: number }> {
  const seen = new Set<string>();
  const list: Array<{ id: string; rank: number }> = [];
  let rank = 1;
  for (const c of clusters) {
    if (!seen.has(c.primary.id)) {
      list.push({ id: c.primary.id, rank: rank++ });
      seen.add(c.primary.id);
    }
    for (const conn of c.connected) {
      if (!seen.has(conn.node.id)) {
        list.push({ id: conn.node.id, rank: rank++ });
        seen.add(conn.node.id);
      }
    }
  }
  return list;
}

/**
 * Lexical hits the graph has a node for, re-ranked densely.
 *
 * The index and the graph are built from overlapping but unequal file sets —
 * 648 indexed documents against 47 nodes on the install #258 was found on. A
 * hit with no node carries no domain, no severity and no text, so every
 * consumer downstream renders it as its own id. Dropping it here rather than
 * at the end keeps the floor honest: a document that cannot become a rule must
 * not occupy a slot that a rule was going to fill.
 *
 * Ranks are recomputed after the drop so RRF sees 1..n with no holes.
 */
function rankKnown(
  results: Array<{ id: string }>,
  graph: Graph,
): Array<{ id: string; rank: number }> {
  return results
    .filter(r => graph.nodes[r.id] !== undefined)
    .map((r, i) => ({ id: r.id, rank: i + 1 }));
}

export function hybridRetrieve(
  query: string,
  domains: string[],
  graph: Graph,
  index: BM25Index,
  limit: number = 15,
  vectorList?: Array<{ id: string; rank: number }>,
  weights?: RRFWeights,
): RetrievalResult[] {
  // Step 1: BM25 keyword search (top 50), restricted to documents the graph
  // can describe. See `rankKnown`.
  const bm25List = rankKnown(searchIndex(index, query, 50), graph);

  // Step 2: Graph domain traversal (top 50) — include connected nodes
  const graphList = flattenClusters(queryGraph(graph, domains, 50));

  if (bm25List.length === 0 && graphList.length === 0 && !vectorList?.length) return [];

  // Step 3: RRF merge
  const merged = rrfMerge(bm25List, graphList, vectorList, weights ?? RRF_WEIGHTS);

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

// ── Hybrid Retrieve with a Floor ──

/**
 * `hybridRetrieve`, widened when it comes back thin (#258).
 *
 * `hybridRetrieve` only ever sees two pools: documents whose exact tokens match
 * the query, and nodes whose `domains` literally overlap the caller's. When a
 * session asks for domains only a couple of nodes carry — the state #258 was
 * stuck in — both pools are nearly empty and the caller gets two results no
 * matter how large the corpus is.
 *
 * The top-up re-runs the same merge against the whole corpus: stem-expanded
 * lexical search for query signal, domain-agnostic graph ranking for the rest.
 * It is correlation-ranked, not a fixed list — change the query and the top-up
 * reorders. Top-up scores are scaled below the weakest primary hit so a real
 * domain match is never displaced by a floor filler.
 */
export function hybridRetrieveWithFloor(
  query: string,
  domains: string[],
  graph: Graph,
  index: BM25Index,
  limit: number = 15,
  floor: number = 0,
  vectorList?: Array<{ id: string; rank: number }>,
  weights?: RRFWeights,
): RetrievalResult[] {
  const primary = hybridRetrieve(query, domains, graph, index, limit, vectorList, weights);

  const target = Math.min(limit, floor);
  if (primary.length >= target) return primary;

  const poolSize = Math.max(limit, target * 4);
  const lexList = rankKnown(searchIndexExpanded(index, query, poolSize), graph);
  // Domain-agnostic: queryGraph with no domains ranks on severity and edge
  // strength, which is what is left once domain overlap has nothing to say.
  const graphList = flattenClusters(queryGraph(graph, [], poolSize));

  if (lexList.length === 0 && graphList.length === 0) return primary;

  const merged = rrfMerge(lexList, graphList, vectorList, weights ?? RRF_WEIGHTS);
  const seen = new Set(primary.map(r => r.id));
  const extras = Array.from(merged.values())
    .filter(e => !seen.has(e.id))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  if (extras.length === 0) return primary;

  // Keep every primary hit ahead of every top-up.
  const weakestPrimary = primary.length > 0 ? primary[primary.length - 1].rrfScore : 0;
  const strongestExtra = extras[0].score;
  const scale = primary.length > 0 && strongestExtra > 0
    ? (weakestPrimary * 0.9) / strongestExtra
    : 1;

  const floored = [...primary];
  for (const extra of extras) {
    if (floored.length >= target) break;
    floored.push({
      id: extra.id,
      rrfScore: extra.score * scale,
      bm25Rank: extra.bm25Rank,
      graphRank: extra.graphRank,
      vectorRank: extra.vectorRank,
    });
  }
  return floored;
}
