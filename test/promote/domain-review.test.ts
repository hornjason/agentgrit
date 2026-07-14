import { describe, test, expect } from "bun:test";
import { reviewDomains, parseLearnedRules } from "../../src/promote/domain-review";
import type { Graph } from "../../src/graph/types";

function makeGraph(nodes: Record<string, { domains: string[]; domainSource?: string; description?: string }>): Graph {
  const graphNodes: Record<string, any> = {};
  for (const [id, opts] of Object.entries(nodes)) {
    graphNodes[id] = {
      id,
      file: `${id}.md`,
      type: "rule",
      name: id,
      description: opts.description ?? `Description for ${id}`,
      domains: opts.domains,
      domainSource: opts.domainSource ?? "keyword",
      severity: 3,
      occurrence_count: 1,
      last_updated: new Date().toISOString(),
      content_hash: "abcd1234",
      memoryType: "behavioral-rule",
    };
  }
  return {
    version: "1.0",
    builtAt: new Date().toISOString(),
    nodeCount: Object.keys(graphNodes).length,
    edgeCount: 0,
    nodes: graphNodes,
    edges: [],
  };
}

describe("reviewDomains", () => {
  test("promotes rules when auto domains fully match inferred", () => {
    const ruleDomains = {
      "rule-a": { domains: ["verification"], source: "auto" },
    };
    const graph = makeGraph({
      "rule-a": { domains: ["verification"], domainSource: "keyword" },
    });

    const results = reviewDomains(ruleDomains, graph);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("reviewed");
    expect(results[0].agreement).toBe(1);
  });

  test("promotes when at least half the auto domains match", () => {
    const ruleDomains = {
      "rule-b": { domains: ["verification", "deployment"], source: "auto" },
    };
    const graph = makeGraph({
      "rule-b": { domains: ["verification"], domainSource: "bm25" },
    });

    const results = reviewDomains(ruleDomains, graph);
    expect(results[0].status).toBe("reviewed");
    expect(results[0].agreement).toBe(0.5);
  });

  test("marks disagreement when less than half of valid auto domains match", () => {
    const ruleDomains = {
      "rule-c": { domains: ["verification", "deployment", "scope"], source: "auto" },
    };
    const graph = makeGraph({
      "rule-c": { domains: ["memory"], domainSource: "bm25" },
    });

    const results = reviewDomains(ruleDomains, graph);
    expect(results[0].status).toBe("disagreement");
    expect(results[0].agreement).toBe(0);
  });

  test("filters auto domains to valid taxonomy before computing agreement", () => {
    const ruleDomains = {
      "rule-invalid": { domains: ["backlog", "deployment"], source: "auto" },
    };
    const graph = makeGraph({
      "rule-invalid": { domains: ["deployment"], domainSource: "keyword" },
    });

    const results = reviewDomains(ruleDomains, graph);
    expect(results[0].status).toBe("reviewed");
    expect(results[0].agreement).toBe(1);
  });

  test("agreement is 0 when all auto domains are outside valid taxonomy", () => {
    const ruleDomains = {
      "rule-all-invalid": { domains: ["backlog", "architecture"], source: "auto" },
    };
    const graph = makeGraph({
      "rule-all-invalid": { domains: ["deployment"], domainSource: "keyword" },
    });

    const results = reviewDomains(ruleDomains, graph);
    expect(results[0].status).toBe("disagreement");
    expect(results[0].agreement).toBe(0);
  });

  test("marks no-inference when node not found and no learned text", () => {
    const ruleDomains = {
      "rule-missing": { domains: ["verification"], source: "auto" },
    };
    const graph = makeGraph({});

    const results = reviewDomains(ruleDomains, graph);
    expect(results[0].status).toBe("no-inference");
    expect(results[0].inferredDomains).toEqual([]);
  });

  test("marks no-inference when node has empty domains and no learned text", () => {
    const ruleDomains = {
      "rule-empty": { domains: ["verification"], source: "auto" },
    };
    const graph = makeGraph({
      "rule-empty": { domains: [], domainSource: undefined },
    });

    const results = reviewDomains(ruleDomains, graph);
    expect(results[0].status).toBe("no-inference");
  });

  test("skips already-reviewed rules", () => {
    const ruleDomains = {
      "rule-reviewed": { domains: ["verification"], source: "reviewed" },
      "rule-auto": { domains: ["scope"], source: "auto" },
    };
    const graph = makeGraph({
      "rule-reviewed": { domains: ["verification"] },
      "rule-auto": { domains: ["scope"] },
    });

    const results = reviewDomains(ruleDomains, graph);
    expect(results).toHaveLength(1);
    expect(results[0].ruleId).toBe("rule-auto");
  });

  test("matches nodes via normalized IDs (prefix stripping + dash to underscore)", () => {
    const ruleDomains = {
      "feedback_verify_before_answering": { domains: ["verification"], source: "auto-fallback" },
    };
    const graph = makeGraph({
      "verify-before-answering": { domains: ["verification"], domainSource: "keyword" },
    });

    const results = reviewDomains(ruleDomains, graph);
    expect(results[0].status).toBe("reviewed");
    expect(results[0].agreement).toBe(1);
  });

  test("handles auto-fallback and claude-md-prune sources", () => {
    const ruleDomains = {
      "rule-fallback": { domains: ["delegation"], source: "auto-fallback" },
      "rule-prune": { domains: ["deployment"], source: "claude-md-prune" },
    };
    const graph = makeGraph({
      "rule-fallback": { domains: ["delegation"] },
      "rule-prune": { domains: ["deployment"] },
    });

    const results = reviewDomains(ruleDomains, graph);
    expect(results).toHaveLength(2);
    expect(results.every(r => r.status === "reviewed")).toBe(true);
  });

  test("calculates correct agreement ratio for partial overlap", () => {
    const ruleDomains = {
      "rule-partial": { domains: ["verification", "deployment", "scope", "memory"], source: "auto" },
    };
    const graph = makeGraph({
      "rule-partial": { domains: ["verification", "scope"], domainSource: "bm25" },
    });

    const results = reviewDomains(ruleDomains, graph);
    expect(results[0].agreement).toBe(0.5);
    expect(results[0].status).toBe("reviewed");
  });

  test("returns all fields in result", () => {
    const ruleDomains = {
      "rule-fields": { domains: ["scope", "delivery"], source: "auto" },
    };
    const graph = makeGraph({
      "rule-fields": { domains: ["scope"], domainSource: "keyword" },
    });

    const results = reviewDomains(ruleDomains, graph);
    const r = results[0];
    expect(r.ruleId).toBe("rule-fields");
    expect(r.autoDomains).toEqual(["scope", "delivery"]);
    expect(r.inferredDomains).toEqual(["scope"]);
    expect(r.agreement).toBe(0.5);
    expect(r.status).toBe("reviewed");
  });
});

