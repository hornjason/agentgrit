import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { filterLearnedRules, writeSessionContext } from "../../src/graph/context";
import { checkLearnedBudget, parseLearnedRules as parseLearnedBudgetRules } from "../../src/promote/budget";
import { findEvictionCandidates } from "../../src/promote/evict";
import { persistRuleStats } from "../../src/promote/rules";
import { runDoctor } from "../../src/daemon/doctor";
import { Tier } from "../../src/adapters/types";
import type { Rule } from "../../src/adapters/types";
import type { RuleStats } from "../../src/promote/rules";
import type { AgentGritConfig } from "../../src/adapters/types";

const TMP_DIR = join(import.meta.dir, ".tmp-system-invariants");
const SIGNALS_DIR = join(TMP_DIR, "signals");
const STATE_DIR = join(TMP_DIR, "state");
const RULES_DIR = join(TMP_DIR, "rules");
const LEARNED_MD = join(TMP_DIR, "CLAUDE-LEARNED.md");

function makeRule(id: string, text: string): Rule {
  return {
    id,
    text,
    tier: Tier.Graph,
    tags: [],
    created: new Date().toISOString(),
    correlationScore: 0.5,
    sourceSignals: [],
    schemaVersion: 1,
  };
}

function seedLearnedMd(count: number): string[] {
  const ids: string[] = [];
  const lines = ["# Learned Rules", "", "### Learned Rules"];
  for (let i = 0; i < count; i++) {
    const id = `rule-invariant-${String(i).padStart(3, "0")}`;
    ids.push(id);
    lines.push(`- **${id}:** Test rule number ${i} for invariant testing`);
  }
  writeFileSync(LEARNED_MD, lines.join("\n") + "\n", "utf-8");
  return ids;
}

function seedRuleStats(stats: RuleStats[]): void {
  persistRuleStats(stats, STATE_DIR);
}

