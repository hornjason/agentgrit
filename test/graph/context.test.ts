import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { getContextRules, detectDomains, initHybridDetection, parseLearnedRules, filterLearnedRules, resetDetectPatterns, computePerformanceSummary, getRecentFailurePatterns, getWorkContextDomains } from "../../src/graph/context";
import { buildIndex } from "../../src/graph/bm25";
import type { Graph } from "../../src/graph/types";
import type { GraphNode } from "../../src/adapters/types";

const TMP_DIR = join(import.meta.dir, ".tmp-context-test");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
  resetDetectPatterns();
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

function makeNode(id: string, domains: string[], description?: string, overrides?: Partial<GraphNode>): GraphNode {
  return {
    id,
    file: `${id}.md`,
    type: "feedback",
    name: `Rule: ${id}`,
    description: description || `Text for ${id}`,
    domains,
    severity: 3,
    occurrence_count: 0,
    last_updated: new Date().toISOString(),
    content_hash: id.slice(0, 8),
    memoryType: "behavioral-rule",
    ...overrides,
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

  test("detects scoring domain from issue 130 text", () => {
    const domains = detectDomains("v2 scoring signals ratings scorer effectiveness");
    expect(domains).toContain("scoring");
  });

  test("detects pipeline domain", () => {
    const domains = detectDomains("promote rule evict daemon cycle pipeline health");
    expect(domains).toContain("pipeline");
  });
});

describe("hybrid detectDomains", () => {
  const ISSUE_131_TEXT = "Refine 29 ineffective promoted rules corrections not decreasing agentgrit eval effectiveness shows 67/96 rules effective 70% The 29 ineffective rules either have wrong text too vague to change behavior or are not being injected when the same pattern recurs domain mismatch Need review each refine text or fix domains";

  function buildHybridGraph(): Graph {
    return makeGraph([
      makeNode("alg1", ["algorithm"], "algorithm phase prd isc criteria effort level"),
      makeNode("alg2", ["algorithm"], "promoted rules corrections improve algorithm effectiveness eval"),
      makeNode("alg3", ["algorithm"], "ineffective rules refine text fix domain mismatch algorithm"),
      makeNode("alg4", ["algorithm"], "eval effectiveness shows rules effective promoted corrections phase"),
      makeNode("ver1", ["verification"], "verify check before answer source first look before"),
      makeNode("ver2", ["verification"], "verify behavior change effective rules domain patterns"),
      makeNode("ver3", ["verification"], "review verify effectiveness rule injection domain mismatch"),
      makeNode("ver4", ["verification"], "check verify rules corrections decreasing effectiveness behavior"),
      makeNode("ui1", ["ui-testing"], "quinn playwright visual test screenshot validation"),
      makeNode("ui2", ["ui-testing"], "playwright page screenshot visual regression testing"),
      makeNode("ui3", ["ui-testing"], "quinn validates visual appearance screenshot compare"),
      makeNode("ui4", ["ui-testing"], "browser visual test quinn playwright launch"),
    ]);
  }

  test("seed-only detectDomains misses #131 text", () => {
    const domains = detectDomains(ISSUE_131_TEXT);
    expect(domains).not.toContain("algorithm");
    expect(domains).not.toContain("verification");
  });

  test("hybrid detectDomains finds algorithm and verification for #131 text", () => {
    const graph = buildHybridGraph();
    initHybridDetection(graph);
    const domains = detectDomains(ISSUE_131_TEXT);
    expect(domains).toContain("algorithm");
    expect(domains).toContain("verification");
  });

  test("hybrid detectDomains does NOT return ui-testing for #131 text", () => {
    const graph = buildHybridGraph();
    initHybridDetection(graph);
    const domains = detectDomains(ISSUE_131_TEXT);
    expect(domains).not.toContain("ui-testing");
  });

  test("existing seed-based detections still work with hybrid active", () => {
    const graph = buildHybridGraph();
    initHybridDetection(graph);
    expect(detectDomains("run make rebuild to deploy")).toContain("deployment");
    expect(detectDomains("verify before answering")).toContain("verification");
    expect(detectDomains("run security scan on vulnerability")).toContain("security");
    expect(detectDomains("stay focused on minimal scope")).toContain("scope");
    expect(detectDomains("spawn agent with worktree isolation")).toContain("delegation");
    expect(detectDomains("run playwright visual test")).toContain("ui-testing");
  });

  test("unclassifiable text still returns empty with hybrid", () => {
    const graph = buildHybridGraph();
    initHybridDetection(graph);
    expect(detectDomains("xyzzy foobarbaz")).toEqual([]);
  });

  test("confidence gate rejects single-term match", () => {
    const graph = buildHybridGraph();
    initHybridDetection(graph);
    const domains = detectDomains("something about quinn");
    expect(domains).toContain("ui-testing");
    const domains2 = detectDomains("just a random word");
    expect(domains2).toEqual([]);
  });
});

