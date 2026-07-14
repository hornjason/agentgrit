import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { GraphNode } from "../../src/adapters/types";
import type { Graph } from "../../src/graph/types";
import { DOMAINS, writeGraphFile } from "../../src/graph/builder";

function makeNode(id: string, domains: string[], overrides?: Partial<GraphNode>): GraphNode {
  return {
    id,
    file: `${id}.md`,
    type: "rule",
    name: id.replace(/_/g, "-"),
    description: `Description for ${id}`,
    domains,
    severity: 3,
    occurrence_count: 0,
    last_updated: new Date().toISOString(),
    content_hash: "abc",
    memoryType: "behavioral-rule",
    ...overrides,
  };
}

function makeGraph(nodes: Record<string, GraphNode>, edges: Graph["edges"] = []): Graph {
  return {
    version: "1.0",
    builtAt: new Date().toISOString(),
    nodeCount: Object.keys(nodes).length,
    edgeCount: edges.length,
    nodes,
    edges,
  };
}

const mockInference = mock(() =>
  Promise.resolve({
    success: true,
    output: '{"domains": ["verification"]}',
    parsed: { domains: ["verification"] },
    latencyMs: 100,
    level: "fast" as const,
    provider: "claude" as const,
  }),
);

mock.module("../../src/adapters/inference", () => ({
  inference: mockInference,
}));

mock.module("../../src/graph/builder", () => ({
  DOMAINS,
  writeGraphFile: mock(() => {}),
}));

describe("classifyIsolatedNodes", () => {
  beforeEach(() => {
    mockInference.mockClear();
    mockInference.mockImplementation(() =>
      Promise.resolve({
        success: true,
        output: '{"domains": ["verification"]}',
        parsed: { domains: ["verification"] },
        latencyMs: 100,
        level: "fast" as const,
        provider: "claude" as const,
      }),
    );
  });

  test("classifies isolated nodes (zero edges, zero domains)", async () => {
    const { classifyIsolatedNodes } = await import("../../src/graph/classify-isolated");

    const nodes: Record<string, GraphNode> = {
      classified: makeNode("classified", ["verification"]),
      connected: makeNode("connected", []),
      isolated: makeNode("isolated", []),
    };
    const graph = makeGraph(nodes, [
      { from: "classified", to: "connected", relationship: "co_occurred", strength: 0.5 },
    ]);

    const results = await classifyIsolatedNodes(graph, { dryRun: true });

    expect(results.length).toBe(1);
    expect(results[0].nodeId).toBe("isolated");
    expect(results[0].domains).toEqual(["verification"]);
    expect(results[0].source).toBe("ai");
    expect(mockInference).toHaveBeenCalledTimes(1);
  });

  test("skips nodes that already have domains", async () => {
    const { classifyIsolatedNodes } = await import("../../src/graph/classify-isolated");

    const nodes: Record<string, GraphNode> = {
      a: makeNode("a", ["scope"]),
      b: makeNode("b", ["delivery"]),
    };
    const graph = makeGraph(nodes);

    const results = await classifyIsolatedNodes(graph, { dryRun: true });

    expect(results.length).toBe(0);
    expect(mockInference).not.toHaveBeenCalled();
  });

  test("skips nodes that have edges even with empty domains", async () => {
    const { classifyIsolatedNodes } = await import("../../src/graph/classify-isolated");

    const nodes: Record<string, GraphNode> = {
      a: makeNode("a", ["verification"]),
      has_edges: makeNode("has_edges", []),
    };
    const graph = makeGraph(nodes, [
      { from: "a", to: "has_edges", relationship: "co_occurred", strength: 0.5 },
    ]);

    const results = await classifyIsolatedNodes(graph, { dryRun: true });

    expect(results.length).toBe(0);
  });

  test("respects maxNodes limit", async () => {
    const { classifyIsolatedNodes } = await import("../../src/graph/classify-isolated");

    const nodes: Record<string, GraphNode> = {};
    for (let i = 0; i < 10; i++) {
      nodes[`iso_${i}`] = makeNode(`iso_${i}`, []);
    }
    const graph = makeGraph(nodes);

    const results = await classifyIsolatedNodes(graph, { maxNodes: 3, dryRun: true });

    expect(results.length).toBe(3);
    expect(mockInference).toHaveBeenCalledTimes(3);
  });

  test("returns empty when no isolated nodes", async () => {
    const { classifyIsolatedNodes } = await import("../../src/graph/classify-isolated");

    const nodes: Record<string, GraphNode> = {
      a: makeNode("a", ["verification"]),
      b: makeNode("b", ["scope"]),
    };
    const graph = makeGraph(nodes, [
      { from: "a", to: "b", relationship: "same_domain", strength: 0.5 },
    ]);

    const results = await classifyIsolatedNodes(graph);

    expect(results.length).toBe(0);
    expect(mockInference).not.toHaveBeenCalled();
  });

  test("handles inference failure gracefully", async () => {
    const { classifyIsolatedNodes } = await import("../../src/graph/classify-isolated");

    mockInference.mockImplementation(() =>
      Promise.resolve({
        success: false,
        output: "",
        error: "timeout",
        latencyMs: 15000,
        level: "fast" as const,
        provider: "claude" as const,
      }),
    );

    const nodes: Record<string, GraphNode> = {
      isolated: makeNode("isolated", []),
    };
    const graph = makeGraph(nodes);

    const results = await classifyIsolatedNodes(graph, { dryRun: true });

    expect(results.length).toBe(0);
  });

  test("filters invalid domains from LLM response", async () => {
    const { classifyIsolatedNodes } = await import("../../src/graph/classify-isolated");

    mockInference.mockImplementation(() =>
      Promise.resolve({
        success: true,
        output: '{"domains": ["verification", "not-a-real-domain"]}',
        parsed: { domains: ["verification", "not-a-real-domain"] },
        latencyMs: 100,
        level: "fast" as const,
        provider: "claude" as const,
      }),
    );

    const nodes: Record<string, GraphNode> = {
      isolated: makeNode("isolated", []),
    };
    const graph = makeGraph(nodes);

    const results = await classifyIsolatedNodes(graph, { dryRun: true });

    expect(results.length).toBe(1);
    expect(results[0].domains).toEqual(["verification"]);
  });

  test("sets domainSource to 'ai' on classified nodes when not dryRun", async () => {
    const { classifyIsolatedNodes } = await import("../../src/graph/classify-isolated");

    const nodes: Record<string, GraphNode> = {
      isolated: makeNode("isolated", []),
    };
    const graph = makeGraph(nodes);

    await classifyIsolatedNodes(graph, { dryRun: false });

    expect(nodes.isolated.domains).toEqual(["verification"]);
    expect(nodes.isolated.domainSource).toBe("ai");
  });
});
