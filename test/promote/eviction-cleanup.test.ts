import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { pruneLearnedRules } from "../../src/promote/budget";
import { pruneTobudget } from "../../src/promote/prune";
import { removeFromRuleDomains } from "../../src/promote/evict";
import { persistRuleStats, type RuleStats } from "../../src/promote/rules";
import { Tier } from "../../src/adapters/types";

const TMP_DIR = join(import.meta.dir, ".tmp-eviction-cleanup-test");
const STATE_DIR = join(TMP_DIR, "state");
const LEARNED_MD = join(TMP_DIR, "CLAUDE-LEARNED.md");
const CLAUDE_MD = join(TMP_DIR, "CLAUDE.md");
const RULE_DOMAINS = join(TMP_DIR, "rule-domains.json");

function makeRuleDomains(entries: Record<string, { domains: string[]; source: string }>): void {
  writeFileSync(RULE_DOMAINS, JSON.stringify({
    version: 1,
    generated_at: "2026-01-01T00:00:00.000Z",
    reviewed: true,
    rules: entries,
  }, null, 2));
}

function makeLearnedMd(rules: Array<{ id: string; text: string }>): string {
  const lines = rules.map((r) => `- **${r.id}:** ${r.text}`);
  return `# Learned Rules\n\n### Learned Rules\n\n${lines.join("\n")}\n`;
}

function makeClaudeMd(ruleCount: number): string {
  const rules = Array.from({ length: ruleCount }, (_, i) => {
    const id = `rule-${i}`;
    return `- **${id}:** Rule number ${i}`;
  });
  return `# Config\n\n### Rules\n\n${rules.join("\n")}\n\n---\n\n## Other\n`;
}

