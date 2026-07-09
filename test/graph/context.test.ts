import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { getContextRules, detectDomains } from "../../src/graph/context";
import { buildIndex } from "../../src/graph/bm25";
import type { Graph } from "../../src/graph/types";
import type { GraphNode } from "../../src/adapters/types";

const TMP_DIR = join(import.meta.dir, ".tmp-context-test");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

function makeNode(id: string, domains: string[], description?: string): GraphNode {
  return {
    id,
    file: `${id}.md`,
    type: "rule",
    name: `Rule: ${id}`,
    description: description || `Text for ${id}`,
    domains,
    severity: 3,
    occurrence_count: 0,
    last_updated: new Date().toISOString(),
    content_hash: id.slice(0, 8),
    memoryType: "behavioral-rule",
  };
}

function makeGraph(nodes: GraphNode[]): Graph {
  const nodeMap: Record<string, GraphNode> = {};
  for (const n of nodes) nodeMap[n.id] = n;
  return {
    version: "1.0",
    builtAt: new Date().toISOString(),
    nodeCount: nodes.length,
    edgeCount: 0,
    nodes: nodeMap,
    edges: [],
  };
}

describe("detectDomains", () => {
  test("detects deployment domain", () => {
    const domains = detectDomains("run make rebuild to deploy");
    expect(domains).toContain("deployment");
  });

  test("detects verification domain", () => {
    const domains = detectDomains("verify before answering");
    expect(domains).toContain("verification");
  });

  test("detects multiple domains", () => {
    const domains = detectDomains("verify endpoints before deploying containers");
    expect(domains.length).toBeGreaterThan(1);
  });

  test("returns empty for unclassifiable text", () => {
    const domains = detectDomains("xyzzy foobarbaz");
    expect(domains).toEqual([]);
  });

  test("detects security domain", () => {
    const domains = detectDomains("run security scan on vulnerability");
    expect(domains).toContain("security");
  });

  test("detects scope domain", () => {
    const domains = detectDomains("stay focused on minimal scope");
    expect(domains).toContain("scope");
  });

  test("detects delegation domain", () => {
    const domains = detectDomains("spawn agent with worktree isolation");
    expect(domains).toContain("delegation");
  });

  test("detects ui-testing domain", () => {
    const domains = detectDomains("run playwright visual test");
    expect(domains).toContain("ui-testing");
  });
});

describe("getContextRules", () => {
  test("returns rules for matching domains", () => {
    const graph = makeGraph([
      makeNode("deploy_gate", ["deployment"], "Run make rebuild before deploying"),
      makeNode("verify_first", ["verification"], "Verify endpoints are up"),
      makeNode("scope_guard", ["scope"], "Keep changes minimal"),
    ]);

    const f1 = join(TMP_DIR, "deploy_gate.md");
    writeFileSync(f1, "deployment make rebuild deployment containers", "utf-8");
    const index = buildIndex([f1]);

    const rules = getContextRules(graph, index, ["deployment"]);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules[0].id).toBe("deploy_gate");
    expect(rules[0].tags).toContain("deployment");
    expect(rules[0].tier).toBe("graph");
  });

  test("respects limit", () => {
    const files: string[] = [];
    const nodes = Array.from({ length: 20 }, (_, i) => {
      const id = `rule-${i}`;
      const f = join(TMP_DIR, `${id}.md`);
      writeFileSync(f, `deployment containers rule number ${i}`, "utf-8");
      files.push(f);
      return makeNode(id, ["deployment"]);
    });
    const graph = makeGraph(nodes);
    const index = buildIndex(files);

    const rules = getContextRules(graph, index, ["deployment"], 5);
    expect(rules.length).toBeLessThanOrEqual(5);
  });

  test("falls back to default domains when empty", () => {
    const graph = makeGraph([
      makeNode("verify_rule", ["verification"], "Always verify"),
      makeNode("deliver_rule", ["delivery"], "Complete delivery"),
      makeNode("deploy_rule", ["deployment"], "Deploy correctly"),
    ]);
    const f1 = join(TMP_DIR, "verify_rule.md");
    const f2 = join(TMP_DIR, "deliver_rule.md");
    const f3 = join(TMP_DIR, "deploy_rule.md");
    writeFileSync(f1, "verification verify always verify", "utf-8");
    writeFileSync(f2, "delivery complete delivery", "utf-8");
    writeFileSync(f3, "deployment deploy correctly", "utf-8");
    const index = buildIndex([f1, f2, f3]);

    const rules = getContextRules(graph, index, []);
    expect(rules.length).toBeGreaterThan(0);
  });

  test("BM25 hits expand to graph neighbors", () => {
    const graph = makeGraph([
      makeNode("bm25_hit", ["deployment"], "Deploy with make rebuild"),
      makeNode("neighbor_rule", ["deployment"], "Run smoke tests after deploy"),
    ]);
    graph.edges = [{
      from: "bm25_hit",
      to: "neighbor_rule",
      relationship: "reinforces",
      strength: 0.8,
    }];

    const f1 = join(TMP_DIR, "bm25_hit.md");
    writeFileSync(f1, "deployment deployment deployment containers", "utf-8");
    const index = buildIndex([f1]);

    const rules = getContextRules(graph, index, ["deployment"], 10);
    const ids = rules.map(r => r.id);
    expect(ids).toContain("bm25_hit");
    expect(ids).toContain("neighbor_rule");
  });

  test("deduplicates between direct BM25 and expansion", () => {
    const graph = makeGraph([
      makeNode("shared_rule", ["deployment"], "deployment make rebuild"),
    ]);

    const f1 = join(TMP_DIR, "shared_rule.md");
    writeFileSync(f1, "deployment make rebuild deployment", "utf-8");
    const index = buildIndex([f1]);

    const rules = getContextRules(graph, index, ["deployment"], 10);
    const sharedCount = rules.filter(r => r.id === "shared_rule").length;
    expect(sharedCount).toBe(1);
  });

  test("returns empty for empty graph and index", () => {
    const graph = makeGraph([]);
    const index = buildIndex([]);
    const rules = getContextRules(graph, index, ["deployment"]);
    expect(rules).toEqual([]);
  });

  test("rule text comes from node", () => {
    const graph = makeGraph([
      makeNode("test_rule", ["verification"], "Always verify before asserting anything"),
    ]);
    const f1 = join(TMP_DIR, "test_rule.md");
    writeFileSync(f1, "verification verify before asserting anything", "utf-8");
    const index = buildIndex([f1]);

    const rules = getContextRules(graph, index, ["verification"]);
    expect(rules[0].text).toBe("Always verify before asserting anything");
  });

  test("includes trajectory data when signalDir provided", () => {
    const graph = makeGraph([]);
    const index = buildIndex([]);

    const trajDir = join(TMP_DIR, "traj-signals");
    mkdirSync(trajDir, { recursive: true });
    writeFileSync(
      join(trajDir, "trajectories.json"),
      JSON.stringify({
        trajectories: [
          {
            id: "traj-1",
            task: "fix auth",
            domains: ["verification"],
            summary: "Fixed auth flow with retry",
            rating: 9,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    );

    const rules = getContextRules(graph, index, ["verification"], 10, trajDir);
    expect(rules.length).toBe(1);
    expect(rules[0].id).toBe("traj-1");
    expect(rules[0].text).toContain("[trajectory]");
    expect(rules[0].text).toContain("Fixed auth flow with retry");
  });
});
