import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { writeRuleFile, updateRuleDomains, appendToLearnedMd } from "../../src/promote/sync";
import { buildGraph, resetClassifyPatterns } from "../../src/graph/builder";
import { buildIndexFromDir } from "../../src/graph/bm25";
import { getContextRules, initHybridDetection } from "../../src/graph/context";
import { Tier, SCHEMA_VERSION } from "../../src/adapters/types";
import type { Rule } from "../../src/adapters/types";

const TMP_DIR = join(import.meta.dir, ".tmp-promotion-lifecycle");
const RULES_DIR = join(TMP_DIR, "rules");
const STATE_DIR = join(TMP_DIR, "state");
const RD_PATH = join(TMP_DIR, "rule-domains.json");
const LEARNED_PATH = join(TMP_DIR, "CLAUDE-LEARNED.md");

function makeRule(id: string, text: string): Rule {
  return {
    id,
    text,
    tier: Tier.Graph,
    tags: [],
    created: new Date().toISOString(),
    correlationScore: 0,
    sourceSignals: [],
    schemaVersion: SCHEMA_VERSION,
  };
}

function readRuleDomains(): Record<string, { domains: string[]; source: string }> {
  if (!existsSync(RD_PATH)) return {};
  return JSON.parse(readFileSync(RD_PATH, "utf-8")).rules || {};
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

describe("promotion lifecycle — vertical slice", () => {
  test("rule flows from writeRuleFile → updateRuleDomains → appendToLearnedMd → buildGraph → getContextRules", async () => {
    const rule = makeRule(
      "feedback_verify_before_deploy",
      "Always verify deployment artifacts before deploying to production. Never deploy without verification. Check container health, run smoke tests.",
    );

    // Step 1: writeRuleFile — verify .md file created with correct frontmatter
    const filePath = writeRuleFile(rule, RULES_DIR);
    expect(existsSync(filePath)).toBe(true);

    const fileContent = readFileSync(filePath, "utf-8");
    expect(fileContent).toContain("name: feedback_verify_before_deploy");
    expect(fileContent).toContain(rule.text);

    // Step 2: updateRuleDomains — verify rule-domains.json entry
    const domains = updateRuleDomains(rule, RD_PATH);
    expect(domains.length).toBeGreaterThan(0);

    const rdRules = readRuleDomains();
    expect(rdRules["feedback_verify_before_deploy"]).toBeDefined();
    expect(rdRules["feedback_verify_before_deploy"].domains).toEqual(domains);
    expect(rdRules["feedback_verify_before_deploy"].source).toBe("auto");

    // Step 3: appendToLearnedMd — verify CLAUDE-LEARNED.md entry
    writeFileSync(LEARNED_PATH, "# Learned Rules\n\n### Learned Rules\n\n", "utf-8");
    appendToLearnedMd(rule, LEARNED_PATH);

    const learnedContent = readFileSync(LEARNED_PATH, "utf-8");
    expect(learnedContent).toContain(`- **${rule.id}:**`);
    expect(learnedContent).toContain(rule.text);

    // Step 4: buildGraph — verify node exists
    const graph = await buildGraph(RULES_DIR, STATE_DIR, RD_PATH);
    expect(graph.nodes["feedback_verify_before_deploy"]).toBeDefined();
    expect(graph.nodes["feedback_verify_before_deploy"].domains.length).toBeGreaterThan(0);

    // Step 5: getContextRules — verify rule appears in results for matching domain
    const nodeDomains = graph.nodes["feedback_verify_before_deploy"].domains;
    const index = buildIndexFromDir(RULES_DIR);
    initHybridDetection(graph);
    const rules = await getContextRules(graph, index, nodeDomains, 10, undefined, "deploy verification production");

    const ruleIds = rules.map(r => r.id);
    expect(ruleIds).toContain("feedback_verify_before_deploy");
  });

  test("multiple rules promote and coexist in graph with correct domain entries", async () => {
    const deployRule = makeRule(
      "feedback_check_container",
      "Always check container health before deploying. Never deploy without verification of the deployment target.",
    );
    const browserRule = makeRule(
      "feedback_browser_test",
      "Always test in browser before claiming UI work is done. Use Playwright for browser testing verification.",
    );

    // Promote both rules through the full chain
    writeRuleFile(deployRule, RULES_DIR);
    writeRuleFile(browserRule, RULES_DIR);
    updateRuleDomains(deployRule, RD_PATH);
    updateRuleDomains(browserRule, RD_PATH);

    writeFileSync(LEARNED_PATH, "# Learned Rules\n\n### Learned Rules\n\n", "utf-8");
    appendToLearnedMd(deployRule, LEARNED_PATH);
    appendToLearnedMd(browserRule, LEARNED_PATH);

    const learnedContent = readFileSync(LEARNED_PATH, "utf-8");
    expect(learnedContent).toContain(`- **${deployRule.id}:**`);
    expect(learnedContent).toContain(`- **${browserRule.id}:**`);

    // Build graph — both nodes exist
    const graph = await buildGraph(RULES_DIR, STATE_DIR, RD_PATH);
    expect(graph.nodes["feedback_check_container"]).toBeDefined();
    expect(graph.nodes["feedback_browser_test"]).toBeDefined();

    // Both have rule-domains.json entries
    const rdRules = readRuleDomains();
    expect(rdRules["feedback_check_container"]).toBeDefined();
    expect(rdRules["feedback_browser_test"]).toBeDefined();

    // Context injection returns the right rule for each domain
    const index = buildIndexFromDir(RULES_DIR);
    initHybridDetection(graph);

    const deployResults = await getContextRules(graph, index, ["deployment"], 10, undefined, "deploy container health");
    expect(deployResults.map(r => r.id)).toContain("feedback_check_container");

    const browserResults = await getContextRules(graph, index, ["browser"], 10, undefined, "browser testing playwright UI");
    expect(browserResults.map(r => r.id)).toContain("feedback_browser_test");
  });

  test("appendToLearnedMd is idempotent — duplicate calls do not create duplicate entries", async () => {
    const rule = makeRule("feedback_no_dupes", "Never allow duplicate entries in production configurations.");

    writeFileSync(LEARNED_PATH, "# Learned Rules\n\n### Learned Rules\n\n", "utf-8");
    appendToLearnedMd(rule, LEARNED_PATH);
    appendToLearnedMd(rule, LEARNED_PATH);

    const content = readFileSync(LEARNED_PATH, "utf-8");
    const matches = content.match(/- \*\*feedback_no_dupes:\*\*/g);
    expect(matches?.length).toBe(1);
  });

  test("writeRuleFile creates rules dir if it does not exist", () => {
    const freshDir = join(TMP_DIR, "fresh-rules");
    expect(existsSync(freshDir)).toBe(false);

    const rule = makeRule("feedback_fresh", "A brand new rule in a fresh directory.");
    writeRuleFile(rule, freshDir);

    expect(existsSync(freshDir)).toBe(true);
    expect(existsSync(join(freshDir, "feedback_fresh.md"))).toBe(true);
  });
});
