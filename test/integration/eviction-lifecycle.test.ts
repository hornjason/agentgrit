import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { buildGraph, syncRuleDomains, resetClassifyPatterns } from "../../src/graph/builder";
import { buildIndexFromDir } from "../../src/graph/bm25";
import { getContextRules, initHybridDetection } from "../../src/graph/context";
import { removeRule } from "../../src/promote/bridge";
import { findEvictionCandidates, evictRules, removeFromRuleDomains } from "../../src/promote/evict";
import { persistRuleStats } from "../../src/promote/rules";
import type { RuleStats } from "../../src/promote/rules";

const TMP_DIR = join(import.meta.dir, ".tmp-eviction-lifecycle");
const RULES_DIR = join(TMP_DIR, "rules");
const STATE_DIR = join(TMP_DIR, "state");
const RD_PATH = join(TMP_DIR, "rule-domains.json");
const CLAUDE_MD = join(TMP_DIR, "CLAUDE.md");
const LEARNED_MD = join(TMP_DIR, "CLAUDE-LEARNED.md");

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
  return JSON.parse(readFileSync(RD_PATH, "utf-8")).rules || {};
}

function seedClaudeMd(ruleIds: string[]): void {
  const rules = ruleIds.map(id => `- **${id}:** Rule text for ${id}`).join("\n");
  writeFileSync(CLAUDE_MD, `# CLAUDE.md\n\n### Rules\n${rules}\n\n## Other\nSomething else.\n`, "utf-8");
}

function seedLearnedMd(ruleIds: string[]): void {
  const rules = ruleIds.map(id => `- **${id}:** Rule text for ${id}`).join("\n");
  writeFileSync(LEARNED_MD, `# Learned Rules\n\n### Learned Rules\n${rules}\n`, "utf-8");
}

function seedRuleDomains(entries: Record<string, { domains: string[]; source: string }>): void {
  writeFileSync(RD_PATH, JSON.stringify({ version: 1, reviewed: false, rules: entries }, null, 2), "utf-8");
}

