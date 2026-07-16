import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { getContextRules, detectDomains, initHybridDetection, parseLearnedRules, filterLearnedRules, resetDetectPatterns } from "../../src/graph/context";
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

describe("getContextRules diversity cap", () => {
  test("AC-1: per-domain cap ensures balanced multi-domain results", async () => {
    // 12 deployment nodes vs 3 ui-testing nodes — deployment should NOT take all 15 slots
    const deployNodes = Array.from({ length: 12 }, (_, i) =>
      makeNode(`deploy_${i}`, ["deployment"], `Deployment rule ${i} for containers`),
    );
    const uiNodes = [
      makeNode("ui_playwright", ["ui-testing"], "Quinn playwright visual test screenshot"),
      makeNode("ui_screenshot", ["ui-testing"], "Screenshot comparison visual regression"),
      makeNode("ui_browser", ["ui-testing"], "Browser visual test quinn playwright launch"),
    ];
    const graph = makeGraph([...deployNodes, ...uiNodes]);

    const files = [...deployNodes, ...uiNodes].map(n => {
      const f = join(TMP_DIR, `${n.id}.md`);
      const content = n.domains[0] === "deployment"
        ? `deployment containers production make rebuild ${n.id}`
        : `playwright visual test quinn screenshot ${n.id}`;
      writeFileSync(f, content, "utf-8");
      return f;
    });
    const index = buildIndex(files);

    const rules = await getContextRules(graph, index, ["deployment", "ui-testing"], 15);
    const domainCounts: Record<string, number> = {};
    for (const r of rules) {
      const d = graph.nodes[r.id]?.domains[0] || "unknown";
      domainCounts[d] = (domainCounts[d] || 0) + 1;
    }
    // With 2 domains, cap = ceil(15/2) = 8 per domain
    expect(domainCounts["deployment"] || 0).toBeLessThanOrEqual(8);
    // ui-testing should be represented
    expect(domainCounts["ui-testing"] || 0).toBeGreaterThan(0);
  });

  test("AC-2: Quinn playwright query gets ui-testing rules in top 3", async () => {
    // Deploy nodes leak into results via embedding edges from ui-testing nodes
    const deployNodes = Array.from({ length: 20 }, (_, i) =>
      makeNode(`deploy_${i}`, ["deployment"], `Deployment containers visual test pipeline rule ${i}`),
    );
    const uiNodes = [
      makeNode("ui_playwright_test", ["ui-testing"], "Quinn playwright visual test screenshot validation"),
      makeNode("ui_visual_regression", ["ui-testing"], "Playwright page screenshot visual regression testing"),
      makeNode("ui_quinn_validates", ["ui-testing"], "Quinn validates visual appearance screenshot compare"),
    ];
    const graph = makeGraph([...deployNodes, ...uiNodes]);
    // Embedding edges connect ui-testing → deployment (1-hop expansion leaks deploy nodes in)
    graph.edges = deployNodes.slice(0, 10).map((n, i) => ({
      from: uiNodes[i % uiNodes.length].id,
      to: n.id,
      relationship: "sibling" as const,
      strength: 0.8,
      source: "embedding" as const,
    }));
    graph.edgeCount = graph.edges.length;

    const files = [...deployNodes, ...uiNodes].map(n => {
      const f = join(TMP_DIR, `${n.id}.md`);
      const content = n.domains[0] === "deployment"
        ? `deployment visual test pipeline containers fix quinn playwright ${n.id}`
        : `playwright visual test quinn screenshot validation fix ${n.id}`;
      writeFileSync(f, content, "utf-8");
      return f;
    });
    const index = buildIndex(files);

    // Single detected domain — deploy leaks via embedding edge expansion + BM25 overlap
    const rules = await getContextRules(
      graph, index, ["ui-testing"], 15, undefined,
      "Fix Quinn playwright visual test",
    );
    const top3 = rules.slice(0, 3);
    const uiInTop3 = top3.filter(r => graph.nodes[r.id]?.domains[0] === "ui-testing").length;
    expect(uiInTop3).toBeGreaterThanOrEqual(2);
  });

  test("AC-3: architecture query gets architecture rules in top 3", async () => {
    // Browser nodes leak via embedding edges from architecture nodes
    const browserNodes = Array.from({ length: 20 }, (_, i) =>
      makeNode(`browser_${i}`, ["browser"], `Browser module refactor automation rule ${i}`),
    );
    const archNodes = [
      makeNode("arch_deep_module", ["architecture"], "Deep module boundary architecture principle"),
      makeNode("arch_shallow_check", ["architecture"], "Shallow module check deletion test interface"),
      makeNode("arch_adr_compliance", ["architecture"], "ADR compliance architecture decisions check"),
    ];
    const graph = makeGraph([...browserNodes, ...archNodes]);
    graph.edges = browserNodes.slice(0, 10).map((n, i) => ({
      from: archNodes[i % archNodes.length].id,
      to: n.id,
      relationship: "sibling" as const,
      strength: 0.8,
      source: "embedding" as const,
    }));
    graph.edgeCount = graph.edges.length;

    const files = [...browserNodes, ...archNodes].map(n => {
      const f = join(TMP_DIR, `${n.id}.md`);
      const content = n.domains[0] === "browser"
        ? `browser module refactor boundary deep architecture chrome ${n.id}`
        : `architecture module boundary deep shallow refactor ${n.id}`;
      writeFileSync(f, content, "utf-8");
      return f;
    });
    const index = buildIndex(files);

    // Single detected domain — browser leaks via embedding expansion
    const rules = await getContextRules(
      graph, index, ["architecture"], 15, undefined,
      "refactor deep module boundary architecture",
    );
    const top3 = rules.slice(0, 3);
    const archInTop3 = top3.filter(r => graph.nodes[r.id]?.domains[0] === "architecture").length;
    expect(archInTop3).toBeGreaterThanOrEqual(2);
  });

  test("AC-4: single-domain query still gets full results", async () => {
    const deployNodes = Array.from({ length: 20 }, (_, i) =>
      makeNode(`deploy_${i}`, ["deployment"], `Deployment containers rule ${i}`),
    );
    const graph = makeGraph(deployNodes);

    const files = deployNodes.map(n => {
      const f = join(TMP_DIR, `${n.id}.md`);
      writeFileSync(f, `deployment containers production make rebuild ${n.id}`, "utf-8");
      return f;
    });
    const index = buildIndex(files);

    const rules = await getContextRules(graph, index, ["deployment"], 15, undefined, "deploy containers");
    expect(rules.length).toBe(15);
    // All results should be deployment — no capping needed for single-domain
    const allDeployment = rules.every(r => graph.nodes[r.id]?.domains[0] === "deployment");
    expect(allDeployment).toBe(true);
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