function makeConfig(): AgentGritConfig {
  return {
    signalDir: SIGNALS_DIR,
    memoryDir: join(TMP_DIR, "memory"),
    adapter: "local",
    rubrics: [],
    rules: {
      globalBudget: 25,
      projectBudget: 25,
      learnedBudget: 50,
      autoPromote: false,
    },
    daemon: {
      interval: "hourly",
      weeklyDay: "sunday",
    },
  };
}

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(SIGNALS_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(RULES_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

describe("system invariants", () => {
  test("budget ceiling: filterLearnedRules output <=10 and total composition <=20", () => {
    // Create 30 learned rules as string array (the format filterLearnedRules expects)
    const rules: string[] = [];
    for (let i = 0; i < 30; i++) {
      rules.push(`- **rule-${i}:** Rule about ${["deployment", "testing", "verification", "security", "monitoring"][i % 5]} workflow number ${i}`);
    }

    // filterLearnedRules with default topK=10 should return at most 10
    const filtered = filterLearnedRules(rules, "deployment verification testing", 10);
    expect(filtered.length).toBeLessThanOrEqual(10);
    expect(filtered.length).toBeGreaterThan(0);

    // Simulate composition: filtered learned rules + graph rules
    const graphRuleCount = 10; // simulated graph rules added during composition
    const totalComposed = filtered.length + graphRuleCount;
    expect(totalComposed).toBeLessThanOrEqual(20);
  });

  test("telemetry non-zero: writeSessionContext produces history entry with rules and totalContextLines", () => {
    const rules: Rule[] = [
      makeRule("feedback_verify_deploy", "Always verify deployment artifacts"),
      makeRule("feedback_test_browser", "Test in browser before claiming done"),
      makeRule("success_audit_pattern", "Audit before making changes"),
    ];

    const totalContextLines = 42;

    // Write session context — uses AGENTGRIT_DIR for path resolution
    writeSessionContext(rules, ["deployment", "verification"], "keyword", totalContextLines);

    // Read session-context-history.jsonl and verify last entry
    const historyPath = join(STATE_DIR, "session-context-history.jsonl");
    expect(existsSync(historyPath)).toBe(true);

    const lines = readFileSync(historyPath, "utf-8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);

    const lastEntry = JSON.parse(lines[lines.length - 1]);
    expect(lastEntry.ruleIds.length).toBeGreaterThan(0);
    expect(lastEntry.totalContextLines).toBeGreaterThan(0);
    expect(lastEntry.totalContextLines).toBe(42);
    expect(lastEntry.rulesInjectedCount).toBe(3);
  });

  test("eviction floor: rule with high injections and low rating is flagged as eviction candidate", () => {
    // Create rule-stats fixture with a clearly evictable rule
    seedRuleStats([
      {
        ruleId: "feedback_bad_invariant",
        injectionCount: 150,
        avgCorrelatedRating: 2.5,
        sessionRatings: Array(20).fill(2.5),
        highRatingActivations: 0,
        lowRatingActivations: 150,
        lastSeen: new Date().toISOString(),
      },
      {
        ruleId: "feedback_good_invariant",
        injectionCount: 100,
        avgCorrelatedRating: 8.0,
        sessionRatings: Array(20).fill(8.0),
        highRatingActivations: 100,
        lowRatingActivations: 0,
        lastSeen: new Date().toISOString(),
      },
    ]);

    const candidates = findEvictionCandidates({
      stateDir: STATE_DIR,
      threshold: 3.0,
      minSessions: 5,
    });

    const candidateIds = candidates.map(c => c.ruleId);
    expect(candidateIds).toContain("feedback_bad_invariant");
    expect(candidateIds).not.toContain("feedback_good_invariant");

    // Verify the flagged rule matches expected criteria
    const badCandidate = candidates.find(c => c.ruleId === "feedback_bad_invariant");
    expect(badCandidate).toBeDefined();
    expect(badCandidate!.avgCorrelatedRating).toBeLessThan(3.0);
    expect(badCandidate!.sessionCount).toBeGreaterThanOrEqual(100);
  });

  test("doctor clean exit: runDoctor returns 0 errors on clean test environment", async () => {
    const config = makeConfig();

    const report = await runDoctor(config);

    // Count errors across all sections
    const errorChecks = report.sections.flatMap(s => s.checks).filter(c => c.status === "error");
    expect(errorChecks.length).toBe(0);

    // Overall should not be "error" — warnings are acceptable for a fresh env
    expect(report.overall).not.toBe("error");

    // Verify the report has sections (doctor actually ran)
    expect(report.sections.length).toBeGreaterThan(0);
    expect(report.timestamp).toBeTruthy();
  });

  test("rule count consistency: parseLearnedRules count matches checkLearnedBudget with no OVER_BUDGET", () => {
    // Create CLAUDE-LEARNED.md with 30 rules (well under 50 cap)
    const ruleCount = 30;
    seedLearnedMd(ruleCount);

    // Parse the file using budget module's parser
    const content = readFileSync(LEARNED_MD, "utf-8");
    const parsed = parseLearnedBudgetRules(content);
    expect(parsed.length).toBe(ruleCount);

    // Verify checkLearnedBudget reports no OVER_BUDGET
    const budgetStatus = checkLearnedBudget(parsed.length, 50);
    expect(budgetStatus.level).not.toBe("OVER_BUDGET");
    expect(budgetStatus.ruleCount).toBe(ruleCount);
    expect(budgetStatus.cap).toBe(50);
    expect(budgetStatus.remaining).toBe(50 - ruleCount);

    // Also verify that a count AT the cap is not OVER_BUDGET
    const atCapStatus = checkLearnedBudget(50, 50);
    expect(atCapStatus.level).not.toBe("OVER_BUDGET");

    // And that exceeding the cap IS OVER_BUDGET
    const overStatus = checkLearnedBudget(51, 50);
    expect(overStatus.level).toBe("OVER_BUDGET");
  });
});
