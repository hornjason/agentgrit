import { describe, test, expect } from "bun:test";
import { queryGraph } from "../../src/graph/query";
import type { Graph } from "../../src/graph/types";
import type { GraphNode, GraphNodeStats } from "../../src/adapters/types";

function makeStats(overrides?: Partial<GraphNodeStats>): GraphNodeStats {
  return {
    injectionCount: 0,
    avgRating: 0,
    highRatingActivations: 0,
    lowRatingActivations: 0,
    sessionRatings: [],
    lastSeen: new Date().toISOString(),
    ...overrides,
  };
}

function makeNode(id: string, domains: string[], statsOverrides?: Partial<GraphNodeStats>): GraphNode {
  return {
    id,
    name: `Rule: ${id}`,
    domains,
    ruleText: `Text for ${id}`,
    hash: id.slice(0, 8),
    stats: makeStats(statsOverrides),
  };
}

function makeGraph(nodes: GraphNode[], edges: Graph["edges"] = []): Graph {
  const nodeMap: Record<string, GraphNode> = {};
  for (const n of nodes) nodeMap[n.id] = n;
  return {
    version: "1.0",
    builtAt: new Date().toISOString(),
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes: nodeMap,
    edges,
  };
}

describe("queryGraph", () => {
  test("returns empty for empty graph", () => {
    const graph = makeGraph([]);
    const result = queryGraph(graph, ["verification"]);
    expect(result).toEqual([]);
  });

  test("returns matching domain nodes", () => {
    const graph = makeGraph([
      makeNode("a", ["verification"]),
      makeNode("b", ["deployment"]),
      makeNode("c", ["verification", "scope"]),
    ]);

    const result = queryGraph(graph, ["verification"]);
    expect(result.length).toBeGreaterThan(0);
    const ids = result.map(r => r.primary.id);
    expect(ids).toContain("a");
    expect(ids).toContain("c");
    expect(ids).not.toContain("b");
  });

  test("respects limit", () => {
    const nodes = Array.from({ length: 20 }, (_, i) =>
      makeNode(`node-${i}`, ["verification"]),
    );
    const graph = makeGraph(nodes);

    const result = queryGraph(graph, ["verification"], 5);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  test("ranks nodes with better domain match higher", () => {
    const graph = makeGraph([
      makeNode("exact", ["verification", "scope"]),
      makeNode("partial", ["verification"]),
    ]);

    const result = queryGraph(graph, ["verification", "scope"]);
    expect(result.length).toBe(2);
    expect(result[0].primary.id).toBe("exact");
  });

  test("includes connected nodes in clusters", () => {
    const graph = makeGraph(
      [
        makeNode("primary", ["verification"]),
        makeNode("sibling", ["verification"]),
      ],
      [
        { source: "primary", target: "sibling", type: "reinforces", strength: 0.8 },
      ],
    );

    const result = queryGraph(graph, ["verification"]);
    expect(result.length).toBe(1);
    expect(result[0].primary.id).toBe("primary");
    expect(result[0].connected.length).toBe(1);
    expect(result[0].connected[0].node.id).toBe("sibling");
  });

  test("deduplicates nodes across clusters", () => {
    const graph = makeGraph(
      [
        makeNode("a", ["verification"]),
        makeNode("b", ["verification"]),
      ],
      [
        { source: "a", target: "b", type: "same_domain", strength: 0.5 },
      ],
    );

    const result = queryGraph(graph, ["verification"]);
    const allIds = result.flatMap(c => [c.primary.id, ...c.connected.map(cn => cn.node.id)]);
    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(allIds.length);
  });

  test("handles multi-domain query", () => {
    const graph = makeGraph([
      makeNode("deploy-verify", ["deployment", "verification"]),
      makeNode("scope-only", ["scope"]),
      makeNode("deploy-only", ["deployment"]),
    ]);

    const result = queryGraph(graph, ["deployment", "verification"]);
    expect(result[0].primary.id).toBe("deploy-verify");
  });

  test("returns all nodes when no domains specified", () => {
    const graph = makeGraph([
      makeNode("a", ["verification"]),
      makeNode("b", ["deployment"]),
    ]);

    const result = queryGraph(graph, []);
    expect(result.length).toBe(2);
  });

  test("score reflects edge connectivity", () => {
    const graph = makeGraph(
      [
        makeNode("connected", ["verification"]),
        makeNode("isolated", ["verification"]),
        makeNode("helper", ["verification"]),
      ],
      [
        { source: "connected", target: "helper", type: "reinforces", strength: 0.9 },
      ],
    );

    const result = queryGraph(graph, ["verification"]);
    const connectedCluster = result.find(c => c.primary.id === "connected");
    const isolatedCluster = result.find(c => c.primary.id === "isolated");

    expect(connectedCluster).toBeDefined();
    expect(isolatedCluster).toBeDefined();
    expect(connectedCluster!.score).toBeGreaterThan(isolatedCluster!.score);
  });
});
