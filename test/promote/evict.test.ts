import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  findEvictionCandidates,
  findDuplicates,
  evictRules,
  enforceBudget,
  type EvictionCandidate,
} from "../../src/promote/evict";
import { persistRuleStats, type RuleStats } from "../../src/promote/rules";

const TMP_DIR = join(import.meta.dir, ".tmp-evict-test");
const STATE_DIR = join(TMP_DIR, "state");
const CLAUDE_LEARNED = join(TMP_DIR, "CLAUDE-LEARNED.md");
const RULE_DOMAINS = join(TMP_DIR, "rule-domains.json");

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

function makeClaudeLearned(ruleIds: string[]): string {
  const rules = ruleIds.map(id => `- **${id}:** Rule text for ${id}`);
  return `# Learned Rules\n\n### Learned Rules\n\n${rules.join("\n")}\n`;
}

function makeRuleDomains(entries: Record<string, { domains: string[]; source: string }>): void {
  writeFileSync(RULE_DOMAINS, JSON.stringify({
    version: 1,
    generated_at: new Date().toISOString(),
    reviewed: true,
    rules: entries,
  }, null, 2));
}

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

describe("findEvictionCandidates", () => {
  test("returns rules with avgCorrelatedRating < 3.0 and >= 5 sessions", () => {
    const stats: RuleStats[] = [
      makeStats("low-rule", { avgCorrelatedRating: 2.5, injectionCount: 8 }),
      makeStats("good-rule", { avgCorrelatedRating: 7.0, injectionCount: 10 }),
      makeStats("borderline", { avgCorrelatedRating: 3.0, injectionCount: 6 }),
    ];
    persistRuleStats(stats, STATE_DIR);

    const candidates = findEvictionCandidates({
      stateDir: STATE_DIR,
      ruleDomainsPath: RULE_DOMAINS,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].ruleId).toBe("low-rule");
    expect(candidates[0].avgCorrelatedRating).toBe(2.5);
    expect(candidates[0].sessionCount).toBe(8);
  });

  test("excludes rules with fewer than minSessions", () => {
    const stats: RuleStats[] = [
      makeStats("too-few", { avgCorrelatedRating: 1.0, injectionCount: 3 }),
    ];
    persistRuleStats(stats, STATE_DIR);

    const candidates = findEvictionCandidates({ stateDir: STATE_DIR, ruleDomainsPath: RULE_DOMAINS });
    expect(candidates).toHaveLength(0);
  });

  test("sorts by lowest rating first", () => {
    const stats: RuleStats[] = [
      makeStats("mid-low", { avgCorrelatedRating: 2.8, injectionCount: 10 }),
      makeStats("very-low", { avgCorrelatedRating: 1.5, injectionCount: 10 }),
      makeStats("low", { avgCorrelatedRating: 2.0, injectionCount: 10 }),
    ];
    persistRuleStats(stats, STATE_DIR);

    const candidates = findEvictionCandidates({ stateDir: STATE_DIR, ruleDomainsPath: RULE_DOMAINS });
    expect(candidates[0].ruleId).toBe("very-low");
    expect(candidates[1].ruleId).toBe("low");
    expect(candidates[2].ruleId).toBe("mid-low");
  });

  test("marks reviewed rules with requiresHumanConfirmation", () => {
    const stats: RuleStats[] = [
      makeStats("reviewed-rule", { avgCorrelatedRating: 2.0, injectionCount: 10 }),
    ];
    persistRuleStats(stats, STATE_DIR);
    makeRuleDomains({
      "reviewed-rule": { domains: ["verification"], source: "reviewed" },
    });

    const candidates = findEvictionCandidates({ stateDir: STATE_DIR, ruleDomainsPath: RULE_DOMAINS });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].requiresHumanConfirmation).toBe(true);
  });

  test("does not mark auto-classified rules with requiresHumanConfirmation", () => {
    const stats: RuleStats[] = [
      makeStats("auto-rule", { avgCorrelatedRating: 2.0, injectionCount: 10 }),
    ];
    persistRuleStats(stats, STATE_DIR);
    makeRuleDomains({
      "auto-rule": { domains: ["verification"], source: "auto" },
    });

    const candidates = findEvictionCandidates({ stateDir: STATE_DIR, ruleDomainsPath: RULE_DOMAINS });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].requiresHumanConfirmation).toBeUndefined();
  });

  test("writes candidates to eviction-candidates.json", () => {
    const stats: RuleStats[] = [
      makeStats("evict-me", { avgCorrelatedRating: 1.0, injectionCount: 10 }),
    ];
    persistRuleStats(stats, STATE_DIR);

    findEvictionCandidates({ stateDir: STATE_DIR, ruleDomainsPath: RULE_DOMAINS });

    const outPath = join(STATE_DIR, "eviction-candidates.json");
    expect(existsSync(outPath)).toBe(true);
    const written = JSON.parse(readFileSync(outPath, "utf-8"));
    expect(written).toHaveLength(1);
    expect(written[0].ruleId).toBe("evict-me");
  });

  test("respects custom threshold", () => {
    const stats: RuleStats[] = [
      makeStats("mid", { avgCorrelatedRating: 4.5, injectionCount: 10 }),
    ];
    persistRuleStats(stats, STATE_DIR);

    const defaultCandidates = findEvictionCandidates({ stateDir: STATE_DIR, ruleDomainsPath: RULE_DOMAINS });
    expect(defaultCandidates).toHaveLength(0);

    const customCandidates = findEvictionCandidates({
      stateDir: STATE_DIR,
      ruleDomainsPath: RULE_DOMAINS,
      threshold: 5.0,
    });
    expect(customCandidates).toHaveLength(1);
  });
});