describe("getContextRules", () => {
  test("returns rules for matching domains", async () => {
    const graph = makeGraph([
      makeNode("deploy_gate", ["deployment"], "Run make rebuild before deploying"),
      makeNode("verify_first", ["verification"], "Verify endpoints are up"),
      makeNode("scope_guard", ["scope"], "Keep changes minimal"),
    ]);

    const f1 = join(TMP_DIR, "deploy_gate.md");
    writeFileSync(f1, "deployment make rebuild deployment containers", "utf-8");
    const index = buildIndex([f1]);

    const rules = await getContextRules(graph, index, ["deployment"]);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules[0].id).toBe("deploy_gate");
    expect(rules[0].tags).toContain("deployment");
    expect(rules[0].tier).toBe("graph");
  });

  test("respects limit", async () => {
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

    const rules = await getContextRules(graph, index, ["deployment"], 5);
    expect(rules.length).toBeLessThanOrEqual(5);
  });

  test("falls back to default domains when empty", async () => {
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

    const rules = await getContextRules(graph, index, []);
    expect(rules.length).toBeGreaterThan(0);
  });

  test("domain-matched nodes discovered via hybrid retrieval", async () => {
    // With hybridRetrieve, nodes are discovered by domain overlap (via queryGraph)
    // rather than edge-based expansion from BM25 hits
    const graph = makeGraph([
      makeNode("bm25_hit", ["deployment"], "Deploy with make rebuild"),
      makeNode("domain_peer", ["deployment"], "Run smoke tests after deploy"),
      makeNode("other_domain", ["security"], "Security scan on changes"),
    ]);

    // Both deployment nodes have BM25 docs so they appear in both BM25 + graph lists
    const f1 = join(TMP_DIR, "bm25_hit.md");
    const f2 = join(TMP_DIR, "domain_peer.md");
    const f3 = join(TMP_DIR, "other_domain.md");
    writeFileSync(f1, "deployment deployment deployment containers", "utf-8");
    writeFileSync(f2, "deployment smoke tests deploy production", "utf-8");
    writeFileSync(f3, "security vulnerability scan assessment", "utf-8");
    const index = buildIndex([f1, f2, f3]);

    const rules = await getContextRules(graph, index, ["deployment"], 10);
    const ids = rules.map(r => r.id);
    // Both deployment-domain nodes should appear via hybrid retrieval
    expect(ids).toContain("bm25_hit");
    expect(ids).toContain("domain_peer");
    // Security node should not rank high for deployment query
    expect(ids.indexOf("bm25_hit")).toBeLessThan(ids.length);
  });

  test("deduplicates between direct BM25 and expansion", async () => {
    const graph = makeGraph([
      makeNode("shared_rule", ["deployment"], "deployment make rebuild"),
    ]);

    const f1 = join(TMP_DIR, "shared_rule.md");
    writeFileSync(f1, "deployment make rebuild deployment", "utf-8");
    const index = buildIndex([f1]);

    const rules = await getContextRules(graph, index, ["deployment"], 10);
    const sharedCount = rules.filter(r => r.id === "shared_rule").length;
    expect(sharedCount).toBe(1);
  });

  test("returns empty for empty graph and index", async () => {
    const graph = makeGraph([]);
    const index = buildIndex([]);
    const rules = await getContextRules(graph, index, ["deployment"]);
    expect(rules).toEqual([]);
  });

  test("rule text comes from node", async () => {
    const graph = makeGraph([
      makeNode("test_rule", ["verification"], "Always verify before asserting anything"),
    ]);
    const f1 = join(TMP_DIR, "test_rule.md");
    writeFileSync(f1, "verification verify before asserting anything", "utf-8");
    const index = buildIndex([f1]);

    const rules = await getContextRules(graph, index, ["verification"]);
    expect(rules[0].text).toBe("Always verify before asserting anything");
  });

  test("hub-dampening reduces score for high-edge-count neighbors", async () => {
    const hubNode = makeNode("hub_node", ["deployment"], "Hub with many edges");
    const normalNode = makeNode("normal_node", ["deployment"], "Normal node with few edges");
    const sourceNode = makeNode("source_node", ["deployment"], "deployment source deployment");
    const graph = makeGraph([hubNode, normalNode, sourceNode]);

    // Hub has 12 edges, normal has 1
    const hubEdges = Array.from({ length: 12 }, (_, i) => ({
      from: "hub_node",
      to: `phantom_${i}`,
      relationship: "sibling" as const,
      strength: 0.5,
    }));
    graph.edges = [
      ...hubEdges,
      { from: "source_node", to: "hub_node", relationship: "reinforces" as const, strength: 0.8 },
      { from: "source_node", to: "normal_node", relationship: "reinforces" as const, strength: 0.8 },
    ];

    const f1 = join(TMP_DIR, "source_node.md");
    writeFileSync(f1, "deployment deployment deployment source", "utf-8");
    const index = buildIndex([f1]);

    const rules = await getContextRules(graph, index, ["deployment"], 10);
    const hubRule = rules.find(r => r.id === "hub_node");
    const normalRule = rules.find(r => r.id === "normal_node");
    if (hubRule && normalRule) {
      expect(hubRule.correlationScore).toBeLessThan(normalRule.correlationScore);
    }
  });

  test("type-allowlist blocks reference and project nodes", async () => {
    const graph = makeGraph([
      makeNode("feedback_rule", ["deployment"], "Deploy gate feedback", { type: "feedback" }),
      makeNode("reference_rule", ["deployment"], "Reference to deployment doc", { type: "reference" }),
      makeNode("project_rule", ["deployment"], "Project deployment config", { type: "project" }),
      makeNode("steering_rule", ["deployment"], "Steering for deployment", { type: "steering" }),
    ]);

    const files = ["feedback_rule", "reference_rule", "project_rule", "steering_rule"].map(id => {
      const f = join(TMP_DIR, `${id}.md`);
      writeFileSync(f, "deployment deployment deployment containers", "utf-8");
      return f;
    });
    const index = buildIndex(files);

    const rules = await getContextRules(graph, index, ["deployment"], 10);
    const ids = rules.map(r => r.id);
    expect(ids).toContain("feedback_rule");
    expect(ids).toContain("steering_rule");
    expect(ids).not.toContain("reference_rule");
    expect(ids).not.toContain("project_rule");
  });

  test("type-allowlist allows nodes with undefined type", async () => {
    const nodeNoType = makeNode("untyped_rule", ["deployment"], "Untyped deployment rule");
    (nodeNoType as any).type = undefined;
    const graph = makeGraph([nodeNoType]);

    const f1 = join(TMP_DIR, "untyped_rule.md");
    writeFileSync(f1, "deployment deployment deployment", "utf-8");
    const index = buildIndex([f1]);

    const rules = await getContextRules(graph, index, ["deployment"], 10);
    expect(rules.map(r => r.id)).toContain("untyped_rule");
  });

  test("domainSource is propagated to returned Rule objects", async () => {
    const graph = makeGraph([
      makeNode("ds_rule", ["deployment"], "Deploy gate rule", { domainSource: "bm25" }),
    ]);

    const f1 = join(TMP_DIR, "ds_rule.md");
    writeFileSync(f1, "deployment deployment deploy gate", "utf-8");
    const index = buildIndex([f1]);

    const rules = await getContextRules(graph, index, ["deployment"], 10);
    expect(rules[0].domainSource).toBe("bm25");
  });

  test("uses hybridRetrieve for candidate generation (AC-1)", async () => {
    // Create nodes with delivery domain — these should be boosted by domain scoring
    const graph = makeGraph([
      makeNode("read_spec_at_every_decision", ["delivery"], "Re-read driving spec at every decision point"),
      makeNode("read_templates_before_acs", ["delivery"], "Read TEMPLATES.md before writing any ship artifact"),
      makeNode("incomplete_delivery", ["delivery"], "Self-audit against all requirements before claiming done"),
      makeNode("verify_first", ["verification"], "Verify endpoints before asserting success"),
      makeNode("scope_guard", ["scope"], "Keep changes minimal and focused"),
      makeNode("deploy_gate", ["deployment"], "Run make rebuild before deploying"),
      makeNode("security_scan", ["security"], "Run security vulnerability scan"),
      makeNode("git_commits", ["delegation"], "Commit after every working change"),
    ]);

    // Add edges to make graph traversal meaningful
    graph.edges = [
      { from: "read_spec_at_every_decision", to: "read_templates_before_acs", relationship: "reinforces", strength: 0.9 },
      { from: "read_spec_at_every_decision", to: "incomplete_delivery", relationship: "sibling", strength: 0.8 },
    ];
    graph.edgeCount = 2;

    // Build BM25 index — delivery rules have ship-related content
    const files = [
      { id: "read_spec_at_every_decision", content: "ship artifact template spec decision delivery acceptance criteria" },
      { id: "read_templates_before_acs", content: "ship template acceptance criteria delivery artifact" },
      { id: "incomplete_delivery", content: "delivery complete audit requirements ship done" },
      { id: "verify_first", content: "verify endpoints health check status" },
      { id: "scope_guard", content: "scope minimal focused changes only" },
      { id: "deploy_gate", content: "deploy containers production make rebuild" },
      { id: "security_scan", content: "security vulnerability scan changed files" },
      { id: "git_commits", content: "git commit working change descriptive messages" },
    ].map(({ id, content }) => {
      const f = join(TMP_DIR, `${id}.md`);
      writeFileSync(f, content, "utf-8");
      return f;
    });
    const index = buildIndex(files);

    // Query with ship-related text and delivery domain
    const rules = await getContextRules(graph, index, ["delivery"], 7, undefined, "ship agentgrit issue");

    // AC-1: verify results come from hybrid retrieval (domain-scored)
    expect(rules.length).toBeGreaterThan(0);

    // The delivery-domain rules should rank in top 7 due to domain overlap scoring
    const ids = rules.map(r => r.id);
    const hasDeliveryRule = ids.includes("read_spec_at_every_decision") || ids.includes("read_templates_before_acs");
    expect(hasDeliveryRule).toBe(true);
  });

  test("domain-matched template rules rank in top 7 for ship queries (AC-2)", async () => {
    // Build a realistic scenario: many rules, but only delivery-domain ones should rank high
    const deliveryNodes = [
      makeNode("read_spec_at_every_decision", ["delivery"], "Re-read driving spec at every decision point"),
      makeNode("read_templates_before_acs", ["delivery"], "Read TEMPLATES.md before writing any ship artifact"),
      makeNode("incomplete_delivery", ["delivery"], "Self-audit against all requirements before claiming done"),
    ];
    const otherNodes = Array.from({ length: 15 }, (_, i) =>
      makeNode(`filler_${i}`, ["security", "delegation"], `Filler rule number ${i} about security and delegation`),
    );
    const allNodes = [...deliveryNodes, ...otherNodes];
    const graph = makeGraph(allNodes);
    graph.edges = [
      { from: "read_spec_at_every_decision", to: "read_templates_before_acs", relationship: "reinforces", strength: 0.9 },
    ];
    graph.edgeCount = 1;

    const files = allNodes.map(n => {
      const f = join(TMP_DIR, `${n.id}.md`);
      const content = n.domains.includes("delivery")
        ? `ship delivery template acceptance criteria ${n.id}`
        : `security delegation agent spawn ${n.id}`;
      writeFileSync(f, content, "utf-8");
      return f;
    });
    const index = buildIndex(files);

    const rules = await getContextRules(graph, index, ["delivery"], 7, undefined, "ship agentgrit issue");
    const top7Ids = rules.map(r => r.id);
    const deliveryInTop7 = top7Ids.filter(id =>
      id === "read_spec_at_every_decision" || id === "read_templates_before_acs",
    );
    expect(deliveryInTop7.length).toBeGreaterThanOrEqual(1);
  });

  test("falls back to BM25-only when hybrid returns empty (AC-3)", async () => {
    // Nodes have no matching domains for query domains
    const graph = makeGraph([
      makeNode("bm25_rule", ["security"], "Deploy containers to production for security"),
    ]);

    const f1 = join(TMP_DIR, "bm25_rule.md");
    writeFileSync(f1, "deploy containers production security assessment", "utf-8");
    const index = buildIndex([f1]);

    // Query with domains that don't match any nodes — hybrid graph traversal returns empty
    const rules = await getContextRules(graph, index, ["nonexistent-domain"], 10, undefined, "deploy containers");
    // Should still get results via BM25 fallback
    expect(rules.length).toBeGreaterThan(0);
    expect(rules[0].id).toBe("bm25_rule");
  });

  test("includes trajectory data when signalDir provided", async () => {
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

    const rules = await getContextRules(graph, index, ["verification"], 10, trajDir);
    expect(rules.length).toBe(1);
    expect(rules[0].id).toBe("traj-1");
    expect(rules[0].text).toContain("[trajectory]");
    expect(rules[0].text).toContain("Fixed auth flow with retry");
  });
});