function makeStats(id: string, overrides: Partial<RuleStats> = {}): RuleStats {
  return {
    ruleId: id,
    injectionCount: 10,
    avgCorrelatedRating: 5.0,
    sessionRatings: [5, 5, 5],
    highRatingActivations: 0,
    lowRatingActivations: 0,
    lastSeen: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

describe("removeFromRuleDomains", () => {
  test("removes specified rule IDs from rule-domains.json", () => {
    makeRuleDomains({
      "rule-a": { domains: ["verification"], source: "auto" },
      "rule-b": { domains: ["deployment"], source: "reviewed" },
      "rule-c": { domains: ["engineering"], source: "auto" },
    });

    removeFromRuleDomains(["rule-a", "rule-c"], RULE_DOMAINS);

    const result = JSON.parse(readFileSync(RULE_DOMAINS, "utf-8"));
    expect(result.rules["rule-a"]).toBeUndefined();
    expect(result.rules["rule-c"]).toBeUndefined();
    expect(result.rules["rule-b"]).toBeDefined();
  });

  test("no-op when rule-domains.json does not exist", () => {
    // Should not throw
    removeFromRuleDomains(["rule-a"], join(TMP_DIR, "nonexistent.json"));
  });

  test("no-op when ruleIds is empty", () => {
    makeRuleDomains({
      "rule-a": { domains: ["verification"], source: "auto" },
    });

    removeFromRuleDomains([], RULE_DOMAINS);

    const result = JSON.parse(readFileSync(RULE_DOMAINS, "utf-8"));
    expect(result.rules["rule-a"]).toBeDefined();
  });

  test("no-op when rule ID not found in file", () => {
    makeRuleDomains({
      "rule-a": { domains: ["verification"], source: "auto" },
    });
    const before = readFileSync(RULE_DOMAINS, "utf-8");

    removeFromRuleDomains(["nonexistent-rule"], RULE_DOMAINS);

    const after = readFileSync(RULE_DOMAINS, "utf-8");
    // generated_at should not change if nothing was removed
    expect(JSON.parse(after).rules).toEqual(JSON.parse(before).rules);
  });
});

describe("pruneLearnedRules cleans up rule-domains.json", () => {
  test("removes pruned rule entries from rule-domains.json", () => {
    const rules = Array.from({ length: 5 }, (_, i) => ({
      id: `rule-${i}`,
      text: `Rule text ${i}`,
    }));
    writeFileSync(LEARNED_MD, makeLearnedMd(rules));

    // rule-1 and rule-3 have lowest scores, will be pruned
    const stats: RuleStats[] = [
      makeStats("rule-0", { avgCorrelatedRating: 8.0 }),
      makeStats("rule-1", { avgCorrelatedRating: 2.0 }),
      makeStats("rule-2", { avgCorrelatedRating: 6.0 }),
      makeStats("rule-3", { avgCorrelatedRating: 1.0 }),
      makeStats("rule-4", { avgCorrelatedRating: 7.0 }),
    ];
    persistRuleStats(stats, STATE_DIR);

    makeRuleDomains({
      "rule-0": { domains: ["verification"], source: "auto" },
      "rule-1": { domains: ["deployment"], source: "auto" },
      "rule-2": { domains: ["engineering"], source: "auto" },
      "rule-3": { domains: ["verification"], source: "auto" },
      "rule-4": { domains: ["engineering"], source: "reviewed" },
    });

    const result = pruneLearnedRules(LEARNED_MD, 3, STATE_DIR, {
      ruleDomainsPath: RULE_DOMAINS,
    });

    expect(result.pruned).toContain("rule-1");
    expect(result.pruned).toContain("rule-3");

    // Verify rule-domains.json was cleaned up
    const domains = JSON.parse(readFileSync(RULE_DOMAINS, "utf-8"));
    expect(domains.rules["rule-1"]).toBeUndefined();
    expect(domains.rules["rule-3"]).toBeUndefined();
    // Kept rules should remain
    expect(domains.rules["rule-0"]).toBeDefined();
    expect(domains.rules["rule-2"]).toBeDefined();
    expect(domains.rules["rule-4"]).toBeDefined();
  });

  test("no-op on rule-domains when under cap", () => {
    const rules = Array.from({ length: 3 }, (_, i) => ({
      id: `rule-${i}`,
      text: `Rule text ${i}`,
    }));
    writeFileSync(LEARNED_MD, makeLearnedMd(rules));

    makeRuleDomains({
      "rule-0": { domains: ["verification"], source: "auto" },
      "rule-1": { domains: ["deployment"], source: "auto" },
      "rule-2": { domains: ["engineering"], source: "auto" },
    });

    pruneLearnedRules(LEARNED_MD, 10, STATE_DIR, {
      ruleDomainsPath: RULE_DOMAINS,
    });

    // All entries should remain
    const domains = JSON.parse(readFileSync(RULE_DOMAINS, "utf-8"));
    expect(Object.keys(domains.rules)).toHaveLength(3);
  });
});

describe("pruneTobudget cleans up rule-domains.json", () => {
  test("removes pruned rule entries from rule-domains.json", async () => {
    writeFileSync(CLAUDE_MD, makeClaudeMd(30));

    makeRuleDomains({
      "rule-0": { domains: ["verification"], source: "auto" },
      "rule-5": { domains: ["deployment"], source: "auto" },
      "rule-28": { domains: ["engineering"], source: "auto" },
      "rule-29": { domains: ["engineering"], source: "auto" },
      "other-rule": { domains: ["verification"], source: "reviewed" },
    });

    const result = await pruneTobudget(CLAUDE_MD, Tier.Global, {
      stateDir: STATE_DIR,
      ruleDomainsPath: RULE_DOMAINS,
    });

    expect(result.wasOverBudget).toBe(true);
    expect(result.removed.length).toBeGreaterThan(0);

    // Verify removed rules are gone from rule-domains.json
    const domains = JSON.parse(readFileSync(RULE_DOMAINS, "utf-8"));
    for (const removedId of result.removed) {
      expect(domains.rules[removedId]).toBeUndefined();
    }
    // Non-evicted rule should remain
    expect(domains.rules["other-rule"]).toBeDefined();
  });

  test("dry run does not modify rule-domains.json", async () => {
    writeFileSync(CLAUDE_MD, makeClaudeMd(30));

    makeRuleDomains({
      "rule-29": { domains: ["engineering"], source: "auto" },
    });
    const before = readFileSync(RULE_DOMAINS, "utf-8");

    await pruneTobudget(CLAUDE_MD, Tier.Global, {
      dryRun: true,
      ruleDomainsPath: RULE_DOMAINS,
    });

    const after = readFileSync(RULE_DOMAINS, "utf-8");
    expect(after).toBe(before);
  });
});
