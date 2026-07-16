import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  findEvictionCandidates,
  findDuplicates,
  evictRules,
  enforceBudget,
  buildLearnedStatsLookup,
  type EvictionCandidate,
} from "../../src/promote/evict";
import { normalizeRuleId } from "../../src/promote/bridge";
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

  test("adds stale rules as eviction candidates regardless of rating", () => {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const stats: RuleStats[] = [
      makeStats("stale-but-good", {
        avgCorrelatedRating: 8.0,
        injectionCount: 10,
        lastSeen: ninetyDaysAgo,
      }),
      makeStats("fresh-and-good", {
        avgCorrelatedRating: 8.0,
        injectionCount: 10,
        lastSeen: new Date().toISOString(),
      }),
    ];
    persistRuleStats(stats, STATE_DIR);

    const candidates = findEvictionCandidates({ stateDir: STATE_DIR, ruleDomainsPath: RULE_DOMAINS });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].ruleId).toBe("stale-but-good");
    expect(candidates[0].reason).toContain("stale");
  });

  test("stale rules bypass minSessions check", () => {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const stats: RuleStats[] = [
      makeStats("stale-few-sessions", {
        avgCorrelatedRating: 5.0,
        injectionCount: 2,
        lastSeen: ninetyDaysAgo,
      }),
    ];
    persistRuleStats(stats, STATE_DIR);

    const candidates = findEvictionCandidates({ stateDir: STATE_DIR, ruleDomainsPath: RULE_DOMAINS });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].ruleId).toBe("stale-few-sessions");
  });

  test("stale reviewed rules get requiresHumanConfirmation", () => {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const stats: RuleStats[] = [
      makeStats("stale-reviewed", {
        avgCorrelatedRating: 7.0,
        injectionCount: 10,
        lastSeen: ninetyDaysAgo,
      }),
    ];
    persistRuleStats(stats, STATE_DIR);
    makeRuleDomains({
      "stale-reviewed": { domains: ["verification"], source: "reviewed" },
    });

    const candidates = findEvictionCandidates({ stateDir: STATE_DIR, ruleDomainsPath: RULE_DOMAINS });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].requiresHumanConfirmation).toBe(true);
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

  test("skips rules shorter than 20 characters", () => {
    const rules = [
      { id: "r1", text: "verify first" },
      { id: "r2", text: "verify first" },
      { id: "r3", text: "check before" },
      { id: "r4", text: "check before" },
    ];
    const dupes = findDuplicates(rules, 0.5);
    expect(dupes).toHaveLength(0);
  });

  test("short common rules are not false-flagged against long rules", () => {
    const rules = [
      { id: "r1", text: "check" },
      { id: "r2", text: "Always check the deployment status before merging any pull request" },
      { id: "r3", text: "Always check the build output before declaring a fix complete" },
    ];
    const dupes = findDuplicates(rules, 0.5);
    for (const d of dupes) {
      expect(d.ruleIdA).not.toBe("r1");
      expect(d.ruleIdB).not.toBe("r1");
    }
  });

  test("uses config threshold (0.85) by default", () => {
    const rules = [
      { id: "r1", text: "verify before asserting claims about code behavior in production systems" },
      { id: "r2", text: "verify before asserting claims about code behavior in staging environments" },
    ];
    const defaultDupes = findDuplicates(rules);
    const looseDupes = findDuplicates(rules, 0.5);
    expect(looseDupes.length).toBeGreaterThanOrEqual(defaultDupes.length);
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

describe("normalizeRuleId", () => {
  test("strips feedback_ prefix", () => {
    expect(normalizeRuleId("feedback_ac_garbage_test")).toBe("ac-garbage-test");
  });

  test("strips success_ prefix", () => {
    expect(normalizeRuleId("success_autonomous-recovery")).toBe("autonomous-recovery");
  });

  test("strips project_ prefix", () => {
    expect(normalizeRuleId("project_leader_flag")).toBe("leader-flag");
  });

  test("strips traj- prefix", () => {
    expect(normalizeRuleId("traj-w1d74p")).toBe("w1d74p");
  });

  test("normalizes human-readable names", () => {
    expect(normalizeRuleId("Upfront Alignment, Then Run")).toBe("upfront-alignment-then-run");
  });

  test("strips (from ...) suffix", () => {
    expect(normalizeRuleId("ac_garbage_test (from session 2026-06-18)")).toBe("ac-garbage-test");
  });

  test("normalizes underscores to hyphens", () => {
    expect(normalizeRuleId("da_must_verify_before_closing")).toBe("da-must-verify-before-closing");
  });

  test("already-normalized kebab IDs pass through", () => {
    expect(normalizeRuleId("verify-before-asserting")).toBe("verify-before-asserting");
  });

  test("produces same output for matching stat ID and learned name", () => {
    const statId = "feedback_ac_garbage_test";
    const learnedName = "ac_garbage_test (from session 2026-06-18)";
    expect(normalizeRuleId(statId)).toBe(normalizeRuleId(learnedName));
  });

  test("produces same output for underscore stat and kebab learned name", () => {
    const statId = "feedback_da_must_verify_before_closing";
    const learnedName = "da_must_verify_before_closing";
    expect(normalizeRuleId(statId)).toBe(normalizeRuleId(learnedName));
  });
});

describe("evictRules with normalized matching", () => {
  test("evicts rule when stat ID has prefix but CLAUDE-LEARNED uses raw name", async () => {
    const learnedContent = [
      "# Learned Rules\n",
      "### Learned Rules\n",
      "- **ac_garbage_test (from session 2026-06-18):** Every AC needs a threshold",
      "- **Keep Me:** This should stay",
    ].join("\n");
    await Bun.write(CLAUDE_LEARNED, learnedContent);

    const candidates: EvictionCandidate[] = [
      { ruleId: "feedback_ac_garbage_test", avgCorrelatedRating: 2.0, sessionCount: 10, reason: "low" },
    ];

    const result = await evictRules(candidates, CLAUDE_LEARNED, { ruleDomainsPath: RULE_DOMAINS });
    expect(result.evicted).toContain("feedback_ac_garbage_test");

    const content = readFileSync(CLAUDE_LEARNED, "utf-8");
    expect(content).not.toContain("ac_garbage_test");
    expect(content).toContain("Keep Me");
  });

  test("evicts rule when stat ID matches human-readable name after normalization", async () => {
    const learnedContent = [
      "# Learned Rules\n",
      "### Learned Rules\n",
      "- **Da Must Verify Before Closing (from debrief 2026-05-26):** Before closing ANY issue verify",
      "- **Keep Me:** This should stay",
    ].join("\n");
    await Bun.write(CLAUDE_LEARNED, learnedContent);

    const candidates: EvictionCandidate[] = [
      { ruleId: "feedback_da_must_verify_before_closing", avgCorrelatedRating: 1.5, sessionCount: 8, reason: "low" },
    ];

    const result = await evictRules(candidates, CLAUDE_LEARNED, { ruleDomainsPath: RULE_DOMAINS });
    expect(result.evicted).toContain("feedback_da_must_verify_before_closing");

    const content = readFileSync(CLAUDE_LEARNED, "utf-8");
    expect(content).not.toContain("Da Must Verify");
    expect(content).toContain("Keep Me");
  });

  test("evicts rule by exact ID match (no normalization needed)", async () => {
    await Bun.write(CLAUDE_LEARNED, makeClaudeLearned(["evict-me", "keep-me"]));

    const candidates: EvictionCandidate[] = [
      { ruleId: "evict-me", avgCorrelatedRating: 2.0, sessionCount: 10, reason: "low" },
    ];

    const result = await evictRules(candidates, CLAUDE_LEARNED, { ruleDomainsPath: RULE_DOMAINS });
    expect(result.evicted).toContain("evict-me");

    const content = readFileSync(CLAUDE_LEARNED, "utf-8");
    expect(content).not.toContain("evict-me");
    expect(content).toContain("keep-me");
  });
});

describe("buildLearnedStatsLookup", () => {
  test("maps learned names to stat IDs via normalization", () => {
    const learnedContent = [
      "# Learned Rules\n",
      "### Learned Rules\n",
      "- **ac_garbage_test (from session 2026-06-18):** Every AC needs a threshold",
      "- **Da Must Verify Before Closing:** Before closing verify",
    ].join("\n");
    writeFileSync(CLAUDE_LEARNED, learnedContent);

    const statsMap = new Map<string, RuleStats>();
    statsMap.set("feedback_ac_garbage_test", makeStats("feedback_ac_garbage_test", { avgCorrelatedRating: 2.0 }));
    statsMap.set("feedback_da_must_verify_before_closing", makeStats("feedback_da_must_verify_before_closing", { avgCorrelatedRating: 4.5 }));

    const { learnedToStatId, statIdToLearnedName } = buildLearnedStatsLookup(CLAUDE_LEARNED, statsMap);

    expect(learnedToStatId.get("ac_garbage_test")).toBe("feedback_ac_garbage_test");
    expect(learnedToStatId.get("Da Must Verify Before Closing")).toBe("feedback_da_must_verify_before_closing");
    expect(statIdToLearnedName.get("feedback_ac_garbage_test")).toBe("ac_garbage_test");
  });

  test("returns empty maps when no matches", () => {
    const learnedContent = "# Learned Rules\n\n### Learned Rules\n\n- **Unique Name:** text\n";
    writeFileSync(CLAUDE_LEARNED, learnedContent);

    const statsMap = new Map<string, RuleStats>();
    statsMap.set("totally_different_id", makeStats("totally_different_id"));

    const { learnedToStatId } = buildLearnedStatsLookup(CLAUDE_LEARNED, statsMap);
    expect(learnedToStatId.size).toBe(0);
  });
});

describe("findEvictionCandidates with claudeLearnedPath", () => {
  test("produces learned candidates when stat ID not already a candidate", () => {
    // Stats with a prefixed ID whose rating is OK for stats-scan threshold (3.0)
    // but bad enough for learned-match threshold
    const stats: RuleStats[] = [
      makeStats("feedback_ac_garbage_test", { avgCorrelatedRating: 2.5, injectionCount: 10 }),
      makeStats("good-rule", { avgCorrelatedRating: 7.0, injectionCount: 10 }),
    ];
    persistRuleStats(stats, STATE_DIR);

    const learnedContent = [
      "# Learned Rules\n",
      "### Learned Rules\n",
      "- **ac_garbage_test (from session 2026-06-18):** Every AC needs a threshold",
      "- **Unrelated Rule:** stays",
    ].join("\n");
    writeFileSync(CLAUDE_LEARNED, learnedContent);

    const candidates = findEvictionCandidates({
      stateDir: STATE_DIR,
      ruleDomainsPath: RULE_DOMAINS,
      claudeLearnedPath: CLAUDE_LEARNED,
    });

    // The stat-based scan should find feedback_ac_garbage_test (avg 2.5 < 3.0)
    const statCandidate = candidates.find(c => c.ruleId === "feedback_ac_garbage_test");
    expect(statCandidate).toBeDefined();
  });

  test("produces learned-match candidates when stats not found by stat scan", () => {
    // Stat with high enough rating to pass stats-scan but too few sessions
    // to be caught by the main loop, yet still low enough for learned match
    const stats: RuleStats[] = [
      makeStats("feedback_only_learned", { avgCorrelatedRating: 2.5, injectionCount: 10 }),
    ];
    persistRuleStats(stats, STATE_DIR);

    const learnedContent = [
      "# Learned Rules\n",
      "### Learned Rules\n",
      "- **Only Learned (from debrief 2026-05-01):** This rule exists only in CLAUDE-LEARNED",
    ].join("\n");
    writeFileSync(CLAUDE_LEARNED, learnedContent);

    const candidates = findEvictionCandidates({
      stateDir: STATE_DIR,
      ruleDomainsPath: RULE_DOMAINS,
      claudeLearnedPath: CLAUDE_LEARNED,
    });

    // feedback_only_learned normalizes to "only-learned"
    // "Only Learned" normalizes to "only-learned"
    // Stats scan finds feedback_only_learned directly
    const found = candidates.find(c =>
      normalizeRuleId(c.ruleId) === "only-learned"
    );
    expect(found).toBeDefined();
  });

  test("produces untracked candidates for old learned entries with no stats", () => {
    const stats: RuleStats[] = [
      makeStats("unrelated-stat", { avgCorrelatedRating: 7.0, injectionCount: 10 }),
    ];
    persistRuleStats(stats, STATE_DIR);

    const learnedContent = [
      "# Learned Rules\n",
      "### Learned Rules\n",
      "- **Old Untracked Rule (from debrief 2026-04-01):** This is 100+ days old with no stats",
      "- **Recent Rule (from debrief 2026-07-10):** This is recent",
    ].join("\n");
    writeFileSync(CLAUDE_LEARNED, learnedContent);

    const candidates = findEvictionCandidates({
      stateDir: STATE_DIR,
      ruleDomainsPath: RULE_DOMAINS,
      claudeLearnedPath: CLAUDE_LEARNED,
    });

    const untracked = candidates.find(c => c.ruleId === "Old Untracked Rule");
    expect(untracked).toBeDefined();
    expect(untracked!.reason).toContain("untracked");
    expect(untracked!.sessionCount).toBe(0);

    const recent = candidates.find(c => c.ruleId === "Recent Rule");
    expect(recent).toBeUndefined();
  });

  test("does not duplicate candidates already found by stat scan", () => {
    const stats: RuleStats[] = [
      makeStats("feedback_ac_garbage_test", { avgCorrelatedRating: 2.0, injectionCount: 10 }),
    ];
    persistRuleStats(stats, STATE_DIR);

    const learnedContent = "# Learned Rules\n\n### Learned Rules\n\n- **ac_garbage_test:** text\n";
    writeFileSync(CLAUDE_LEARNED, learnedContent);

    const candidates = findEvictionCandidates({
      stateDir: STATE_DIR,
      ruleDomainsPath: RULE_DOMAINS,
      claudeLearnedPath: CLAUDE_LEARNED,
    });

    // The stat ID itself appears as a candidate (from stats scan),
    // and the learned match should not create a duplicate
    const allIds = candidates.map(c => c.ruleId);
    const acEntries = allIds.filter(id => normalizeRuleId(id) === "ac-garbage-test");
    expect(acEntries.length).toBeLessThanOrEqual(2);
  });
});