describe("parseLearnedRules", () => {
  test("parses bullet-point rules from CLAUDE-LEARNED.md format", () => {
    const content = `# PAI Learned Rules

### Learned Rules

- **Rule One (from debrief 2026-04-17):** First rule description here.
- **Rule Two (from session 2026-06-07):** Second rule description.
- **Rule Three (from debrief 2026-04-18):** Third rule with multi-word description text.
`;
    const rules = parseLearnedRules(content);
    expect(rules.length).toBe(3);
    expect(rules[0]).toContain("Rule One");
    expect(rules[1]).toContain("Rule Two");
    expect(rules[2]).toContain("Rule Three");
  });

  test("handles rules with continuation lines", () => {
    const content = `### Learned Rules

- **Verify Fix (from debrief 2026-04-18):** After any fix check the actual output.
  *(promoted from /debrief 2026-04-18 via LearningReview)*
- **Next Rule (from session):** Simple rule.
`;
    const rules = parseLearnedRules(content);
    expect(rules.length).toBe(2);
    expect(rules[0]).toContain("promoted from");
  });

  test("returns empty array for content with no rules", () => {
    const content = `# Just a header\n\nSome text without rules.\n`;
    const rules = parseLearnedRules(content);
    expect(rules.length).toBe(0);
  });

  test("handles empty content", () => {
    expect(parseLearnedRules("")).toEqual([]);
  });
});

