import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { pruneTobudget } from "../../src/promote/prune";
import { getEvictionCandidates } from "../../src/promote/rules";
import { expirePendingRules } from "../../src/daemon/cleanup";
import { Tier, SCHEMA_VERSION, type Rule } from "../../src/adapters/types";

const TMP_DIR = join(import.meta.dir, ".tmp-multi-file-test");
const STATE_DIR = join(TMP_DIR, "state");

function makeRule(id: string, overrides: Partial<Rule> = {}): Rule {
  return {
    id,
    text: `Rule ${id} text`,
    tier: Tier.Global,
    tags: [],
    created: "2024-01-01T00:00:00Z",
    correlationScore: 0,
    sourceSignals: [],
    schemaVersion: SCHEMA_VERSION,
    ...overrides,
  };
}

function makeLearnedMd(ruleCount: number): string {
  const rules = Array.from({ length: ruleCount }, (_, i) => {
    return `- **learned-${i}:** Learned rule number ${i}`;
  });
  return `# CLAUDE-LEARNED.md\n\n${rules.join("\n")}\n`;
}

function makeProjectClaudeMd(ruleCount: number, projectName: string): string {
  const rules = Array.from({ length: ruleCount }, (_, i) => {
    return `- **${projectName}-rule-${i}:** Project rule ${i} for ${projectName}`;
  });
  return `# Project Rules\n\n### Rules\n\n${rules.join("\n")}\n`;
}

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

describe("pruneTobudget on CLAUDE-LEARNED.md format", () => {
  test("prunes learned rules when over budgetOverride", async () => {
    const learnedPath = join(TMP_DIR, "CLAUDE-LEARNED.md");
    writeFileSync(learnedPath, makeLearnedMd(60));

    const result = await pruneTobudget(learnedPath, Tier.Global, {
      stateDir: STATE_DIR,
      budgetOverride: 50,
    });

    expect(result.wasOverBudget).toBe(true);
    expect(result.removed.length).toBeGreaterThan(0);
    expect(result.remaining).toBeLessThanOrEqual(50);
  });

  test("no prune when under budgetOverride", async () => {
    const learnedPath = join(TMP_DIR, "CLAUDE-LEARNED.md");
    writeFileSync(learnedPath, makeLearnedMd(30));

    const result = await pruneTobudget(learnedPath, Tier.Global, {
      budgetOverride: 50,
    });

    expect(result.wasOverBudget).toBe(false);
    expect(result.removed).toHaveLength(0);
  });

  test("budgetOverride overrides default tier cap", async () => {
    const learnedPath = join(TMP_DIR, "CLAUDE-LEARNED.md");
    // 30 rules, default global cap is 25, but override is 40
    writeFileSync(learnedPath, makeLearnedMd(30));

    const result = await pruneTobudget(learnedPath, Tier.Global, {
      budgetOverride: 40,
    });

    expect(result.wasOverBudget).toBe(false);
    expect(result.removed).toHaveLength(0);
  });
});

describe("project CLAUDE.md discovery and pruning", () => {
  test("prunes project CLAUDE.md when over project budget", async () => {
    const projectFile = join(TMP_DIR, "project-CLAUDE.md");
    writeFileSync(projectFile, makeProjectClaudeMd(30, "myproject"));

    const result = await pruneTobudget(projectFile, Tier.Project, {
      stateDir: STATE_DIR,
      budgetOverride: 25,
    });

    expect(result.wasOverBudget).toBe(true);
    expect(result.removed.length).toBeGreaterThan(0);
    expect(result.remaining).toBeLessThanOrEqual(25);
  });

  test("leaves project CLAUDE.md alone when under budget", async () => {
    const projectFile = join(TMP_DIR, "project-CLAUDE.md");
    writeFileSync(projectFile, makeProjectClaudeMd(10, "myproject"));

    const result = await pruneTobudget(projectFile, Tier.Project, {
      budgetOverride: 25,
    });

    expect(result.wasOverBudget).toBe(false);
    expect(result.removed).toHaveLength(0);
    expect(result.remaining).toBe(10);
  });
});

