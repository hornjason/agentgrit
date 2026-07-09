import type { GraphNode, GraphEdge } from "../adapters/types";
import type { Graph, RankedCluster, ConnectedNode } from "./types";

// ── Scoring ──

function scoreNode(
  node: GraphNode,
  queryDomains: string[],
  edges: GraphEdge[],
  allNodes: Record<string, GraphNode>,
): number {
  // Domain overlap (precision-only: overlap / query size)
  const overlap = node.domains.filter(d => queryDomains.includes(d)).length;
  const domainScore = overlap > 0 ? overlap / queryDomains.length : 0;

  // Blended edge strength: domain-filtered (70%) + total (30%)
  const nodeEdges = edges.filter(e => e.from === node.id || e.to === node.id);
  const totalEdgeStrength = nodeEdges.length > 0
    ? nodeEdges.reduce((sum, e) => sum + e.strength, 0) / nodeEdges.length
    : 0;

  let domainEdgeStrength = 0;
  if (nodeEdges.length > 0 && queryDomains.length > 0) {
    const relevantEdges = nodeEdges.filter(e => {
      const neighborId = e.from === node.id ? e.to : e.from;
      const neighbor = allNodes[neighborId];
      return neighbor && neighbor.domains.some(d => queryDomains.includes(d));
    });
    domainEdgeStrength = relevantEdges.length > 0
      ? relevantEdges.reduce((sum, e) => sum + e.strength, 0) / relevantEdges.length
      : 0;
  }
  const blendedEdge = domainEdgeStrength * 0.7 + totalEdgeStrength * 0.3;

  // Severity (normalized to 0-1, severity 1-5 scale)
  const severityScore = node.severity >= 3 ? 1 : 0.5;

  return domainScore * 0.50 + blendedEdge * 0.30 + severityScore * 0.20;
}

// ── Cluster Builder ──

const CLUSTER_RELS = new Set(["reinforces", "sibling", "caused_by_same_root", "same_domain", "co_occurred"]);

function buildCluster(
  primary: GraphNode,
  edges: GraphEdge[],
  allNodes: Record<string, GraphNode>,
): ConnectedNode[] {
  const connected: ConnectedNode[] = [];

  for (const edge of edges) {
    if (!CLUSTER_RELS.has(edge.relationship)) continue;

    let connectedId: string | null = null;
    if (edge.from === primary.id) connectedId = edge.to;
    else if (edge.to === primary.id) connectedId = edge.from;
    else continue;

    const node = allNodes[connectedId];
    if (!node) continue;

    connected.push({
      node,
      relationship: edge.relationship,
      strength: edge.strength,
    });
  }

  return connected.sort((a, b) => b.strength - a.strength);
}

// ── Query ──

export function queryGraph(
  graph: Graph,
  domains: string[],
  limit: number = 10,
): RankedCluster[] {
  if (graph.nodeCount === 0) return [];

  const nodes = Object.values(graph.nodes);

  // Filter to nodes with at least one matching domain
  const candidates = domains.length > 0
    ? nodes.filter(n => n.domains.some(d => domains.includes(d)))
    : nodes;

  // 1-hop expansion via embedding edges
  if (domains.length > 0) {
    const candidateIds = new Set(candidates.map(n => n.id));
    for (const node of [...candidates]) {
      const embeddingEdges = graph.edges.filter(
        e => e.source === "embedding" && e.strength >= 0.6 &&
             (e.from === node.id || e.to === node.id),
      );
      for (const edge of embeddingEdges) {
        const neighborId = edge.from === node.id ? edge.to : edge.from;
        if (!candidateIds.has(neighborId) && graph.nodes[neighborId]) {
          candidates.push(graph.nodes[neighborId]);
          candidateIds.add(neighborId);
        }
      }
    }
  }

  // Score and sort
  const scored = candidates.map(node => ({
    node,
    score: scoreNode(node, domains, graph.edges, graph.nodes),
  }));
  scored.sort((a, b) => b.score - a.score);

  // Build clusters (deduplicate)
  const seen = new Set<string>();
  const clusters: RankedCluster[] = [];

  for (const { node, score } of scored) {
    if (clusters.length >= limit) break;
    if (seen.has(node.id)) continue;

    const connected = buildCluster(node, graph.edges, graph.nodes);
    clusters.push({
      primary: node,
      connected,
      score,
      domains: node.domains,
    });

    seen.add(node.id);
    for (const c of connected) seen.add(c.node.id);
  }

  return clusters;
}