function seedRuleStats(stats: RuleStats[]): void {
  persistRuleStats(stats, STATE_DIR);
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

describe("eviction lifecycle — vertical slice", () => {
  test("rule is removed from CLAUDE.md → rule-domains.json → graph → context injection", async () => {
    const targetId = "feedback_bad_rule";
    const keepId = "feedback_good_rule";

    // Step 1: Seed full state — rule files, CLAUDE.md, CLAUDE-LEARNED.md, rule-domains.json
    writeRule(targetId, {
      name: "bad-rule",
      description: "A poorly performing rule about deployment that should be evicted",
      type: "feedback",
      body: "Never deploy without checking. Always verify deployment targets and container health.",
    });
    writeRule(keepId, {
      name: "good-rule",
      description: "Always verify deployment artifacts before deploying to production",
      type: "feedback",
      body: "Check deployment artifacts, run smoke tests, and confirm the deployment target before deploying.",
    });

    seedClaudeMd([targetId, keepId]);
    seedLearnedMd([targetId, keepId]);
    seedRuleDomains({
      [targetId]: { domains: ["deployment"], source: "auto" },
      [keepId]: { domains: ["deployment"], source: "auto" },
    });

    // Step 2: Build graph — verify both nodes exist
    const graphBefore = await buildGraph(RULES_DIR, STATE_DIR, RD_PATH);
    expect(graphBefore.nodes[targetId]).toBeDefined();
    expect(graphBefore.nodes[keepId]).toBeDefined();

    // Verify context injection returns the target
    const indexBefore = buildIndexFromDir(RULES_DIR);
    initHybridDetection(graphBefore);
    const rulesBefore = await getContextRules(graphBefore, indexBefore, ["deployment"], 10, undefined, "deploy verification");
    expect(rulesBefore.map(r => r.id)).toContain(targetId);

    // Step 3: Remove rule from CLAUDE.md
    await removeRule(targetId, CLAUDE_MD);
    const claudeContent = readFileSync(CLAUDE_MD, "utf-8");
    expect(claudeContent).not.toContain(`- **${targetId}:**`);
    expect(claudeContent).toContain(`- **${keepId}:**`);

    // Step 4: Remove from CLAUDE-LEARNED.md (manual line removal)
    const learnedContent = readFileSync(LEARNED_MD, "utf-8");
    const filteredLines = learnedContent.split("\n").filter(line => !line.includes(`- **${targetId}:**`));
    writeFileSync(LEARNED_MD, filteredLines.join("\n"), "utf-8");
    expect(readFileSync(LEARNED_MD, "utf-8")).not.toContain(`- **${targetId}:**`);

    // Step 5: Remove rule .md file (simulating full eviction cleanup)
    const ruleFilePath = join(RULES_DIR, `${targetId}.md`);
    if (existsSync(ruleFilePath)) rmSync(ruleFilePath);

    // Step 6: Rebuild graph — verify target node is gone
    const graphAfter = await buildGraph(RULES_DIR, STATE_DIR, RD_PATH);
    expect(graphAfter.nodes[targetId]).toBeUndefined();
    expect(graphAfter.nodes[keepId]).toBeDefined();

    // Step 7: syncRuleDomains pruned stale entry
    const rdAfter = readRuleDomains();
    expect(rdAfter[targetId]).toBeUndefined();
    expect(rdAfter[keepId]).toBeDefined();

    // Step 8: getContextRules no longer returns evicted rule
    const indexAfter = buildIndexFromDir(RULES_DIR);
    initHybridDetection(graphAfter);
    const rulesAfter = await getContextRules(graphAfter, indexAfter, ["deployment"], 10, undefined, "deploy verification");
    expect(rulesAfter.map(r => r.id)).not.toContain(targetId);
  });

  test("findEvictionCandidates flags low-correlation rules", () => {
    // Seed rule stats with a poor-performing rule
    seedRuleStats([
      {
        ruleId: "feedback_bad_performer",
        injectionCount: 12,
        avgCorrelatedRating: 2.5,
        sessionRatings: [2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3],
        highRatingActivations: 0,
        lowRatingActivations: 12,
        lastSeen: new Date().toISOString(),
      },
      {
        ruleId: "feedback_good_performer",
        injectionCount: 10,
        avgCorrelatedRating: 8.5,
        sessionRatings: [8, 9, 8, 9, 8, 9, 8, 9, 8, 9],
        highRatingActivations: 10,
        lowRatingActivations: 0,
        lastSeen: new Date().toISOString(),
      },
    ]);

    const candidates = findEvictionCandidates({
      stateDir: STATE_DIR,
      ruleDomainsPath: RD_PATH,
      threshold: 3.0,
      minSessions: 5,
    });

    const candidateIds = candidates.map(c => c.ruleId);
    expect(candidateIds).toContain("feedback_bad_performer");
    expect(candidateIds).not.toContain("feedback_good_performer");
  });

  test("evictRules removes entries from CLAUDE-LEARNED.md and rule-domains.json", async () => {
    const evictId = "feedback_to_evict";

    seedLearnedMd([evictId, "feedback_keep"]);
    seedRuleDomains({
      [evictId]: { domains: ["deployment"], source: "auto" },
      ["feedback_keep"]: { domains: ["verification"], source: "auto" },
    });

    const candidates = [
      {
        ruleId: evictId,
        avgCorrelatedRating: 2.0,
        sessionCount: 10,
        reason: "avgCorrelatedRating 2.00 < 3.0 across 10 sessions",
      },
    ];

    const result = await evictRules(candidates, LEARNED_MD, { ruleDomainsPath: RD_PATH });

    expect(result.evicted).toContain(evictId);
    expect(result.skipped).not.toContain(evictId);

    // CLAUDE-LEARNED.md: evicted rule removed
    const learnedContent = readFileSync(LEARNED_MD, "utf-8");
    expect(learnedContent).not.toContain(`- **${evictId}:**`);
    expect(learnedContent).toContain("- **feedback_keep:**");

    // rule-domains.json: evicted entry removed
    const rd = readRuleDomains();
    expect(rd[evictId]).toBeUndefined();
    expect(rd["feedback_keep"]).toBeDefined();
  });

  test("reviewed rules are skipped during eviction", async () => {
    const reviewedId = "feedback_reviewed_rule";

    seedLearnedMd([reviewedId]);
    seedRuleDomains({
      [reviewedId]: { domains: ["deployment"], source: "reviewed" },
    });

    seedRuleStats([
      {
        ruleId: reviewedId,
        injectionCount: 15,
        avgCorrelatedRating: 2.0,
        sessionRatings: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
        highRatingActivations: 0,
        lowRatingActivations: 15,
        lastSeen: new Date().toISOString(),
      },
    ]);

    const candidates = findEvictionCandidates({
      stateDir: STATE_DIR,
      ruleDomainsPath: RD_PATH,
      threshold: 3.0,
      minSessions: 5,
    });

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].requiresHumanConfirmation).toBe(true);

    const result = await evictRules(candidates, LEARNED_MD, { ruleDomainsPath: RD_PATH });
    expect(result.skipped).toContain(reviewedId);
    expect(result.evicted).not.toContain(reviewedId);
  });

  test("removeFromRuleDomains only removes specified IDs", () => {
    seedRuleDomains({
      "rule_a": { domains: ["deployment"], source: "auto" },
      "rule_b": { domains: ["verification"], source: "auto" },
      "rule_c": { domains: ["scope"], source: "reviewed" },
    });

    removeFromRuleDomains(["rule_a", "rule_b"], RD_PATH);

    const rd = readRuleDomains();
    expect(rd["rule_a"]).toBeUndefined();
    expect(rd["rule_b"]).toBeUndefined();
    expect(rd["rule_c"]).toBeDefined();
  });

  test("syncRuleDomains prunes orphaned entries after node removal", async () => {
    // Seed a rule file + stale rule-domains entry
    writeRule("feedback_exists", {
      name: "exists",
      description: "A rule that exists about deployment",
      type: "feedback",
      body: "Always verify deployment targets before deploying to production.",
    });

    seedRuleDomains({
      "feedback_exists": { domains: ["deployment"], source: "auto" },
      "feedback_deleted": { domains: ["verification"], source: "auto" },
    });

    // Build graph — only feedback_exists has a file
    const graph = await buildGraph(RULES_DIR, STATE_DIR, RD_PATH);

    // Stale entry pruned, real entry kept
    const rd = readRuleDomains();
    expect(rd["feedback_deleted"]).toBeUndefined();
    expect(rd["feedback_exists"]).toBeDefined();
    expect(graph.nodes["feedback_exists"]).toBeDefined();
    expect(graph.nodes["feedback_deleted"]).toBeUndefined();
  });
});