describe("findDuplicates", () => {
  test("detects highly similar rules", () => {
    const rules = [
      { id: "r1", text: "Always verify before asserting any claim about code behavior" },
      { id: "r2", text: "Always verify before asserting any claim about code behavior in tests" },
    ];
    const dupes = findDuplicates(rules, 0.8);
    expect(dupes.length).toBeGreaterThanOrEqual(1);
    expect(dupes[0].ruleIdA).toBe("r1");
    expect(dupes[0].ruleIdB).toBe("r2");
    expect(dupes[0].similarity).toBeGreaterThanOrEqual(0.8);
  });

  test("does not flag dissimilar rules", () => {
    const rules = [
      { id: "r1", text: "Always verify before asserting any claim" },
      { id: "r2", text: "Deploy containers using make rebuild" },
    ];
    const dupes = findDuplicates(rules);
    expect(dupes).toHaveLength(0);
  });

  test("sorts by similarity descending", () => {
    const base = "verify before asserting any claim about code behavior state";
    const rules = [
      { id: "r1", text: base },
      { id: "r2", text: base + " in production systems" },
      { id: "r3", text: base },
    ];
    const dupes = findDuplicates(rules, 0.7);
    expect(dupes.length).toBeGreaterThanOrEqual(1);
    expect(dupes[0].similarity).toBeGreaterThanOrEqual(dupes[dupes.length - 1].similarity);
  });

  test("respects custom threshold", () => {
    const rules = [
      { id: "r1", text: "verify before asserting claims about code" },
      { id: "r2", text: "verify before asserting claims about behavior" },
    ];
    const strict = findDuplicates(rules, 0.95);
    const loose = findDuplicates(rules, 0.5);
    expect(loose.length).toBeGreaterThanOrEqual(strict.length);
  });

  test("handles empty input", () => {
    expect(findDuplicates([])).toEqual([]);
  });
});

