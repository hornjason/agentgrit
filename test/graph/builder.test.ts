import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { buildGraph, updateGraph, pruneStaleNodes, parseFrontmatter, inferSeverity, keywordClassify } from "../../src/graph/builder";
import type { Graph } from "../../src/graph/types";
import type { Rule, GraphNode } from "../../src/adapters/types";

const TMP_DIR = join(import.meta.dir, ".tmp-builder-test");
const RULES_DIR = join(TMP_DIR, "rules");
const STATE_DIR = join(TMP_DIR, "state");

function writeRule(id: string, content: string): void {
  writeFileSync(join(RULES_DIR, `${id}.md`), content, "utf-8");
}

function makeNode(id: string, domains: string[], overrides?: Partial<GraphNode>): GraphNode {
  return {
    id,
    file: `${id}.md`,
    type: "rule",
    name: id,
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

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(RULES_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

describe("parseFrontmatter", () => {
  test("extracts name and description", () => {
    const content = `---
name: test-rule
description: A test rule for validation
metadata:
  type: feedback
---

Rule body here.`;
    const fm = parseFrontmatter(content);
    expect(fm.name).toBe("test-rule");
    expect(fm.description).toBe("A test rule for validation");
  });

  test("returns empty for no frontmatter", () => {
    const fm = parseFrontmatter("No frontmatter here");
    expect(Object.keys(fm).length).toBe(0);
  });
});

describe("inferSeverity", () => {
  test("returns 5 for hard stop", () => {
    expect(inferSeverity("This is a hard stop rule with zero exceptions")).toBe(5);
  });

  test("returns 4 for never/always", () => {
    expect(inferSeverity("Never do this thing")).toBe(4);
  });

  test("returns 3 for must/required", () => {
    expect(inferSeverity("This must be done")).toBe(3);
  });

  test("returns 2 for should/prefer", () => {
    expect(inferSeverity("You should prefer this approach")).toBe(2);
  });

  test("returns 1 for soft guidelines", () => {
    expect(inferSeverity("Consider doing this")).toBe(1);
  });
});

describe("keywordClassify", () => {
  test("classifies deployment rules", () => {
    const result = keywordClassify("deploy-gate", "build sequence", "run make rebuild");
    expect(result).toEqual(["deployment"]);
  });

  test("classifies security rules", () => {
    const result = keywordClassify("sec-check", "gate", "run security scan before deploy");
    expect(result).toEqual(["security"]);
  });

  test("classifies scope rules", () => {
    const result = keywordClassify("scope-guard", "", "minimal scope, don't add unrequested features");
    expect(result).toEqual(["scope"]);
  });

  test("classifies delivery rules", () => {
    const result = keywordClassify("delivery-check", "", "avoid false completions, self audit before claiming done");
    expect(result).toEqual(["delivery"]);
  });

  test("returns null for ambiguous text", () => {
    const result = keywordClassify("generic", "", "do something nice");
    expect(result).toBeNull();
  });
});

describe("buildGraph", () => {
  test("builds graph from rule files", async () => {
    writeRule("feedback_verify", `---
name: verify-before-assert
description: Check before claiming
---
Always read source first and verify before answering any question.`);

    writeRule("feedback_scope", `---
name: minimal-scope
description: Stay focused
---
Keep minimal scope, don't add unrequested features, stay focused.`);

    const graph = await buildGraph(RULES_DIR, STATE_DIR);

    expect(graph.nodeCount).toBe(2);
    expect(graph.nodes["feedback_verify"]).toBeDefined();
    expect(graph.nodes["feedback_scope"]).toBeDefined();
    expect(graph.nodes["feedback_verify"].name).toBe("verify-before-assert");
    expect(graph.nodes["feedback_scope"].domains).toContain("scope");
  });

  test("produces edges for same-domain nodes", async () => {
    writeRule("rule_a", `---
name: rule-a
description: deploy gate
---
Run make rebuild before deploying.`);

    writeRule("rule_b", `---
name: rule-b
description: deploy check
---
Test container before rebuilding and deploying.`);

    const graph = await buildGraph(RULES_DIR, STATE_DIR);

    expect(graph.edgeCount).toBeGreaterThan(0);
    const hasEdge = graph.edges.some(
      e => (e.from === "rule_a" || e.to === "rule_a") &&
           (e.from === "rule_b" || e.to === "rule_b"),
    );
    expect(hasEdge).toBe(true);
  });

  test("writes graph to state dir", async () => {
    writeRule("feedback_test", `---
name: test
description: test rule
---
Just a test rule for deployment.`);

    await buildGraph(RULES_DIR, STATE_DIR);

    const graphPath = join(STATE_DIR, "knowledge-graph.json");
    expect(existsSync(graphPath)).toBe(true);

    const saved = JSON.parse(readFileSync(graphPath, "utf-8"));
    expect(saved.nodeCount).toBe(1);
  });

  test("handles empty rules directory", async () => {
    const graph = await buildGraph(RULES_DIR, STATE_DIR);
    expect(graph.nodeCount).toBe(0);
    expect(graph.edgeCount).toBe(0);
  });

  test("incremental build reuses cached domains", async () => {
    writeRule("feedback_cached", `---
name: cached-rule
description: deploy check
---
Run make rebuild to deploy.`);

    const first = await buildGraph(RULES_DIR, STATE_DIR);
    expect(first.nodes["feedback_cached"].domains).toContain("deployment");

    // Rebuild without changes — should reuse cached data
    const second = await buildGraph(RULES_DIR, STATE_DIR);
    expect(second.nodes["feedback_cached"].domains).toContain("deployment");
    expect(second.nodes["feedback_cached"].content_hash).toBe(first.nodes["feedback_cached"].content_hash);
  });
});

describe("updateGraph", () => {
  test("adds new rules to existing graph", () => {
    const graph: Graph = {
      version: "1.0",
      builtAt: new Date().toISOString(),
      nodeCount: 0,
      edgeCount: 0,
      nodes: {},
      edges: [],
    };

    const newRules: Rule[] = [{
      id: "feedback_new",
      text: "Always verify before answering and check before claiming",
      tier: "graph",
      tags: [],
      created: new Date().toISOString(),
      correlationScore: 0,
      sourceSignals: [],
      schemaVersion: 1,
    }];

    const updated = updateGraph(graph, newRules);
    expect(updated.nodeCount).toBe(1);
    expect(updated.nodes["feedback_new"]).toBeDefined();
    expect(updated.nodes["feedback_new"].domains.length).toBeGreaterThan(0);
  });

  test("connects new rules to domain siblings", () => {
    const graph: Graph = {
      version: "1.0",
      builtAt: new Date().toISOString(),
      nodeCount: 1,
      edgeCount: 0,
      nodes: {
        existing: makeNode("existing", ["deployment"]),
      },
      edges: [],
    };

    const newRules: Rule[] = [{
      id: "new_deploy",
      text: "Always run make rebuild before deploying",
      tier: "graph",
      tags: [],
      created: new Date().toISOString(),
      correlationScore: 0,
      sourceSignals: [],
      schemaVersion: 1,
    }];

    const updated = updateGraph(graph, newRules);
    expect(updated.edgeCount).toBeGreaterThan(0);
    expect(updated.edges[0].relationship).toBe("same_domain");
  });

  test("updates existing node instead of duplicating", () => {
    const graph: Graph = {
      version: "1.0",
      builtAt: new Date().toISOString(),
      nodeCount: 1,
      edgeCount: 0,
      nodes: {
        existing: makeNode("existing", ["verification"], { content_hash: "old-hash", occurrence_count: 5 }),
      },
      edges: [],
    };

    const updated = updateGraph(graph, [{
      id: "existing",
      text: "Updated text for make rebuild deployment",
      tier: "graph",
      tags: [],
      created: "",
      correlationScore: 0,
      sourceSignals: [],
      schemaVersion: 1,
    }]);

    expect(updated.nodeCount).toBe(1);
    expect(updated.nodes["existing"].domains).toContain("deployment");
  });
});

describe("pruneStaleNodes", () => {
  test("removes nodes not in valid set", () => {
    const graph: Graph = {
      version: "1.0",
      builtAt: "",
      nodeCount: 2,
      edgeCount: 1,
      nodes: {
        keep: makeNode("keep", ["scope"]),
        stale: makeNode("stale", ["scope"]),
      },
      edges: [{ from: "keep", to: "stale", relationship: "same_domain", strength: 0.5 }],
    };

    const pruned = pruneStaleNodes(graph, new Set(["keep"]));
    expect(pruned.nodeCount).toBe(1);
    expect(pruned.nodes["stale"]).toBeUndefined();
    expect(pruned.edgeCount).toBe(0);
  });

  test("preserves all nodes when all valid", () => {
    const graph: Graph = {
      version: "1.0",
      builtAt: "",
      nodeCount: 1,
      edgeCount: 0,
      nodes: {
        keep: makeNode("keep", []),
      },
      edges: [],
    };

    const pruned = pruneStaleNodes(graph, new Set(["keep"]));
    expect(pruned.nodeCount).toBe(1);
  });
});
