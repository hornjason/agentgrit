import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { updateEdgeWeightsFromRating, proportionalAdjustment } from "../../src/graph/attribution";
import type { SessionContext } from "../../src/graph/context";
import type { Graph } from "../../src/graph/types";

function makeSessionContext(ruleIds: string[]): SessionContext {
  return {
    ruleIds,
    domains: ["testing"],
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
      r1: { id: "r1", file: "r1.md", type: "rule", name: "Rule 1", description: "test", domains: ["testing"], severity: 5, occurrence_count: 1, last_updated: new Date().toISOString(), content_hash: "a", memoryType: "rule" },
      r2: { id: "r2", file: "r2.md", type: "rule", name: "Rule 2", description: "test", domains: ["testing"], severity: 5, occurrence_count: 1, last_updated: new Date().toISOString(), content_hash: "b", memoryType: "rule" },
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
    // Rating 9 = +15% → 0.5 * 1.15 = 0.575
    expect(coEdge.strength).toBeCloseTo(0.575, 2);
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
    // Rating 2 = -15% → 0.5 * 0.85 = 0.425
    expect(coEdge.strength).toBeCloseTo(0.425, 2);
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

  test("rating 6 applies +5% adjustment", () => {
    const graphPath = join(tmpDir, "graph.json");
    const graph = makeGraph(1.0);
    writeFileSync(graphPath, JSON.stringify(graph, null, 2));

    const ctx = makeSessionContext(["r1"]);
    updateEdgeWeightsFromRating(ctx, 6, graphPath);

    const updated = JSON.parse(readFileSync(graphPath, "utf-8")) as Graph;
    const coEdge = updated.edges.find(e => e.relationship === "co_occurred")!;
    expect(coEdge.strength).toBeCloseTo(1.05, 2);
  });

  test("rating 4 applies -5% adjustment", () => {
    const graphPath = join(tmpDir, "graph.json");
    const graph = makeGraph(1.0);
    writeFileSync(graphPath, JSON.stringify(graph, null, 2));

    const ctx = makeSessionContext(["r1"]);
    updateEdgeWeightsFromRating(ctx, 4, graphPath);

    const updated = JSON.parse(readFileSync(graphPath, "utf-8")) as Graph;
    const coEdge = updated.edges.find(e => e.relationship === "co_occurred")!;
    expect(coEdge.strength).toBeCloseTo(0.95, 2);
  });

  test("rating 7 applies +10% adjustment", () => {
    const graphPath = join(tmpDir, "graph.json");
    const graph = makeGraph(1.0);
    writeFileSync(graphPath, JSON.stringify(graph, null, 2));

    const ctx = makeSessionContext(["r1"]);
    updateEdgeWeightsFromRating(ctx, 7, graphPath);

    const updated = JSON.parse(readFileSync(graphPath, "utf-8")) as Graph;
    const coEdge = updated.edges.find(e => e.relationship === "co_occurred")!;
    expect(coEdge.strength).toBeCloseTo(1.1, 2);
  });

  test("rating 8 applies +15% adjustment", () => {
    const graphPath = join(tmpDir, "graph.json");
    const graph = makeGraph(1.0);
    writeFileSync(graphPath, JSON.stringify(graph, null, 2));

    const ctx = makeSessionContext(["r1"]);
    updateEdgeWeightsFromRating(ctx, 8, graphPath);

    const updated = JSON.parse(readFileSync(graphPath, "utf-8")) as Graph;
    const coEdge = updated.edges.find(e => e.relationship === "co_occurred")!;
    expect(coEdge.strength).toBeCloseTo(1.15, 2);
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

describe("proportionalAdjustment", () => {
  test("rating 5 returns 0 (neutral)", () => {
    expect(proportionalAdjustment(5)).toBe(0);
  });

  test("rating 6 returns +5%", () => {
    expect(proportionalAdjustment(6)).toBe(0.05);
  });

  test("rating 4 returns -5%", () => {
    expect(proportionalAdjustment(4)).toBe(-0.05);
  });

  test("rating 7 returns +10%", () => {
    expect(proportionalAdjustment(7)).toBe(0.10);
  });

  test("rating 3 returns -10%", () => {
    expect(proportionalAdjustment(3)).toBe(-0.10);
  });

  test("rating 8 returns +15%", () => {
    expect(proportionalAdjustment(8)).toBe(0.15);
  });

  test("rating 2 returns -15%", () => {
    expect(proportionalAdjustment(2)).toBe(-0.15);
  });

  test("rating 9+ caps at +15%", () => {
    expect(proportionalAdjustment(9)).toBe(0.15);
    expect(proportionalAdjustment(10)).toBe(0.15);
  });

  test("rating 1 caps at -15%", () => {
    expect(proportionalAdjustment(1)).toBe(-0.15);
  });
});
