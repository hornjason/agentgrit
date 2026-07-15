import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { buildGraph, loadRuleDomains, defaultRuleDomainsPath, resetClassifyPatterns } from "../../src/graph/builder";
import { buildIndexFromDir } from "../../src/graph/bm25";
import { getContextRules, initHybridDetection } from "../../src/graph/context";
import type { Graph } from "../../src/graph/types";

const TMP_DIR = join(import.meta.dir, ".tmp-handoff-chain");
const RULES_DIR = join(TMP_DIR, "rules");
const STATE_DIR = join(TMP_DIR, "state");
const RD_PATH = join(TMP_DIR, "rule-domains.json");

function writeRule(id: string, opts: { name: string; description: string; type: string; body: string }): void {
  const content = `---
name: ${opts.name}
description: ${opts.description}
metadata:
  type: ${opts.type}
---

${opts.body}`;
  writeFileSync(join(RULES_DIR, `${id}.md`), content, "utf-8");
}

function readRuleDomains(): Record<string, { domains: string[]; source: string }> {
  if (!existsSync(RD_PATH)) return {};
  const parsed = JSON.parse(readFileSync(RD_PATH, "utf-8"));
  return parsed.rules || {};
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

describe("end-to-end handoff chain", () => {
  test("rule .md → graph node → rule-domains.json entry → context injection", async () => {
    // 1. Create rule files with domain-relevant content
    writeRule("feedback_verify_before_deploy", {
      name: "verify-before-deploy",
      description: "Always verify deployment artifacts before deploying to production",
      type: "feedback",
      body: "Never deploy without verification. Check container health, run smoke tests, and confirm the deployment target is correct. This is a hard stop rule with zero exceptions.",
    });

    writeRule("feedback_test_browser_first", {
      name: "test-browser-first",
      description: "Always test in browser before claiming UI work is done",
      type: "feedback",
      body: "Browser testing must happen before marking any UI task complete. Use Playwright or manual browser verification to confirm visual correctness.",
    });

    writeRule("success_audit_pattern", {
      name: "audit-then-fix",
      description: "Audit existing state before making changes",
      type: "success",
      body: "Always verify the current state of the system before making architectural changes. Read the deployment config and verify infrastructure.",
    });

    // 2. Build graph — should create nodes AND sync rule-domains.json
    const graph = await buildGraph(RULES_DIR, STATE_DIR, RD_PATH);

    // 3. Verify nodes exist in graph
    expect(Object.keys(graph.nodes)).toContain("feedback_verify_before_deploy");
    expect(Object.keys(graph.nodes)).toContain("feedback_test_browser_first");
    expect(Object.keys(graph.nodes)).toContain("success_audit_pattern");

    // 4. Verify all nodes with domains have rule-domains.json entries
    const rdRules = readRuleDomains();
    const nodesWithDomains = Object.values(graph.nodes).filter(n => n.domains.length > 0);

    for (const node of nodesWithDomains) {
      expect(rdRules[node.id]).toBeDefined();
      expect(rdRules[node.id].domains).toEqual(node.domains);
      expect(rdRules[node.id].source).toBe("auto");
    }

    // 5. Verify context injection works — a deployment query should find the deploy rule
    const index = buildIndexFromDir(RULES_DIR);
    initHybridDetection(graph);
    const rules = await getContextRules(graph, index, ["deployment", "verification"], 10, undefined, "deploy verification production");

    const ruleIds = rules.map(r => r.id);
    expect(ruleIds).toContain("feedback_verify_before_deploy");
  });

  test("stale rule-domains.json entries are pruned after graph build", async () => {
    // 1. Create initial rule-domains.json with stale entries
    const staleRd = {
      version: 1,
      reviewed: false,
      rules: {
        "deleted_rule_one": { domains: ["verification"], source: "auto" },
        "deleted_rule_two": { domains: ["deployment"], source: "auto" },
        "stale_orphan": { domains: ["scope"], source: "auto" },
      },
    };
    writeFileSync(RD_PATH, JSON.stringify(staleRd, null, 2), "utf-8");

    // 2. Create one real rule
    writeRule("feedback_real_rule", {
      name: "real-rule",
      description: "Always verify deployment before claiming done",
      type: "feedback",
      body: "Never deploy without verification. Always check the container health before reporting deployment is complete.",
    });

    // 3. Build graph
    await buildGraph(RULES_DIR, STATE_DIR, RD_PATH);

    // 4. Verify stale entries removed, real entry added
    const rdRules = readRuleDomains();
    expect(rdRules["deleted_rule_one"]).toBeUndefined();
    expect(rdRules["deleted_rule_two"]).toBeUndefined();
    expect(rdRules["stale_orphan"]).toBeUndefined();
    expect(rdRules["feedback_real_rule"]).toBeDefined();
  });

  test("reviewed entries are preserved during sync", async () => {
    // 1. Pre-populate rule-domains.json with a reviewed entry for an existing rule
    writeRule("feedback_reviewed_rule", {
      name: "reviewed-rule",
      description: "A rule with reviewed domains that should be preserved",
      type: "feedback",
      body: "This rule has been manually reviewed and its domains confirmed. Verification and deployment scope.",
    });

    const rdWithReviewed = {
      version: 1,
      reviewed: false,
      rules: {
        "feedback_reviewed_rule": {
          domains: ["verification", "deployment"],
          source: "reviewed",
        },
        "stale_entry": { domains: ["scope"], source: "auto" },
      },
    };
    writeFileSync(RD_PATH, JSON.stringify(rdWithReviewed, null, 2), "utf-8");

    // 2. Build graph
    await buildGraph(RULES_DIR, STATE_DIR, RD_PATH);

    // 3. Reviewed entry preserved, stale entry removed
    const rdRules = readRuleDomains();
    expect(rdRules["feedback_reviewed_rule"]).toBeDefined();
    expect(rdRules["feedback_reviewed_rule"].source).toBe("reviewed");
    expect(rdRules["stale_entry"]).toBeUndefined();
  });

  test("nodes without domains do not get rule-domains.json entries", async () => {
    // Create a rule with content that won't match any keyword patterns
    writeRule("feedback_ambiguous_thing", {
      name: "ambiguous-thing",
      description: "Something vague",
      type: "feedback",
      body: "This is intentionally vague with no domain keywords.",
    });

    const graph = await buildGraph(RULES_DIR, STATE_DIR, RD_PATH);

    const node = graph.nodes["feedback_ambiguous_thing"];
    const rdRules = readRuleDomains();

    // If the node got no domains, it should have no rd entry
    if (node.domains.length === 0) {
      expect(rdRules["feedback_ambiguous_thing"]).toBeUndefined();
    }
  });
});