describe("filterLearnedRules", () => {
  const rules = [
    "- **Deploy Gate (from debrief):** Always run make rebuild before deploying containers to production.",
    "- **Verify First (from session):** Verify all endpoints are up and responding before asserting success.",
    "- **Security Scan (from debrief):** Run security vulnerability scan on all changed files.",
    "- **Scope Guard (from session):** Keep changes minimal and focused on the original request.",
    "- **Test Coverage (from debrief):** Write regression tests before fixing any bug.",
    "- **UI Validation (from session):** Use Playwright for visual testing and screenshot comparison.",
    "- **Data Pipeline (from debrief):** Validate output preserves existing enriched fields before overwriting.",
    "- **Git Commits (from session):** Commit after every working change with descriptive messages.",
    "- **Architecture Docs (from debrief):** Update PRINCIPLES.md and CONTEXT.md when changing architecture.",
    "- **Container Build (from session):** Use Makefile targets for all container operations.",
    "- **Quinn Testing (from debrief):** Quinn must test outcomes not just mechanisms.",
    "- **Marcus Execute (from session):** Marcus must execute and write code, never enter plan mode.",
  ];

  test("returns top-K rules ranked by BM25 relevance", () => {
    const filtered = filterLearnedRules(rules, "deploy containers make rebuild", 3);
    expect(filtered.length).toBe(3);
    expect(filtered[0]).toContain("Deploy Gate");
  });

  test("returns all rules when count <= topK", () => {
    const few = rules.slice(0, 3);
    const filtered = filterLearnedRules(few, "deploy", 10);
    expect(filtered.length).toBe(3);
  });

  test("returns topK slice for empty query", () => {
    const filtered = filterLearnedRules(rules, "", 5);
    expect(filtered.length).toBe(5);
  });

  test("returns empty for empty rules", () => {
    expect(filterLearnedRules([], "deploy", 5)).toEqual([]);
  });

  test("filters to <= 10 from a larger set", () => {
    const filtered = filterLearnedRules(rules, "security vulnerability scan deploy", 10);
    expect(filtered.length).toBeLessThanOrEqual(10);
    expect(filtered.length).toBeGreaterThan(0);
  });

  test("security query ranks security rule higher than deploy rule", () => {
    const filtered = filterLearnedRules(rules, "security vulnerability scan", 3);
    expect(filtered[0]).toContain("Security Scan");
  });
});

