import { readGraph, DOMAINS } from "./builder";
import { queryGraph } from "./query";
import type { Graph } from "./types";
import type { GraphNode, GraphEdge } from "../adapters/types";

export interface GraphHealthMetrics {
  nodeCount: number;
  edgeCount: number;
  isolatedCount: number;
  edgeDensity: number;
  builtAt: string;
  version: string;
}

export interface DomainCount {
  domain: string;
  count: number;
}

export interface EdgeTypeCount {
  relationship: string;
  count: number;
}

export interface CoverageMetrics {
  connectedCount: number;
  connectedPercent: number;
  isolatedCount: number;
  isolatedPercent: number;
  thinDomains: DomainCount[];
  isolatedByDomain: Record<string, string[]>;
}

export interface GraphReport {
  timestamp: string;
  health: GraphHealthMetrics;
  domainDistribution: DomainCount[];
  edgeTypeBreakdown: EdgeTypeCount[];
  conflicts: Array<{ from: string; to: string; strength: number }>;
  coverage: CoverageMetrics;
}

// ── Helpers ──

function domainDistribution(nodes: Record<string, GraphNode>): DomainCount[] {
  const counts: Record<string, number> = {};
  for (const node of Object.values(nodes)) {
    for (const d of node.domains) {
      counts[d] = (counts[d] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([domain, count]) => ({ domain, count }));
}

function edgeTypeBreakdown(edges: GraphEdge[]): EdgeTypeCount[] {
  const counts: Record<string, number> = {};
  for (const edge of edges) {
    counts[edge.relationship] = (counts[edge.relationship] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([relationship, count]) => ({ relationship, count }));
}

function findIsolatedNodes(graph: Graph): string[] {
  const connectedIds = new Set(graph.edges.flatMap((e) => [e.from, e.to]));
  return Object.keys(graph.nodes).filter((id) => !connectedIds.has(id));
}

function findConflicts(graph: Graph): Array<{ from: string; to: string; strength: number }> {
  return graph.edges
    .filter((e) => e.relationship === "conflicts_with")
    .map((e) => ({
      from: graph.nodes[e.from]?.name || e.from,
      to: graph.nodes[e.to]?.name || e.to,
      strength: e.strength,
    }));
}

// ── Report Generation ──

export function generateReport(graph?: Graph): GraphReport {
  const g = graph ?? readGraph();

  const isolated = findIsolatedNodes(g);
  const domains = domainDistribution(g.nodes);
  const edgeTypes = edgeTypeBreakdown(g.edges);
  const conflicts = findConflicts(g);

  const connectedCount = g.nodeCount - isolated.length;
  const thinDomains = domains.filter((d) => d.count < 3);

  const isolatedByDomain: Record<string, string[]> = {};
  for (const id of isolated) {
    const node = g.nodes[id];
    if (!node) continue;
    for (const d of node.domains) {
      if (!isolatedByDomain[d]) isolatedByDomain[d] = [];
      isolatedByDomain[d].push(node.name);
    }
  }

  return {
    timestamp: new Date().toISOString(),
    health: {
      nodeCount: g.nodeCount,
      edgeCount: g.edgeCount,
      isolatedCount: isolated.length,
      edgeDensity: g.nodeCount > 0 ? g.edgeCount / g.nodeCount : 0,
      builtAt: g.builtAt,
      version: g.version,
    },
    domainDistribution: domains,
    edgeTypeBreakdown: edgeTypes,
    conflicts,
    coverage: {
      connectedCount,
      connectedPercent: g.nodeCount > 0
        ? Math.round((connectedCount / g.nodeCount) * 100)
        : 0,
      isolatedCount: isolated.length,
      isolatedPercent: g.nodeCount > 0
        ? Math.round((isolated.length / g.nodeCount) * 100)
        : 0,
      thinDomains,
      isolatedByDomain,
    },
  };
}

// ── Markdown Formatter ──

function padRight(str: string, n: number): string {
  return str.length >= n ? str : str + " ".repeat(n - str.length);
}

export function formatReportMarkdown(report: GraphReport): string {
  const sections: string[] = [];

  sections.push(
    "# Knowledge Graph — Effectiveness Report",
    "",
    `*Generated: ${report.timestamp}*`,
    `*Graph built: ${report.health.builtAt}*`,
    "",
  );

  // Section 1: Health
  sections.push(
    "## Section 1: Graph Health",
    "",
    "| Metric | Value |",
    "|--------|-------|",
    `| Nodes | ${report.health.nodeCount} |`,
    `| Edges | ${report.health.edgeCount} |`,
    `| Isolated nodes | ${report.health.isolatedCount} |`,
    `| Edge density (edges/nodes) | ${report.health.edgeDensity.toFixed(2)} |`,
    `| Built at | ${report.health.builtAt} |`,
    `| Version | ${report.health.version} |`,
    "",
  );

  // Domain distribution
  if (report.domainDistribution.length > 0) {
    sections.push(
      "### Domain Distribution",
      "",
      "| Domain | Node Count |",
      "|--------|-----------|",
    );
    for (const { domain, count } of report.domainDistribution) {
      sections.push(`| ${padRight(domain, 20)} | ${count} |`);
    }
    sections.push("");
  }

  // Edge type breakdown
  if (report.edgeTypeBreakdown.length > 0) {
    sections.push(
      "### Edge Type Breakdown",
      "",
      "| Relationship Type | Count |",
      "|------------------|-------|",
    );
    for (const { relationship, count } of report.edgeTypeBreakdown) {
      sections.push(`| ${padRight(relationship, 25)} | ${count} |`);
    }
    sections.push("");
  }

  // Conflicts
  sections.push("### Conflicts");
  sections.push("");
  if (report.conflicts.length > 0) {
    for (const c of report.conflicts) {
      sections.push(`- **${c.from}** -> **${c.to}** (strength: ${c.strength.toFixed(1)})`);
    }
  } else {
    sections.push("_None found_");
  }
  sections.push("");

  // Section 2: Coverage
  sections.push(
    "## Section 2: Coverage Analysis",
    "",
    "### Connection Status",
    "",
    "| Status | Count | Percent |",
    "|--------|-------|---------|",
    `| Connected (>=1 edge) | ${report.coverage.connectedCount} | ${report.coverage.connectedPercent}% |`,
    `| Isolated (no edges) | ${report.coverage.isolatedCount} | ${report.coverage.isolatedPercent}% |`,
    "",
  );

  if (report.coverage.thinDomains.length > 0) {
    sections.push("### Thin Domains (< 3 nodes)", "");
    for (const { domain, count } of report.coverage.thinDomains) {
      sections.push(`- **${domain}** — ${count} node${count !== 1 ? "s" : ""}`);
    }
    sections.push("");
  }

  const isolatedDomains = Object.entries(report.coverage.isolatedByDomain);
  if (isolatedDomains.length > 0) {
    sections.push("### Isolated Nodes by Domain", "");
    for (const [domain, names] of isolatedDomains) {
      sections.push(`**${domain}:**`);
      for (const name of names) {
        sections.push(`  - ${name}`);
      }
      sections.push("");
    }
  }

  return sections.join("\n");
}
