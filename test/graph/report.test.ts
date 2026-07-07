import { describe, test, expect } from "bun:test";
import type { Graph } from "../../src/graph/types";
import type { GraphNode, GraphEdge } from "../../src/adapters/types";

function makeNode(id: string, domains: string[] = ["verification"], severity: number = 3): GraphNode {
  return {
    id,
    file: `${id}.md`,
    type: "rule",
    name: id.replace(/-/g, " "),
    description: `Description of ${id}`,
    domains,
    severity,
    occurrence_count: 5,
    last_updated: "2026-07-07T00:00:00Z",
    content_hash: "abc123",
    memoryType: "behavioral-rule",
  };
}

function makeEdge(from: string, to: string, relationship: string = "same_domain", strength: number = 0.5): GraphEdge {
  return { from, to, relationship: relationship as GraphEdge["relationship"], strength };
}

function makeGraph(overrides: Partial<Graph> = {}): Graph {
  const nodes: Record<string, GraphNode> = {
    "verify-before-assert": makeNode("verify-before-assert", ["verification"]),
    "read-source-first": makeNode("read-source-first", ["verification"]),
    "delegate-to-marcus": makeNode("delegate-to-marcus", ["delegation"]),
    "never-force-push": makeNode("never-force-push", ["security"]),
    "isolated-node": makeNode("isolated-node", ["data"]),
  };

  const edges: GraphEdge[] = [
    makeEdge("verify-before-assert", "read-source-first", "reinforces", 0.8),
    makeEdge("verify-before-assert", "delegate-to-marcus", "same_domain", 0.5),
    makeEdge("read-source-first", "never-force-push", "sibling", 0.3),
  ];

  return {
    version: "1.0",
    builtAt: "2026-07-07T00:00:00Z",
    nodeCount: Object.keys(nodes).length,
    edgeCount: edges.length,
    nodes,
    edges,
    ...overrides,
  };
}

describe("generateReport", () => {
  test("produces correct health metrics", async () => {
    const { generateReport } = await import("../../src/graph/report");
    const graph = makeGraph();
    const report = generateReport(graph);

    expect(report.health.nodeCount).toBe(5);
    expect(report.health.edgeCount).toBe(3);
    expect(report.health.isolatedCount).toBe(1);
    expect(report.health.edgeDensity).toBeCloseTo(0.6, 1);
    expect(report.health.version).toBe("1.0");
  });

  test("computes domain distribution", async () => {
    const { generateReport } = await import("../../src/graph/report");
    const report = generateReport(makeGraph());

    const verificationCount = report.domainDistribution.find((d) => d.domain === "verification");
    expect(verificationCount?.count).toBe(2);

    const delegationCount = report.domainDistribution.find((d) => d.domain === "delegation");
    expect(delegationCount?.count).toBe(1);
  });

  test("computes edge type breakdown", async () => {
    const { generateReport } = await import("../../src/graph/report");
    const report = generateReport(makeGraph());

    const sameDomain = report.edgeTypeBreakdown.find((e) => e.relationship === "same_domain");
    expect(sameDomain?.count).toBe(1);

    const reinforces = report.edgeTypeBreakdown.find((e) => e.relationship === "reinforces");
    expect(reinforces?.count).toBe(1);
  });

  test("finds conflicts", async () => {
    const { generateReport } = await import("../../src/graph/report");

    const graph = makeGraph();
    graph.edges.push(makeEdge("verify-before-assert", "never-force-push", "conflicts_with", 0.7));
    graph.edgeCount = graph.edges.length;

    const report = generateReport(graph);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0].strength).toBeCloseTo(0.7, 1);
  });

  test("identifies isolated nodes", async () => {
    const { generateReport } = await import("../../src/graph/report");
    const report = generateReport(makeGraph());

    expect(report.coverage.isolatedCount).toBe(1);
    expect(report.coverage.isolatedByDomain).toHaveProperty("data");
    expect(report.coverage.isolatedByDomain["data"]).toContain("isolated node");
  });

  test("identifies thin domains", async () => {
    const { generateReport } = await import("../../src/graph/report");
    const report = generateReport(makeGraph());

    const thin = report.coverage.thinDomains;
    const dataDomain = thin.find((d) => d.domain === "data");
    expect(dataDomain).toBeDefined();
    expect(dataDomain!.count).toBe(1);
  });

  test("handles empty graph", async () => {
    const { generateReport } = await import("../../src/graph/report");
    const emptyGraph: Graph = {
      version: "1.0",
      builtAt: "2026-07-07T00:00:00Z",
      nodeCount: 0,
      edgeCount: 0,
      nodes: {},
      edges: [],
    };

    const report = generateReport(emptyGraph);
    expect(report.health.nodeCount).toBe(0);
    expect(report.health.edgeDensity).toBe(0);
    expect(report.coverage.connectedPercent).toBe(0);
  });
});

describe("formatReportMarkdown", () => {
  test("produces markdown with all sections", async () => {
    const { generateReport, formatReportMarkdown } = await import("../../src/graph/report");
    const report = generateReport(makeGraph());
    const md = formatReportMarkdown(report);

    expect(md).toContain("# Knowledge Graph");
    expect(md).toContain("## Section 1: Graph Health");
    expect(md).toContain("## Section 2: Coverage Analysis");
    expect(md).toContain("### Domain Distribution");
    expect(md).toContain("### Edge Type Breakdown");
    expect(md).toContain("verification");
  });

  test("shows conflicts when present", async () => {
    const { generateReport, formatReportMarkdown } = await import("../../src/graph/report");

    const graph = makeGraph();
    graph.edges.push(makeEdge("verify-before-assert", "never-force-push", "conflicts_with", 0.9));
    graph.edgeCount = graph.edges.length;

    const report = generateReport(graph);
    const md = formatReportMarkdown(report);

    expect(md).toContain("verify before assert");
    expect(md).toContain("never force push");
  });

  test("shows none found when no conflicts", async () => {
    const { generateReport, formatReportMarkdown } = await import("../../src/graph/report");
    const report = generateReport(makeGraph());
    const md = formatReportMarkdown(report);

    expect(md).toContain("_None found_");
  });
});