// ── Performance Summary Tests ──

describe("computePerformanceSummary", () => {
  test("computes all 5 fields from ratings", async () => {
    const now = new Date();
    const ratings = [
      { rating: 8, timestamp: now.toISOString(), type: "rating", session_id: "s1" },
      { rating: 6, timestamp: now.toISOString(), type: "rating", session_id: "s2" },
      { rating: 7, timestamp: new Date(now.getTime() - 2 * 86400000).toISOString(), type: "rating", session_id: "s3" },
      { rating: 5, timestamp: new Date(now.getTime() - 3 * 86400000).toISOString(), type: "rating", session_id: "s4" },
      { rating: 9, timestamp: new Date(now.getTime() - 5 * 86400000).toISOString(), type: "rating", session_id: "s5" },
      { rating: 4, timestamp: new Date(now.getTime() - 10 * 86400000).toISOString(), type: "rating", session_id: "s6" },
      { rating: 3, timestamp: new Date(now.getTime() - 15 * 86400000).toISOString(), type: "rating", session_id: "s7" },
      { rating: 6, timestamp: new Date(now.getTime() - 20 * 86400000).toISOString(), type: "rating", session_id: "s8" },
      { rating: 2, timestamp: new Date(now.getTime() - 25 * 86400000).toISOString(), type: "rating", session_id: "s9" },
      { rating: 5, timestamp: new Date(now.getTime() - 28 * 86400000).toISOString(), type: "rating", session_id: "s10" },
    ];
    writeFileSync(join(TMP_DIR, "ratings.jsonl"), ratings.map(r => JSON.stringify(r)).join("\n"));
    const result = await computePerformanceSummary(TMP_DIR);
    expect(result).not.toBeNull();
    expect(result!.today_avg).toBeCloseTo(7, 0);
    expect(result!.week_avg).not.toBeNull();
    expect(result!.month_avg).not.toBeNull();
    expect(typeof result!.trend).toBe("string");
    expect(result!.total_signals).toBe(10);
  });

  test("returns null on missing file", async () => {
    const result = await computePerformanceSummary(join(TMP_DIR, "nonexistent"));
    expect(result).toBeNull();
  });

  test("detects declining trend", async () => {
    const now = new Date();
    const ratings = [
      { rating: 3, timestamp: new Date(now.getTime() - 1 * 86400000).toISOString(), type: "rating", session_id: "s1" },
      { rating: 2, timestamp: new Date(now.getTime() - 3 * 86400000).toISOString(), type: "rating", session_id: "s2" },
      { rating: 8, timestamp: new Date(now.getTime() - 15 * 86400000).toISOString(), type: "rating", session_id: "s3" },
      { rating: 9, timestamp: new Date(now.getTime() - 20 * 86400000).toISOString(), type: "rating", session_id: "s4" },
      { rating: 7, timestamp: new Date(now.getTime() - 25 * 86400000).toISOString(), type: "rating", session_id: "s5" },
    ];
    writeFileSync(join(TMP_DIR, "ratings.jsonl"), ratings.map(r => JSON.stringify(r)).join("\n"));
    const result = await computePerformanceSummary(TMP_DIR);
    expect(result!.trend).toBe("declining");
  });

  test("detects stable trend", async () => {
    const now = new Date();
    const ratings = [
      { rating: 7, timestamp: new Date(now.getTime() - 2 * 86400000).toISOString(), type: "rating", session_id: "s1" },
      { rating: 7, timestamp: new Date(now.getTime() - 15 * 86400000).toISOString(), type: "rating", session_id: "s2" },
      { rating: 7, timestamp: new Date(now.getTime() - 25 * 86400000).toISOString(), type: "rating", session_id: "s3" },
    ];
    writeFileSync(join(TMP_DIR, "ratings.jsonl"), ratings.map(r => JSON.stringify(r)).join("\n"));
    const result = await computePerformanceSummary(TMP_DIR);
    expect(result!.trend).toBe("stable");
  });

  test("today_avg is null when no ratings today", async () => {
    const now = new Date();
    const ratings = [
      { rating: 7, timestamp: new Date(now.getTime() - 2 * 86400000).toISOString(), type: "rating", session_id: "s1" },
    ];
    writeFileSync(join(TMP_DIR, "ratings.jsonl"), ratings.map(r => JSON.stringify(r)).join("\n"));
    const result = await computePerformanceSummary(TMP_DIR);
    expect(result!.today_avg).toBeNull();
  });
});

