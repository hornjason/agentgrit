import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { updateEdgeWeightsFromRating } from "../../src/graph/attribution";
import type { SessionContext } from "../../src/graph/context";
import type { Graph } from "../../src/graph/types";

function makeSessionContext(ruleIds: string[]): SessionContext {
  return {
    ruleIds,
    domains: ["verification"],
    domain_source: "keyword",
    timestamp: new Date().toISOString(),
    ttl: 86400000,
    rulesInjectedCount: ruleIds.length,
    rulesInjectedKB: 1,
  };
}

function makeGraph(edgeStrength: number): Graph {
  return {
    version: "1.0",
    builtAt: new Date().toISOString(),
    nodeCount: 3,
    edgeCount: 2,
    nodes: {
      r1: { id: "r1", file: "r1.md", type: "rule", name: "Rule 1", description: "test", domains: ["verification"], severity: 5, occurrence_count: 1, last_updated: new Date().toISOString(), content_hash: "a", memoryType: "rule" },
      r2: { id: "r2", file: "r2.md", type: "rule", name: "Rule 2", description: "test", domains: ["verification"], severity: 5, occurrence_count: 1, last_updated: new Date().toISOString(), content_hash: "b", memoryType: "rule" },
      r3: { id: "r3", file: "r3.md", type: "rule", name: "Rule 3", description: "test", domains: ["deployment"], severity: 5, occurrence_count: 1, last_updated: new Date().toISOString(), content_hash: "c", memoryType: "rule" },
    },
    edges: [
      { from: "r1", to: "r2", relationship: "co_occurred", strength: edgeStrength },
      { from: "r2", to: "r3", relationship: "same_domain", strength: 0.5 },
    ],
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `attribution-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
});

describe("updateEdgeWeightsFromRating", () => {
  test("increases edge weight for high-rated session (rating 9)", () => {
    const graphPath = join(tmpDir, "graph.json");
    const graph = makeGraph(0.5);
    writeFileSync(graphPath, JSON.stringify(graph, null, 2));

    const ctx = makeSessionContext(["r1", "r2"]);
    updateEdgeWeightsFromRating(ctx, 9, graphPath);

    const updated = JSON.parse(readFileSync(graphPath, "utf-8")) as Graph;
    const coEdge = updated.edges.find(e => e.relationship === "co_occurred")!;
    expect(coEdge.strength).toBeGreaterThan(0.5);
    expect(coEdge.strength).toBeCloseTo(0.55, 2);
  });

  test("decreases edge weight for low-rated session (rating 2)", () => {
    const graphPath = join(tmpDir, "graph.json");
    const graph = makeGraph(0.5);
    writeFileSync(graphPath, JSON.stringify(graph, null, 2));

    const ctx = makeSessionContext(["r1", "r2"]);
    updateEdgeWeightsFromRating(ctx, 2, graphPath);

    const updated = JSON.parse(readFileSync(graphPath, "utf-8")) as Graph;
    const coEdge = updated.edges.find(e => e.relationship === "co_occurred")!;
    expect(coEdge.strength).toBeLessThan(0.5);
    expect(coEdge.strength).toBeCloseTo(0.45, 2);
  });

  test("does not change edge weight for mid-range rating (rating 5)", () => {
    const graphPath = join(tmpDir, "graph.json");
    const graph = makeGraph(0.5);
    writeFileSync(graphPath, JSON.stringify(graph, null, 2));

    const ctx = makeSessionContext(["r1", "r2"]);
    updateEdgeWeightsFromRating(ctx, 5, graphPath);

    const updated = JSON.parse(readFileSync(graphPath, "utf-8")) as Graph;
    const coEdge = updated.edges.find(e => e.relationship === "co_occurred")!;
    expect(coEdge.strength).toBe(0.5);
  });

  test("caps edge weight at 2.0", () => {
    const graphPath = join(tmpDir, "graph.json");
    const graph = makeGraph(1.95);
    writeFileSync(graphPath, JSON.stringify(graph, null, 2));

    const ctx = makeSessionContext(["r1"]);
    updateEdgeWeightsFromRating(ctx, 10, graphPath);

    const updated = JSON.parse(readFileSync(graphPath, "utf-8")) as Graph;
    const coEdge = updated.edges.find(e => e.relationship === "co_occurred")!;
    expect(coEdge.strength).toBeLessThanOrEqual(2.0);
  });

  test("floors edge weight at 0.1", () => {
    const graphPath = join(tmpDir, "graph.json");
    const graph = makeGraph(0.11);
    writeFileSync(graphPath, JSON.stringify(graph, null, 2));

    const ctx = makeSessionContext(["r1"]);
    updateEdgeWeightsFromRating(ctx, 1, graphPath);

    const updated = JSON.parse(readFileSync(graphPath, "utf-8")) as Graph;
    const coEdge = updated.edges.find(e => e.relationship === "co_occurred")!;
    expect(coEdge.strength).toBeGreaterThanOrEqual(0.1);
  });

  test("does not modify same_domain edges", () => {
    const graphPath = join(tmpDir, "graph.json");
    const graph = makeGraph(0.5);
    writeFileSync(graphPath, JSON.stringify(graph, null, 2));

    const ctx = makeSessionContext(["r2", "r3"]);
    updateEdgeWeightsFromRating(ctx, 9, graphPath);

    const updated = JSON.parse(readFileSync(graphPath, "utf-8")) as Graph;
    const domainEdge = updated.edges.find(e => e.relationship === "same_domain")!;
    expect(domainEdge.strength).toBe(0.5);
  });
});
