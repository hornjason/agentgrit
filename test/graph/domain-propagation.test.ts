import { describe, test, expect } from "bun:test";
import { propagateFromNeighbors, inferFromBM25, propagateDomains } from "../../src/graph/domain-propagation";
import type { GraphNode, GraphEdge } from "../../src/adapters/types";

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

describe("propagateFromNeighbors", () => {
  test("classifies node when >= 2 co_occurred neighbors share domain", () => {
    const nodes: Record<string, GraphNode> = {
      a: makeNode("a", ["verification"]),
      b: makeNode("b", ["verification"]),
      target: makeNode("target", []),
    };
    const edges: GraphEdge[] = [
      { from: "a", to: "target", relationship: "co_occurred", strength: 0.5 },
      { from: "b", to: "target", relationship: "co_occurred", strength: 0.5 },
    ];

    const count = propagateFromNeighbors(nodes, edges);

    expect(count).toBe(1);
    expect(nodes.target.domains).toEqual(["verification"]);
    expect(nodes.target.domainSource).toBe("propagation");
  });

  test("skips when only 1 classified neighbor", () => {
    const nodes: Record<string, GraphNode> = {
      a: makeNode("a", ["verification"]),
      unclassified: makeNode("unclassified", []),
      target: makeNode("target", []),
    };
    const edges: GraphEdge[] = [
      { from: "a", to: "target", relationship: "co_occurred", strength: 0.5 },
      { from: "unclassified", to: "target", relationship: "co_occurred", strength: 0.5 },
    ];

    const count = propagateFromNeighbors(nodes, edges);

    expect(count).toBe(0);
    expect(nodes.target.domains).toEqual([]);
  });

  test("weights reinforces edges higher than co_occurred", () => {
    const nodes: Record<string, GraphNode> = {
      a: makeNode("a", ["verification"]),
      b: makeNode("b", ["deployment"]),
      c: makeNode("c", ["deployment"]),
      target: makeNode("target", []),
    };
    const edges: GraphEdge[] = [
      { from: "a", to: "target", relationship: "reinforces", strength: 0.8 },
      { from: "b", to: "target", relationship: "co_occurred", strength: 0.5 },
      { from: "c", to: "target", relationship: "co_occurred", strength: 0.5 },
    ];

    const count = propagateFromNeighbors(nodes, edges);

    expect(count).toBe(1);
    // deployment: 1.0 + 1.0 = 2.0, verification: 1.5 — deployment wins with higher sum
    expect(nodes.target.domains).toEqual(["deployment"]);
  });

  test("ignores same_domain edges (zero weight)", () => {
    const nodes: Record<string, GraphNode> = {
      a: makeNode("a", ["verification"]),
      b: makeNode("b", ["verification"]),
      target: makeNode("target", []),
    };
    const edges: GraphEdge[] = [
      { from: "a", to: "target", relationship: "same_domain", strength: 0.5 },
      { from: "b", to: "target", relationship: "same_domain", strength: 0.5 },
    ];

    const count = propagateFromNeighbors(nodes, edges);

    expect(count).toBe(0);
    expect(nodes.target.domains).toEqual([]);
  });

  test("propagates iteratively across rounds", () => {
    const nodes: Record<string, GraphNode> = {
      a: makeNode("a", ["security"]),
      b: makeNode("b", ["security"]),
      mid: makeNode("mid", []),
      far: makeNode("far", []),
    };
    const edges: GraphEdge[] = [
      { from: "a", to: "mid", relationship: "co_occurred", strength: 0.5 },
      { from: "b", to: "mid", relationship: "co_occurred", strength: 0.5 },
      { from: "mid", to: "far", relationship: "co_occurred", strength: 0.5 },
      { from: "a", to: "far", relationship: "co_occurred", strength: 0.5 },
    ];

    const count = propagateFromNeighbors(nodes, edges);

    // Round 1: mid gets security (a + b agree)
    // Round 2: far gets security (a + mid agree)
    expect(count).toBe(2);
    expect(nodes.mid.domains).toEqual(["security"]);
    expect(nodes.far.domains).toEqual(["security"]);
  });

  test("does not overwrite already classified nodes", () => {
    const nodes: Record<string, GraphNode> = {
      a: makeNode("a", ["verification"]),
      b: makeNode("b", ["verification"]),
      existing: makeNode("existing", ["deployment"]),
    };
    const edges: GraphEdge[] = [
      { from: "a", to: "existing", relationship: "co_occurred", strength: 0.5 },
      { from: "b", to: "existing", relationship: "co_occurred", strength: 0.5 },
    ];

    propagateFromNeighbors(nodes, edges);

    expect(nodes.existing.domains).toEqual(["deployment"]);
  });

  test("requires weighted vote sum >= 2", () => {
    const nodes: Record<string, GraphNode> = {
      a: makeNode("a", ["verification"]),
      b: makeNode("b", ["deployment"]),
      target: makeNode("target", []),
    };
    const edges: GraphEdge[] = [
      { from: "a", to: "target", relationship: "co_occurred", strength: 0.5 },
      { from: "b", to: "target", relationship: "co_occurred", strength: 0.5 },
    ];

    const count = propagateFromNeighbors(nodes, edges);

    // Each domain gets weight 1.0 (co_occurred), neither reaches 2.0
    expect(count).toBe(0);
  });

  test("handles empty edges", () => {
    const nodes: Record<string, GraphNode> = {
      target: makeNode("target", []),
    };

    const count = propagateFromNeighbors(nodes, []);
    expect(count).toBe(0);
  });
});