describe("reviewDomains with learned rules text", () => {
  test("uses keyword classification on learned rule text when no graph node", () => {
    const ruleDomains = {
      "always-use-makefile-targets-for-containers": { domains: ["deployment"], source: "auto" },
    };
    const graph = makeGraph({});
    const learnedText = new Map([
      ["always-use-makefile-targets-for-containers", "When deploying containers, always use Makefile targets. Run make rebuild for deploy sequence."],
    ]);

    const results = reviewDomains(ruleDomains, graph, learnedText);
    expect(results[0].status).toBe("reviewed");
    expect(results[0].inferredDomains).toContain("deployment");
  });

  test("falls back to BM25 when keyword classification returns nothing", () => {
    const graph = makeGraph({
      "node-a": { domains: ["verification"], description: "verify data before answering questions" },
      "node-b": { domains: ["verification"], description: "always verify before asserting facts" },
      "node-c": { domains: ["verification"], description: "check and verify all assertions" },
      "node-d": { domains: ["scope"], description: "minimal scope only asked changes" },
    });
    const ruleDomains = {
      "check-assertions-carefully": { domains: ["verification"], source: "auto" },
    };
    const learnedText = new Map([
      ["check-assertions-carefully", "Before asserting any fact, verify it against the actual data and source."],
    ]);

    const results = reviewDomains(ruleDomains, graph, learnedText);
    expect(results[0].status).not.toBe("no-inference");
  });

  test("reports no-inference when learned text has no keyword or BM25 match", () => {
    const graph = makeGraph({});
    const ruleDomains = {
      "obscure-rule": { domains: ["scope"], source: "auto" },
    };
    const learnedText = new Map([
      ["obscure-rule", "Something very generic with no domain signals."],
    ]);

    const results = reviewDomains(ruleDomains, graph, learnedText);
    expect(results[0].status).toBe("no-inference");
  });
});

describe("parseLearnedRules", () => {
  test("extracts rule names and text from CLAUDE-LEARNED.md format", () => {
    const content = `# Rules
- **Upfront Alignment, Then Run (from debrief 2026-04-17):** Present the approach and get agreement first.
- **verify-before-asserting-consolidated (from learning-review 2026-04-30):** Verify before responding.`;

    const rules = parseLearnedRules(content);
    expect(rules.has("upfront-alignment-then-run")).toBe(true);
    expect(rules.get("upfront-alignment-then-run")).toBe("Present the approach and get agreement first.");
    expect(rules.has("verify-before-asserting-consolidated")).toBe(true);
  });

  test("generates both kebab and underscore variants", () => {
    const content = `- **My Test Rule (from session):** Some rule text here.`;
    const rules = parseLearnedRules(content);
    expect(rules.has("my-test-rule")).toBe(true);
    expect(rules.has("my_test_rule")).toBe(true);
  });

  test("returns empty map for non-matching content", () => {
    const rules = parseLearnedRules("# Nothing here\nJust text.");
    expect(rules.size).toBe(0);
  });
});
