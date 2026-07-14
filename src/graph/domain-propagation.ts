import type { GraphNode, GraphEdge } from "../adapters/types";
import type { BM25Index, DocEntry, VocabEntry } from "./types";
import { tokenize, searchIndex } from "./bm25";
import { DOMAINS } from "./builder";

const EDGE_WEIGHTS: Record<string, number> = {
  co_occurred: 1.0,
  reinforces: 1.5,
  sibling: 0.8,
  caused_by_same_root: 1.2,
  caused_by: 1.0,
  applies_when: 0.8,
  co_occurred_in_failure: 0.8,
  supersedes: 0.5,
  same_domain: 0,
  conflicts_with: 0,
  contradicts: 0,
};

function isClassified(node: GraphNode): boolean {
  return node.domains.length > 0 && !!node.domains[0];
}

function isValidDomain(d: string): boolean {
  return (DOMAINS as readonly string[]).includes(d);
}

function buildClassifiedIndex(nodes: Record<string, GraphNode>): BM25Index {
  const docs: DocEntry[] = [];

  for (const node of Object.values(nodes)) {
    if (!isClassified(node)) continue;
    const tokens = tokenize(`${node.name} ${node.description}`);
    const counts: Record<string, number> = {};
    for (const t of tokens) counts[t] = (counts[t] || 0) + 1;
    docs.push({ id: node.id, tokens: counts, len: tokens.length });
  }

  const N = docs.length;
  const avgDocLen = N > 0 ? docs.reduce((s, d) => s + d.len, 0) / N : 0;

  const df: Record<string, number> = {};
  for (const doc of docs) {
    for (const term of Object.keys(doc.tokens)) {
      df[term] = (df[term] || 0) + 1;
    }
  }

  const vocabulary: Record<string, VocabEntry> = {};
  for (const [term, dfVal] of Object.entries(df)) {
    vocabulary[term] = {
      idf: Math.log((N - dfVal + 0.5) / (dfVal + 0.5) + 1),
      df: dfVal,
    };
  }

  return { builtAt: new Date().toISOString(), docCount: N, avgDocLen, vocabulary, docs };
}

export function propagateFromNeighbors(
  nodes: Record<string, GraphNode>,
  edges: GraphEdge[],
): number {
  const adj = new Map<string, { nodeId: string; weight: number }[]>();
  for (const edge of edges) {
    const w = EDGE_WEIGHTS[edge.relationship] ?? 0;
    if (w === 0) continue;
    if (!adj.has(edge.from)) adj.set(edge.from, []);
    if (!adj.has(edge.to)) adj.set(edge.to, []);
    adj.get(edge.from)!.push({ nodeId: edge.to, weight: w });
    adj.get(edge.to)!.push({ nodeId: edge.from, weight: w });
  }

  let total = 0;
  let changed = true;
  let rounds = 10;

  while (changed && rounds-- > 0) {
    changed = false;
    for (const node of Object.values(nodes)) {
      if (isClassified(node)) continue;

      const neighbors = adj.get(node.id) || [];
      const votes: Record<string, number> = {};
      let classifiedCount = 0;

      for (const { nodeId, weight } of neighbors) {
        const n = nodes[nodeId];
        if (!n || !isClassified(n)) continue;
        classifiedCount++;
        for (const d of n.domains) {
          votes[d] = (votes[d] || 0) + weight;
        }
      }

      if (classifiedCount < 2) continue;

      const best = Object.entries(votes)
        .filter(([d]) => isValidDomain(d))
        .sort((a, b) => b[1] - a[1]);

      if (best.length > 0 && best[0][1] >= 2) {
        node.domains = [best[0][0]];
        node.domainSource = "propagation";
        total++;
        changed = true;
      }
    }
  }

  return total;
}

export function inferFromBM25(nodes: Record<string, GraphNode>): number {
  const index = buildClassifiedIndex(nodes);
  if (index.docCount === 0) return 0;

  let count = 0;
  for (const node of Object.values(nodes)) {
    if (isClassified(node)) continue;

    const query = `${node.name} ${node.description}`;
    const results = searchIndex(index, query, 5);
    if (results.length < 3) continue;

    const top3Domains = results
      .slice(0, 3)
      .map(r => nodes[r.id]?.domains[0])
      .filter(Boolean) as string[];
    if (top3Domains.length < 3) continue;

    const domainCounts: Record<string, number> = {};
    for (const d of top3Domains) domainCounts[d] = (domainCounts[d] || 0) + 1;

    const majority = Object.entries(domainCounts).find(([, c]) => c >= 2);
    if (majority && isValidDomain(majority[0])) {
      node.domains = [majority[0]];
      node.domainSource = "bm25";
      count++;
    }
  }

  return count;
}

export function propagateDomains(
  nodes: Record<string, GraphNode>,
  edges: GraphEdge[],
): number {
  const fromNeighbors = propagateFromNeighbors(nodes, edges);
  const fromBM25 = inferFromBM25(nodes);
  return fromNeighbors + fromBM25;
}
