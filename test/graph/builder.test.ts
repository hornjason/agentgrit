import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { buildGraph, updateGraph, pruneStaleNodes, parseFrontmatter, inferSeverity, keywordClassify, loadRuleDomains, buildCoOccurrenceEdges, resetClassifyPatterns } from "../../src/graph/builder";
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
  resetClassifyPatterns();
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

  test("classifies scoring rules", () => {
    const result = keywordClassify("score-v2", "scorer", "v2 scoring signals ratings scorer effectiveness");
    expect(result).toEqual(["scoring"]);
  });

  test("classifies pipeline rules", () => {
    const result = keywordClassify("pipe-daemon", "lifecycle", "promote rule evict daemon cycle pipeline");
    expect(result).toEqual(["pipeline"]);
  });

  test("classifies scope rules", () => {
    const result = keywordClassify("scope-guard", "", "minimal scope, don't add unrequested features");
    expect(result).toEqual(["scope"]);
  });

  test("classifies delivery rules", () => {
    const result = keywordClassify("delivery-check", "", "avoid false completions, self audit before claiming done");
    expect(result).toEqual(["delivery"]);
  });

  test("classifies auth/credential terms as security", () => {
    expect(keywordClassify("auth-gate", "", "validate auth token before accessing resources")).toEqual(["security"]);
    expect(keywordClassify("cred-check", "", "never store credential in plain text")).toEqual(["security"]);
    expect(keywordClassify("secret-mgmt", "", "rotate secret key every 90 days")).toEqual(["security"]);
    expect(keywordClassify("access", "", "enforce access control on all endpoints")).toEqual(["security"]);
    expect(keywordClassify("encryption", "", "encrypt sensitive data at rest")).toEqual(["security"]);
  });

  test("classifies architecture terms", () => {
    expect(keywordClassify("refactor-rule", "", "refactor the module to reduce coupling")).toEqual(["architecture"]);
    expect(keywordClassify("design", "", "use abstract interface for module boundary")).toEqual(["architecture"]);
    expect(keywordClassify("deep-mod", "", "prefer deep module design with cohesion")).toEqual(["architecture"]);
    expect(keywordClassify("arch-decision", "", "record architecture decision in ADR")).toEqual(["architecture"]);
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

describe("rule-domains.json override", () => {
  function writeRuleDomains(rules: Record<string, { domains: string[]; source: string }>): string {
    const path = join(TMP_DIR, "rule-domains.json");
    writeFileSync(path, JSON.stringify({ version: 1, reviewed: true, rules }, null, 2), "utf-8");
    return path;
  }

  test("overrides keyword-classified domains with reviewed domains", async () => {
    writeRule("feedback_verify", `---
name: verify-before-assert
description: Check before claiming
---
Always read source first and verify before answering any question.`);

    const rdPath = writeRuleDomains({
      feedback_verify: { domains: ["verification", "data"], source: "reviewed" },
    });

    const graph = await buildGraph(RULES_DIR, STATE_DIR, rdPath);

    expect(graph.nodes["feedback_verify"].domains).toEqual(["verification", "data"]);
  });

  test("leaves unmatched nodes with keyword-classified domains", async () => {
    writeRule("feedback_scope", `---
name: minimal-scope
description: Stay focused
---
Keep minimal scope, don't add unrequested features, stay focused.`);

    const rdPath = writeRuleDomains({
      unrelated_rule: { domains: ["security"], source: "reviewed" },
    });

    const graph = await buildGraph(RULES_DIR, STATE_DIR, rdPath);

    expect(graph.nodes["feedback_scope"].domains).toContain("scope");
  });

  test("falls back gracefully when rule-domains.json missing", async () => {
    writeRule("feedback_deploy", `---
name: deploy-gate
description: deploy sequence
---
Run make rebuild before deploying.`);

    const graph = await buildGraph(RULES_DIR, STATE_DIR, join(TMP_DIR, "nonexistent.json"));

    expect(graph.nodes["feedback_deploy"].domains).toContain("deployment");
  });

  test("falls back gracefully when rule-domains.json is invalid JSON", async () => {
    const rdPath = join(TMP_DIR, "rule-domains.json");
    writeFileSync(rdPath, "not valid json{{{", "utf-8");

    writeRule("feedback_deploy", `---
name: deploy-gate
description: deploy sequence
---
Run make rebuild before deploying.`);

    const graph = await buildGraph(RULES_DIR, STATE_DIR, rdPath);

    expect(graph.nodes["feedback_deploy"].domains).toContain("deployment");
  });

  test("filters out invalid domain names from rule-domains.json", async () => {
    writeRule("feedback_verify", `---
name: verify-rule
description: Check things
---
Always verify before answering.`);

    const rdPath = writeRuleDomains({
      feedback_verify: { domains: ["verification", "nonexistent_domain"], source: "reviewed" },
    });

    const graph = await buildGraph(RULES_DIR, STATE_DIR, rdPath);

    expect(graph.nodes["feedback_verify"].domains).toEqual(["verification"]);
  });

  test("loadRuleDomains returns null for missing file", () => {
    expect(loadRuleDomains(join(TMP_DIR, "missing.json"))).toBeNull();
  });

  test("loadRuleDomains parses valid file", () => {
    const rdPath = writeRuleDomains({
      test_rule: { domains: ["scope"], source: "reviewed" },
    });
    const result = loadRuleDomains(rdPath);
    expect(result).not.toBeNull();
    expect(result!.rules.test_rule.domains).toEqual(["scope"]);
  });

  test("matches kebab-case rule-domains keys to underscore graph IDs with prefix", async () => {
    writeRule("feedback_ac_garbage_test", `---
name: ac-garbage-test
description: Every AC needs measurable threshold
---
Every acceptance criterion needs a measurable threshold, not vague language.`);

    writeRule("feedback_commit_after_every_working_change", `---
name: commit-after-every-working-change
description: Commit after every working change
---
Always commit after every working change to preserve progress.`);

    const rdPath = writeRuleDomains({
      "ac-garbage-test": { domains: ["delivery", "scope"], source: "reviewed" },
      "commit-after-every-working-change": { domains: ["delivery"], source: "reviewed" },
    });

    const graph = await buildGraph(RULES_DIR, STATE_DIR, rdPath);

    expect(graph.nodes["feedback_ac_garbage_test"].domains).toEqual(["delivery", "scope"]);
    expect(graph.nodes["feedback_commit_after_every_working_change"].domains).toEqual(["delivery"]);
  });

  test("prefers exact match over normalized match", async () => {
    writeRule("feedback_verify_before_answering", `---
name: verify-before-answering
description: Verify before answering
---
Always verify before answering.`);

    const rdPath = writeRuleDomains({
      "feedback_verify_before_answering": { domains: ["verification", "data"], source: "reviewed" },
      "verify-before-answering": { domains: ["scope"], source: "reviewed" },
    });

    const graph = await buildGraph(RULES_DIR, STATE_DIR, rdPath);

    expect(graph.nodes["feedback_verify_before_answering"].domains).toEqual(["verification", "data"]);
  });

  test("same-domain edges reflect overridden domains", async () => {
    writeRule("rule_a", `---
name: rule-a
description: generic rule
---
A generic rule about something.`);

    writeRule("rule_b", `---
name: rule-b
description: another generic rule
---
Another generic rule about something else.`);

    const rdPath = writeRuleDomains({
      rule_a: { domains: ["security"], source: "reviewed" },
      rule_b: { domains: ["security"], source: "reviewed" },
    });

    const graph = await buildGraph(RULES_DIR, STATE_DIR, rdPath);

    expect(graph.nodes["rule_a"].domains).toEqual(["security"]);
    expect(graph.nodes["rule_b"].domains).toEqual(["security"]);
    const hasEdge = graph.edges.some(
      e => (e.from === "rule_a" || e.to === "rule_a") &&
           (e.from === "rule_b" || e.to === "rule_b") &&
           e.relationship === "same_domain",
    );
    expect(hasEdge).toBe(true);
  });
});

describe("buildCoOccurrenceEdges", () => {
  test("creates edges from session co-occurrence data", () => {
    const historyPath = join(TMP_DIR, "history.jsonl");
    writeFileSync(historyPath, [
      JSON.stringify({ ruleIds: ["rule_a", "rule_b", "rule_c"] }),
      JSON.stringify({ ruleIds: ["rule_a", "rule_b"] }),
    ].join("\n"), "utf-8");

    const nodes: Record<string, GraphNode> = {
      rule_a: makeNode("rule_a", ["verification"]),
      rule_b: makeNode("rule_b", ["verification"]),
      rule_c: makeNode("rule_c", ["scope"]),
    };

    const edges = buildCoOccurrenceEdges(nodes, new Set(), historyPath);

    expect(edges.length).toBe(3);
    expect(edges.every(e => e.relationship === "co_occurred")).toBe(true);

    const abEdge = edges.find(e =>
      (e.from === "rule_a" && e.to === "rule_b") || (e.from === "rule_b" && e.to === "rule_a"),
    );
    expect(abEdge).toBeDefined();
    expect(abEdge!.strength).toBeCloseTo(0.5, 5); // 2 sessions × 0.5 default weight / 2 total
  });

  test("skips pairs already in existingPairs", () => {
    const historyPath = join(TMP_DIR, "history.jsonl");
    writeFileSync(historyPath, JSON.stringify({ ruleIds: ["rule_a", "rule_b"] }), "utf-8");

    const nodes: Record<string, GraphNode> = {
      rule_a: makeNode("rule_a", ["verification"]),
      rule_b: makeNode("rule_b", ["verification"]),
    };

    const existing = new Set(["rule_a::rule_b"]);
    const edges = buildCoOccurrenceEdges(nodes, existing, historyPath);

    expect(edges.length).toBe(0);
  });

  test("filters out ruleIds not in graph nodes", () => {
    const historyPath = join(TMP_DIR, "history.jsonl");
    writeFileSync(historyPath, JSON.stringify({ ruleIds: ["rule_a", "rule_b", "missing_rule"] }), "utf-8");

    const nodes: Record<string, GraphNode> = {
      rule_a: makeNode("rule_a", ["verification"]),
      rule_b: makeNode("rule_b", ["verification"]),
    };

    const edges = buildCoOccurrenceEdges(nodes, new Set(), historyPath);

    expect(edges.length).toBe(1);
    expect(edges[0].from).toBe("rule_a");
    expect(edges[0].to).toBe("rule_b");
  });

  test("returns empty for missing history file", () => {
    const nodes: Record<string, GraphNode> = {
      rule_a: makeNode("rule_a", ["verification"]),
    };
    const edges = buildCoOccurrenceEdges(nodes, new Set(), join(TMP_DIR, "nonexistent.jsonl"));
    expect(edges.length).toBe(0);
  });

  test("weights edges by session rating (rating 9 → weight 0.9)", () => {
    const historyPath = join(TMP_DIR, "history.jsonl");
    const ratingsPath = join(TMP_DIR, "ratings.jsonl");
    writeFileSync(historyPath, [
      JSON.stringify({ ruleIds: ["rule_a", "rule_b"], session_id: "s1" }),
    ].join("\n"), "utf-8");
    writeFileSync(ratingsPath, JSON.stringify({ session_id: "s1", rating: 9 }), "utf-8");

    const nodes: Record<string, GraphNode> = {
      rule_a: makeNode("rule_a", ["verification"]),
      rule_b: makeNode("rule_b", ["verification"]),
    };

    const edges = buildCoOccurrenceEdges(nodes, new Set(), historyPath, ratingsPath);
    expect(edges.length).toBe(1);
    expect(edges[0].strength).toBeCloseTo(0.9, 5);
  });

  test("weights edges by session rating (rating 3 → weight 0.3)", () => {
    const historyPath = join(TMP_DIR, "history.jsonl");
    const ratingsPath = join(TMP_DIR, "ratings.jsonl");
    writeFileSync(historyPath, JSON.stringify({ ruleIds: ["rule_a", "rule_b"], session_id: "s1" }), "utf-8");
    writeFileSync(ratingsPath, JSON.stringify({ session_id: "s1", rating: 3 }), "utf-8");

    const nodes: Record<string, GraphNode> = {
      rule_a: makeNode("rule_a", ["verification"]),
      rule_b: makeNode("rule_b", ["verification"]),
    };

    const edges = buildCoOccurrenceEdges(nodes, new Set(), historyPath, ratingsPath);
    expect(edges.length).toBe(1);
    expect(edges[0].strength).toBeCloseTo(0.3, 5);
  });

  test("defaults to 0.5 weight for sessions with no rating", () => {
    const historyPath = join(TMP_DIR, "history.jsonl");
    const ratingsPath = join(TMP_DIR, "ratings.jsonl");
    writeFileSync(historyPath, JSON.stringify({ ruleIds: ["rule_a", "rule_b"], session_id: "s1" }), "utf-8");
    writeFileSync(ratingsPath, "", "utf-8");

    const nodes: Record<string, GraphNode> = {
      rule_a: makeNode("rule_a", ["verification"]),
      rule_b: makeNode("rule_b", ["verification"]),
    };

    const edges = buildCoOccurrenceEdges(nodes, new Set(), historyPath, ratingsPath);
    expect(edges.length).toBe(1);
    expect(edges[0].strength).toBeCloseTo(0.5, 5);
  });

  test("defaults to 0.5 weight when session has no session_id", () => {
    const historyPath = join(TMP_DIR, "history.jsonl");
    const ratingsPath = join(TMP_DIR, "ratings.jsonl");
    writeFileSync(historyPath, JSON.stringify({ ruleIds: ["rule_a", "rule_b"] }), "utf-8");
    writeFileSync(ratingsPath, JSON.stringify({ session_id: "s1", rating: 9 }), "utf-8");

    const nodes: Record<string, GraphNode> = {
      rule_a: makeNode("rule_a", ["verification"]),
      rule_b: makeNode("rule_b", ["verification"]),
    };

    const edges = buildCoOccurrenceEdges(nodes, new Set(), historyPath, ratingsPath);
    expect(edges[0].strength).toBeCloseTo(0.5, 5);
  });

  test("skips NaN rating values", () => {
    const historyPath = join(TMP_DIR, "history.jsonl");
    const ratingsPath = join(TMP_DIR, "ratings.jsonl");
    writeFileSync(historyPath, JSON.stringify({ ruleIds: ["rule_a", "rule_b"], session_id: "s1" }), "utf-8");
    writeFileSync(ratingsPath, JSON.stringify({ session_id: "s1", rating: NaN }), "utf-8");

    const nodes: Record<string, GraphNode> = {
      rule_a: makeNode("rule_a", ["verification"]),
      rule_b: makeNode("rule_b", ["verification"]),
    };

    const edges = buildCoOccurrenceEdges(nodes, new Set(), historyPath, ratingsPath);
    // NaN fails typeof check in ratingBySession population, so treated as no rating → 0.5
    expect(edges[0].strength).toBeCloseTo(0.5, 5);
  });

  test("clamps rating -1 to floor of 0.3", () => {
    const historyPath = join(TMP_DIR, "history.jsonl");
    const ratingsPath = join(TMP_DIR, "ratings.jsonl");
    writeFileSync(historyPath, JSON.stringify({ ruleIds: ["rule_a", "rule_b"], session_id: "s1" }), "utf-8");
    writeFileSync(ratingsPath, JSON.stringify({ session_id: "s1", rating: -1 }), "utf-8");

    const nodes: Record<string, GraphNode> = {
      rule_a: makeNode("rule_a", ["verification"]),
      rule_b: makeNode("rule_b", ["verification"]),
    };

    const edges = buildCoOccurrenceEdges(nodes, new Set(), historyPath, ratingsPath);
    // -1 clamped to 1, then 1/10 = 0.1, but floor is 0.3
    expect(edges[0].strength).toBeCloseTo(0.3, 5);
  });

  test("clamps rating 999 to 1.0", () => {
    const historyPath = join(TMP_DIR, "history.jsonl");
    const ratingsPath = join(TMP_DIR, "ratings.jsonl");
    writeFileSync(historyPath, JSON.stringify({ ruleIds: ["rule_a", "rule_b"], session_id: "s1" }), "utf-8");
    writeFileSync(ratingsPath, JSON.stringify({ session_id: "s1", rating: 999 }), "utf-8");

    const nodes: Record<string, GraphNode> = {
      rule_a: makeNode("rule_a", ["verification"]),
      rule_b: makeNode("rule_b", ["verification"]),
    };

    const edges = buildCoOccurrenceEdges(nodes, new Set(), historyPath, ratingsPath);
    // 999 clamped to 10, then 10/10 = 1.0
    expect(edges[0].strength).toBeCloseTo(1.0, 5);
  });

  test("Infinity rating treated as no rating (default 0.5)", () => {
    const historyPath = join(TMP_DIR, "history.jsonl");
    const ratingsPath = join(TMP_DIR, "ratings.jsonl");
    writeFileSync(historyPath, JSON.stringify({ ruleIds: ["rule_a", "rule_b"], session_id: "s1" }), "utf-8");
    writeFileSync(ratingsPath, JSON.stringify({ session_id: "s1", rating: Infinity }), "utf-8");

    const nodes: Record<string, GraphNode> = {
      rule_a: makeNode("rule_a", ["verification"]),
      rule_b: makeNode("rule_b", ["verification"]),
    };

    const edges = buildCoOccurrenceEdges(nodes, new Set(), historyPath, ratingsPath);
    expect(edges[0].strength).toBeCloseTo(0.5, 5);
  });

  test("caps at 200 edges", () => {
    const historyPath = join(TMP_DIR, "history.jsonl");
    const ruleIds: string[] = [];
    const nodes: Record<string, GraphNode> = {};
    for (let i = 0; i < 30; i++) {
      const id = `rule_${i}`;
      ruleIds.push(id);
      nodes[id] = makeNode(id, ["verification"]);
    }
    // 30 rules in one session = 435 pairs, should cap at 200
    writeFileSync(historyPath, JSON.stringify({ ruleIds }), "utf-8");

    const edges = buildCoOccurrenceEdges(nodes, new Set(), historyPath);
    expect(edges.length).toBeLessThanOrEqual(200);
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