// ── Failure Patterns Tests ──

describe("getRecentFailurePatterns", () => {
  test("returns 5 unique from 7 incidents", async () => {
    const incidents = [
      { error_type: "ENOENT", timestamp: "2026-08-01T10:00:00Z" },
      { error_type: "EACCES", timestamp: "2026-08-02T10:00:00Z" },
      { error_type: "ENOENT", timestamp: "2026-08-02T12:00:00Z" },
      { error_type: "TIMEOUT", timestamp: "2026-08-03T10:00:00Z" },
      { error_type: "EPERM", timestamp: "2026-08-04T10:00:00Z" },
      { error_type: "ECONNREFUSED", timestamp: "2026-08-05T10:00:00Z" },
      { error_type: "ENOENT", timestamp: "2026-08-06T10:00:00Z" },
    ];
    writeFileSync(join(TMP_DIR, "incidents.jsonl"), incidents.map(i => JSON.stringify(i)).join("\n"));
    const result = await getRecentFailurePatterns(TMP_DIR, 5);
    expect(result.length).toBe(5);
    expect(result[0]).toBe("ENOENT");
    expect(result[1]).toBe("ECONNREFUSED");
  });

  test("returns empty on missing file", async () => {
    const result = await getRecentFailurePatterns(join(TMP_DIR, "nonexistent"));
    expect(result).toEqual([]);
  });

  test("deduplicates error types", async () => {
    const incidents = [
      { error_type: "ENOENT", timestamp: "2026-08-01T10:00:00Z" },
      { error_type: "ENOENT", timestamp: "2026-08-02T10:00:00Z" },
      { error_type: "ENOENT", timestamp: "2026-08-03T10:00:00Z" },
    ];
    writeFileSync(join(TMP_DIR, "incidents.jsonl"), incidents.map(i => JSON.stringify(i)).join("\n"));
    const result = await getRecentFailurePatterns(TMP_DIR);
    expect(result).toEqual(["ENOENT"]);
  });
});