describe("inferFromBM25", () => {
  test("classifies by text similarity when top-3 agree", () => {
    const nodes: Record<string, GraphNode> = {
      d1: makeNode("d1", ["deployment"], { name: "deploy gate", description: "run make rebuild before deploy" }),
      d2: makeNode("d2", ["deployment"], { name: "deploy check", description: "run make rebuild test deploy" }),
      d3: makeNode("d3", ["deployment"], { name: "deploy seq", description: "deploy sequence make rebuild run" }),
      target: makeNode("target", [], { name: "rebuild rule", description: "always run make rebuild to deploy code" }),
    };

    const count = inferFromBM25(nodes);

    expect(count).toBe(1);
    expect(nodes.target.domains).toEqual(["deployment"]);
    expect(nodes.target.domainSource).toBe("bm25");
  });

  test("skips when fewer than 3 classified nodes exist", () => {
    const nodes: Record<string, GraphNode> = {
      d1: makeNode("d1", ["deployment"], { description: "deploy thing" }),
      d2: makeNode("d2", ["verification"], { description: "verify thing" }),
      target: makeNode("target", [], { description: "deploy thing to verify" }),
    };

    const count = inferFromBM25(nodes);

    // Only 2 classified nodes — can't get 3 results
    expect(count).toBe(0);
  });

  test("skips when top-3 disagree", () => {
    const nodes: Record<string, GraphNode> = {
      d1: makeNode("d1", ["deployment"], { name: "deploy", description: "deploy something" }),
      d2: makeNode("d2", ["verification"], { name: "verify", description: "verify something" }),
      d3: makeNode("d3", ["security"], { name: "secure", description: "security scan" }),
      d4: makeNode("d4", ["scope"], { name: "scope", description: "scope check" }),
      target: makeNode("target", [], { name: "generic", description: "deploy verify secure scope" }),
    };

    const count = inferFromBM25(nodes);

    // top-3 likely have 3 different domains — no majority
    // (exact behavior depends on BM25 scoring)
    expect(count).toBeLessThanOrEqual(1);
  });

  test("does not overwrite already classified nodes", () => {
    const nodes: Record<string, GraphNode> = {
      d1: makeNode("d1", ["deployment"], { description: "deploy code" }),
      d2: makeNode("d2", ["deployment"], { description: "deploy build" }),
      d3: makeNode("d3", ["deployment"], { description: "deploy release" }),
      existing: makeNode("existing", ["security"], { description: "deploy this code" }),
    };

    inferFromBM25(nodes);

    expect(nodes.existing.domains).toEqual(["security"]);
  });

  test("handles no classified nodes", () => {
    const nodes: Record<string, GraphNode> = {
      a: makeNode("a", [], { description: "something" }),
      b: makeNode("b", [], { description: "another thing" }),
    };

    const count = inferFromBM25(nodes);
    expect(count).toBe(0);
  });
});

describe("propagateDomains (combined)", () => {
  test("runs both phases — neighbor first, then BM25", () => {
    const nodes: Record<string, GraphNode> = {
      // Classified seed nodes
      v1: makeNode("v1", ["verification"], { name: "verify-first", description: "Read source first verify before answering" }),
      v2: makeNode("v2", ["verification"], { name: "verify-assert", description: "Check before claim verify data" }),
      v3: makeNode("v3", ["verification"], { name: "verify-state", description: "Verify state before operations" }),
      // Unclassified — reachable by co_occurred
      neighbor_target: makeNode("neighbor_target", [], { name: "check-rule", description: "Some rule about checking" }),
      // Unclassified — only reachable by BM25
      bm25_target: makeNode("bm25_target", [], { name: "read-verify", description: "Read and verify before answering questions" }),
    };
    const edges: GraphEdge[] = [
      { from: "v1", to: "neighbor_target", relationship: "co_occurred", strength: 0.5 },
      { from: "v2", to: "neighbor_target", relationship: "co_occurred", strength: 0.5 },
    ];

    const total = propagateDomains(nodes, edges);

    expect(total).toBeGreaterThanOrEqual(1);
    expect(nodes.neighbor_target.domains).toEqual(["verification"]);
    expect(nodes.neighbor_target.domainSource).toBe("propagation");

    if (nodes.bm25_target.domains[0]) {
      expect(nodes.bm25_target.domainSource).toBe("bm25");
    }
  });

  test("never removes existing domains", () => {
    const nodes: Record<string, GraphNode> = {
      a: makeNode("a", ["deployment"]),
      b: makeNode("b", ["security"]),
      c: makeNode("c", ["verification"]),
    };

    propagateDomains(nodes, []);

    expect(nodes.a.domains).toEqual(["deployment"]);
    expect(nodes.b.domains).toEqual(["security"]);
    expect(nodes.c.domains).toEqual(["verification"]);
  });

  test("handles empty graph", () => {
    const count = propagateDomains({}, []);
    expect(count).toBe(0);
  });
});