describe("evictRules", () => {
  test("removes non-reviewed rules from CLAUDE-LEARNED.md", async () => {
    await Bun.write(CLAUDE_LEARNED, makeClaudeLearned(["evict-me", "keep-me"]));

    const candidates: EvictionCandidate[] = [
      { ruleId: "evict-me", avgCorrelatedRating: 2.0, sessionCount: 10, reason: "low correlation" },
    ];

    const result = await evictRules(candidates, CLAUDE_LEARNED, { ruleDomainsPath: RULE_DOMAINS });
    expect(result.evicted).toContain("evict-me");
    expect(result.skipped).toHaveLength(0);

    const content = readFileSync(CLAUDE_LEARNED, "utf-8");
    expect(content).not.toContain("evict-me");
    expect(content).toContain("keep-me");
  });

  test("skips rules with requiresHumanConfirmation", async () => {
    await Bun.write(CLAUDE_LEARNED, makeClaudeLearned(["reviewed-rule"]));

    const candidates: EvictionCandidate[] = [
      {
        ruleId: "reviewed-rule",
        avgCorrelatedRating: 2.0,
        sessionCount: 10,
        reason: "low correlation",
        requiresHumanConfirmation: true,
      },
    ];

    const result = await evictRules(candidates, CLAUDE_LEARNED, { ruleDomainsPath: RULE_DOMAINS });
    expect(result.skipped).toContain("reviewed-rule");
    expect(result.evicted).toHaveLength(0);

    const content = readFileSync(CLAUDE_LEARNED, "utf-8");
    expect(content).toContain("reviewed-rule");
  });

  test("removes evicted rules from rule-domains.json", async () => {
    await Bun.write(CLAUDE_LEARNED, makeClaudeLearned(["evict-me"]));
    makeRuleDomains({
      "evict-me": { domains: ["verification"], source: "auto" },
      "keep-me": { domains: ["deployment"], source: "reviewed" },
    });

    const candidates: EvictionCandidate[] = [
      { ruleId: "evict-me", avgCorrelatedRating: 2.0, sessionCount: 10, reason: "low" },
    ];

    await evictRules(candidates, CLAUDE_LEARNED, { ruleDomainsPath: RULE_DOMAINS });

    const domains = JSON.parse(readFileSync(RULE_DOMAINS, "utf-8"));
    expect(domains.rules["evict-me"]).toBeUndefined();
    expect(domains.rules["keep-me"]).toBeDefined();
  });

  test("dry run does not modify files", async () => {
    await Bun.write(CLAUDE_LEARNED, makeClaudeLearned(["evict-me"]));
    const before = readFileSync(CLAUDE_LEARNED, "utf-8");

    const candidates: EvictionCandidate[] = [
      { ruleId: "evict-me", avgCorrelatedRating: 2.0, sessionCount: 10, reason: "low" },
    ];

    const result = await evictRules(candidates, CLAUDE_LEARNED, {
      ruleDomainsPath: RULE_DOMAINS,
      dryRun: true,
    });
    expect(result.evicted).toContain("evict-me");

    const after = readFileSync(CLAUDE_LEARNED, "utf-8");
    expect(after).toBe(before);
  });
});

describe("enforceBudget", () => {
  test("returns empty when under budget", () => {
    const candidates: EvictionCandidate[] = [
      { ruleId: "r1", avgCorrelatedRating: 2.0, sessionCount: 10, reason: "low" },
    ];
    const toEvict = enforceBudget(candidates, 50, 80);
    expect(toEvict).toHaveLength(0);
  });

  test("returns excess rules when over budget", () => {
    const candidates: EvictionCandidate[] = [
      { ruleId: "r1", avgCorrelatedRating: 1.0, sessionCount: 10, reason: "low" },
      { ruleId: "r2", avgCorrelatedRating: 2.0, sessionCount: 10, reason: "low" },
      { ruleId: "r3", avgCorrelatedRating: 2.5, sessionCount: 10, reason: "low" },
    ];
    const toEvict = enforceBudget(candidates, 82, 80);
    expect(toEvict).toHaveLength(2);
    expect(toEvict[0].ruleId).toBe("r1");
    expect(toEvict[1].ruleId).toBe("r2");
  });

  test("excludes reviewed rules from budget enforcement", () => {
    const candidates: EvictionCandidate[] = [
      { ruleId: "r1", avgCorrelatedRating: 1.0, sessionCount: 10, reason: "low", requiresHumanConfirmation: true },
      { ruleId: "r2", avgCorrelatedRating: 2.0, sessionCount: 10, reason: "low" },
      { ruleId: "r3", avgCorrelatedRating: 2.5, sessionCount: 10, reason: "low" },
    ];
    const toEvict = enforceBudget(candidates, 82, 80);
    expect(toEvict).toHaveLength(2);
    expect(toEvict.find(c => c.ruleId === "r1")).toBeUndefined();
  });

  test("uses default budget of 80 when not specified", () => {
    const candidates: EvictionCandidate[] = [
      { ruleId: "r1", avgCorrelatedRating: 1.0, sessionCount: 10, reason: "low" },
    ];
    const underDefault = enforceBudget(candidates, 79);
    expect(underDefault).toHaveLength(0);

    const overDefault = enforceBudget(candidates, 81);
    expect(overDefault).toHaveLength(1);
  });
});