describe("PENDING-RULES.md expiry", () => {
  test("archives entries older than expiryDays", () => {
    const pendingPath = join(TMP_DIR, "PENDING-RULES.md");
    const archivePath = join(TMP_DIR, "PENDING-RULES-ARCHIVE.md");

    const oldDate = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
    const recentDate = new Date().toISOString().slice(0, 10);

    const content = [
      `## [PROPOSED - ${oldDate}]`,
      "Old rule that should be archived",
      "",
      `## [PROMOTED - ${recentDate}]`,
      "Recent rule that should stay",
    ].join("\n");

    writeFileSync(pendingPath, content);

    const result = expirePendingRules(pendingPath, archivePath, 30);

    expect(result.archived).toBeGreaterThan(0);
    expect(existsSync(archivePath)).toBe(true);

    const archiveContent = readFileSync(archivePath, "utf-8");
    expect(archiveContent).toContain("Old rule that should be archived");

    const remaining = readFileSync(pendingPath, "utf-8");
    expect(remaining).toContain("Recent rule that should stay");
    expect(remaining).not.toContain("Old rule that should be archived");
  });

  test("no-op when no entries are expired", () => {
    const pendingPath = join(TMP_DIR, "PENDING-RULES.md");
    const archivePath = join(TMP_DIR, "PENDING-RULES-ARCHIVE.md");

    const recentDate = new Date().toISOString().slice(0, 10);
    writeFileSync(pendingPath, `## [PROPOSED - ${recentDate}]\nRecent rule\n`);

    const result = expirePendingRules(pendingPath, archivePath, 30);

    expect(result.archived).toBe(0);
    expect(existsSync(archivePath)).toBe(false);
  });

  test("handles missing file gracefully", () => {
    const result = expirePendingRules(
      join(TMP_DIR, "nonexistent.md"),
      join(TMP_DIR, "archive.md"),
      30,
    );
    expect(result.archived).toBe(0);
    expect(result.remaining).toBe(0);
  });

  test("appends to existing archive", () => {
    const pendingPath = join(TMP_DIR, "PENDING-RULES.md");
    const archivePath = join(TMP_DIR, "PENDING-RULES-ARCHIVE.md");

    writeFileSync(archivePath, "## [PROPOSED - 2025-01-01]\nPreviously archived\n");

    const oldDate = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
    writeFileSync(pendingPath, `## [PROPOSED - ${oldDate}]\nNewly expired rule\n`);

    expirePendingRules(pendingPath, archivePath, 30);

    const archiveContent = readFileSync(archivePath, "utf-8");
    expect(archiveContent).toContain("Previously archived");
    expect(archiveContent).toContain("Newly expired rule");
  });
});

describe("lowRatingActivations in eviction sort", () => {
  test("rules with high lowRatingActivations are evicted before those with fewer", () => {
    const rules = [
      makeRule("low-failures", {
        injectionCount: 10,
        avgCorrelatedRating: 5.0,
        lowRatingActivations: 1,
      }),
      makeRule("high-failures", {
        injectionCount: 10,
        avgCorrelatedRating: 5.0,
        lowRatingActivations: 8,
      }),
    ];

    const candidates = getEvictionCandidates(rules);
    expect(candidates[0].id).toBe("high-failures");
  });

  test("avgCorrelatedRating still takes precedence over lowRatingActivations", () => {
    const rules = [
      makeRule("bad-rating", {
        injectionCount: 10,
        avgCorrelatedRating: 2.0,
        lowRatingActivations: 0,
      }),
      makeRule("high-low-activations", {
        injectionCount: 10,
        avgCorrelatedRating: 7.0,
        lowRatingActivations: 10,
      }),
    ];

    const candidates = getEvictionCandidates(rules);
    expect(candidates[0].id).toBe("bad-rating");
  });

  test("stale still takes top priority over lowRatingActivations", () => {
    const staleDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const recentDate = new Date().toISOString();

    const rules = [
      makeRule("stale-rule", {
        injectionCount: 10,
        avgCorrelatedRating: 9.0,
        lowRatingActivations: 0,
        lastSeen: staleDate,
      }),
      makeRule("high-low-activations", {
        injectionCount: 10,
        avgCorrelatedRating: 5.0,
        lowRatingActivations: 20,
        lastSeen: recentDate,
      }),
    ];

    const candidates = getEvictionCandidates(rules);
    expect(candidates[0].id).toBe("stale-rule");
  });
});
