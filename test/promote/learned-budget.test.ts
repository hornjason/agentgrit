import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  checkLearnedBudget,
  pruneLearnedRules,
  parseLearnedRules,
} from "../../src/promote/budget";
import { persistRuleStats, type RuleStats } from "../../src/promote/rules";

const TMP_DIR = join(import.meta.dir, ".tmp-learned-budget-test");
const STATE_DIR = join(TMP_DIR, "state");
const LEARNED_MD = join(TMP_DIR, "CLAUDE-LEARNED.md");

function makeLearnedMd(rules: Array<{ id: string; text: string }>): string {
  const lines = rules.map((r) => `- **${r.id}:** ${r.text}`);
  return `# Learned Rules\n\n### Learned Rules\n\n${lines.join("\n")}\n`;
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

describe("checkLearnedBudget", () => {
  test("returns OK when under default cap of 50", () => {
    const status = checkLearnedBudget(30);
    expect(status.level).toBe("OK");
    expect(status.cap).toBe(50);
    expect(status.remaining).toBe(20);
  });

  test("returns WARNING within 5 of cap", () => {
    const status = checkLearnedBudget(46);
    expect(status.level).toBe("WARNING");
    expect(status.remaining).toBe(4);
  });

  test("returns OVER_BUDGET when exceeding cap", () => {
    const status = checkLearnedBudget(55);
    expect(status.level).toBe("OVER_BUDGET");
    expect(status.remaining).toBe(-5);
  });

  test("custom cap overrides default", () => {
    const status = checkLearnedBudget(8, 10);
    expect(status.level).toBe("WARNING");
    expect(status.cap).toBe(10);
  });

  test("zero rules is OK", () => {
    const status = checkLearnedBudget(0);
    expect(status.level).toBe("OK");
    expect(status.remaining).toBe(50);
  });

  test("exactly at cap is WARNING", () => {
    const status = checkLearnedBudget(50);
    expect(status.level).toBe("WARNING");
    expect(status.remaining).toBe(0);
  });
});

describe("parseLearnedRules", () => {
  test("parses standard rule format", () => {
    const content = makeLearnedMd([
      { id: "rule-a (from debrief 2026-04-17)", text: "Do something" },
      { id: "rule-b (from session 2026-05-01)", text: "Do another thing" },
    ]);
    const rules = parseLearnedRules(content);
    expect(rules).toHaveLength(2);
    expect(rules[0].id).toBe("rule-a (from debrief 2026-04-17)");
    expect(rules[1].id).toBe("rule-b (from session 2026-05-01)");
  });

  test("ignores non-rule lines", () => {
    const content = "# Header\n\nSome text\n- **rule-a:** text\n- plain item\n";
    const rules = parseLearnedRules(content);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("rule-a");
  });

  test("handles empty content", () => {
    expect(parseLearnedRules("")).toHaveLength(0);
  });
});

describe("pruneLearnedRules", () => {
  test("no-op when under cap", () => {
    const rules = Array.from({ length: 5 }, (_, i) => ({
      id: `rule-${i}`,
      text: `Rule text ${i}`,
    }));
    writeFileSync(LEARNED_MD, makeLearnedMd(rules));

    const result = pruneLearnedRules(LEARNED_MD, 10, STATE_DIR);
    expect(result.pruned).toHaveLength(0);
    expect(result.kept).toBe(5);
    expect(result.total).toBe(5);
  });

  test("prunes lowest-correlated rules when over cap", () => {
    const rules = Array.from({ length: 5 }, (_, i) => ({
      id: `rule-${i}`,
      text: `Rule text ${i}`,
    }));
    writeFileSync(LEARNED_MD, makeLearnedMd(rules));

    const stats: RuleStats[] = [
      makeStats("rule-0", { avgCorrelatedRating: 8.0 }),
      makeStats("rule-1", { avgCorrelatedRating: 2.0 }),
      makeStats("rule-2", { avgCorrelatedRating: 6.0 }),
      makeStats("rule-3", { avgCorrelatedRating: 1.0 }),
      makeStats("rule-4", { avgCorrelatedRating: 7.0 }),
    ];
    persistRuleStats(stats, STATE_DIR);

    const result = pruneLearnedRules(LEARNED_MD, 3, STATE_DIR);

    expect(result.pruned).toHaveLength(2);
    expect(result.pruned).toContain("rule-1");
    expect(result.pruned).toContain("rule-3");
    expect(result.kept).toBe(3);

    const remaining = readFileSync(LEARNED_MD, "utf-8");
    expect(remaining).toContain("rule-0");
    expect(remaining).toContain("rule-2");
    expect(remaining).toContain("rule-4");
    expect(remaining).not.toContain("rule-1");
    expect(remaining).not.toContain("rule-3");
  });

  test("rules without stats get correlationScore 0 (pruned first)", () => {
    const rules = [
      { id: "tracked-rule", text: "Has stats" },
      { id: "untracked-rule", text: "No stats" },
    ];
    writeFileSync(LEARNED_MD, makeLearnedMd(rules));

    const stats: RuleStats[] = [
      makeStats("tracked-rule", { avgCorrelatedRating: 5.0 }),
    ];
    persistRuleStats(stats, STATE_DIR);

    const result = pruneLearnedRules(LEARNED_MD, 1, STATE_DIR);

    expect(result.pruned).toEqual(["untracked-rule"]);
    const remaining = readFileSync(LEARNED_MD, "utf-8");
    expect(remaining).toContain("tracked-rule");
    expect(remaining).not.toContain("untracked-rule");
  });

  test("returns empty result for missing file", () => {
    const result = pruneLearnedRules("/nonexistent/path.md", 50, STATE_DIR);
    expect(result.pruned).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  test("prunes correct number at exactly cap+1", () => {
    const rules = Array.from({ length: 4 }, (_, i) => ({
      id: `rule-${i}`,
      text: `Rule text ${i}`,
    }));
    writeFileSync(LEARNED_MD, makeLearnedMd(rules));

    const result = pruneLearnedRules(LEARNED_MD, 3, STATE_DIR);
    expect(result.pruned).toHaveLength(1);
    expect(result.kept).toBe(3);
  });
});