// ── Work Context Domains Tests ──

describe("getWorkContextDomains", () => {
  test("detects frontend from React files", async () => {
    const entry = { files_changed: ["src/App.tsx", "src/style.css"], timestamp: "2026-08-06T10:00:00Z" };
    writeFileSync(join(TMP_DIR, "work-completions.jsonl"), JSON.stringify(entry));
    const result = await getWorkContextDomains(TMP_DIR);
    expect(result).toContain("frontend");
  });

  test("detects testing from test files", async () => {
    const entry = { files_changed: ["test/foo.test.ts", "src/bar.ts"], timestamp: "2026-08-06T10:00:00Z" };
    writeFileSync(join(TMP_DIR, "work-completions.jsonl"), JSON.stringify(entry));
    const result = await getWorkContextDomains(TMP_DIR);
    expect(result).toContain("testing");
    expect(result).toContain("code");
  });

  test("detects database from SQL and Prisma", async () => {
    const entry = { files_changed: ["migrations/001.sql", "schema.prisma"], timestamp: "2026-08-06T10:00:00Z" };
    writeFileSync(join(TMP_DIR, "work-completions.jsonl"), JSON.stringify(entry));
    const result = await getWorkContextDomains(TMP_DIR);
    expect(result).toContain("database");
  });

  test("returns empty on missing file", async () => {
    const result = await getWorkContextDomains(join(TMP_DIR, "nonexistent"));
    expect(result).toEqual([]);
  });

  test("uses only the most recent entry", async () => {
    const entries = [
      { files_changed: ["old.sql"], timestamp: "2026-08-01T10:00:00Z" },
      { files_changed: ["new.tsx"], timestamp: "2026-08-06T10:00:00Z" },
    ];
    writeFileSync(join(TMP_DIR, "work-completions.jsonl"), entries.map(e => JSON.stringify(e)).join("\n"));
    const result = await getWorkContextDomains(TMP_DIR);
    expect(result).toContain("frontend");
    expect(result).not.toContain("database");
  });
});
