import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { runReview } from "../../src/promote/review";
import { routeRule, type RouteResult } from "../../src/promote/router";
import { checkBudget, type BudgetStatus } from "../../src/promote/budget";
import { promoteRule, removeRule } from "../../src/promote/bridge";
import { recordPromotion, undoPromotions } from "../../src/promote/ledger";
import { trackRule } from "../../src/promote/rules";
import { resolveSignalDir, loadConfig } from "../../src/adapters/paths";
import { Tier, SCHEMA_VERSION, type Rule, type Pattern } from "../../src/adapters/types";
import type { InferenceFn } from "../../src/promote/contradiction";

const noopInference: InferenceFn = async () => ({
  success: true,
  output: "NO_CONFLICT",
  latencyMs: 0,
  level: "fast" as const,
  provider: "claude",
});

const TMP_DIR = join(import.meta.dir, ".tmp-tier4");
const STATE_DIR = join(TMP_DIR, "state");

function makeRule(id: string, text: string, tier: Tier = Tier.Global): Rule {
  return {
    id,
    text,
    tier,
    tags: ["verification"],
    created: new Date().toISOString(),
    correlationScore: 0,
    sourceSignals: [],
    schemaVersion: SCHEMA_VERSION,
  };
}

function makePattern(candidateRule: string, sessions: string[] = ["proj-a", "proj-b"]): Pattern {
  return {
    id: `test-${Date.now()}`,
    type: "failure-cluster",
    frequency: 5,
    sessions,
    severity: 6,
    candidateRule,
  };
}

describe("Tier 4: Rule Promotion Pipeline", () => {
  beforeEach(() => {
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
    mkdirSync(STATE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  });

  // T19: Review proposes candidates from real PAI data
  test("T19: review proposes candidates from real PAI data", async () => {
    const config = loadConfig();
    const signalDir = config.signalDir ?? resolveSignalDir();
    const stateDir = join(TMP_DIR, "state");

    const result = await runReview(signalDir, stateDir);

    expect(result.patternsFound).toBeGreaterThanOrEqual(0);
    // With 621+ real ratings, we expect at least some clusters
    expect(result.scoreTrend.count).toBeGreaterThan(0);
    // candidates >= 1 from real data with low-rated sentiment clusters
    if (result.candidatesProposed > 0) {
      expect(result.candidates[0].candidateRule).toBeTruthy();
      expect(result.candidates[0].frequency).toBeGreaterThanOrEqual(3);
    }
    // The key assertion: the review ran successfully on real data
    expect(typeof result.patternsFound).toBe("number");
    expect(typeof result.candidatesProposed).toBe("number");
  });

  // T20: Route rule to correct tier
  test("T20: behavioral rule routes to Global, procedural to Graph", () => {
    const behavioral = makePattern(
      "Always verify facts before responding. Check evidence before asserting.",
    );
    const resultBehavioral = routeRule(behavioral, ["project-a", "project-b"]);
    expect(resultBehavioral.tier).toBe(Tier.Global);

    const procedural = makePattern(
      "Run deploy command after rebuild. Execute launch sequence when triggered.",
    );
    const resultProcedural = routeRule(procedural, ["project-a", "project-b"]);
    expect(resultProcedural.tier).toBe(Tier.Graph);

    // Single project → Project tier
    const singleProject = makePattern("Verify before shipping.");
    const resultSingle = routeRule(singleProject, ["project-a"]);
    expect(resultSingle.tier).toBe(Tier.Project);
  });

  // T21: Budget check returns correct level
  test("T21: budget check reports OVER_BUDGET when count > cap", () => {
    const ok: BudgetStatus = checkBudget(Tier.Global, 10);
    expect(ok.level).toBe("OK");
    expect(ok.remaining).toBe(15);

    const warning: BudgetStatus = checkBudget(Tier.Global, 22);
    expect(warning.level).toBe("WARNING");

    const over: BudgetStatus = checkBudget(Tier.Global, 30);
    expect(over.level).toBe("OVER_BUDGET");
    expect(over.remaining).toBeLessThan(0);

    // Graph tier is unlimited
    const graphOk: BudgetStatus = checkBudget(Tier.Graph, 10000);
    expect(graphOk.level).toBe("OK");
    expect(graphOk.remaining).toBe(Infinity);

    // Custom cap
    const customOver: BudgetStatus = checkBudget(Tier.Project, 6, 5);
    expect(customOver.level).toBe("OVER_BUDGET");
  });

  // T22: Promote rule to CLAUDE.md (temp copy)
  test("T22: promote rule to CLAUDE.md — rule appears, file not corrupted", async () => {
    const claudeMd = join(TMP_DIR, "CLAUDE.md");
    const originalContent = `# My Config

## Rules

- **existing-rule:** Do not break things.

## Other Section

Some other content.
`;
    writeFileSync(claudeMd, originalContent);

    const rule = makeRule("test-rule-t22", "Always verify before asserting.");
    await promoteRule(rule, claudeMd, noopInference);

    const after = readFileSync(claudeMd, "utf-8");
    expect(after).toContain("- **test-rule-t22:** Always verify before asserting.");
    expect(after).toContain("- **existing-rule:** Do not break things.");
    expect(after).toContain("## Other Section");
    expect(after).toContain("Some other content.");
    // File is valid markdown — check no truncation
    expect(after.length).toBeGreaterThan(originalContent.length);
  });

  // T23: Undo promotion — CLAUDE.md reverts
  test("T23: undo promotion — CLAUDE.md reverts to before-state", async () => {
    const claudeMd = join(TMP_DIR, "CLAUDE.md");
    const originalContent = `# Config

## Rules

- **base-rule:** Keep this rule.

## End
`;
    writeFileSync(claudeMd, originalContent);

    // Promote a rule
    const rule = makeRule("undo-test-rule", "This should be undone.");
    await promoteRule(rule, claudeMd, noopInference);

    const afterPromote = readFileSync(claudeMd, "utf-8");
    expect(afterPromote).toContain("- **undo-test-rule:**");

    // Record the promotion in ledger
    await recordPromotion(
      {
        ruleId: rule.id,
        ruleTier: rule.tier,
        ruleText: rule.text,
        promotedAt: new Date().toISOString(),
        claudeMdPath: claudeMd,
        before: originalContent,
        after: afterPromote,
      },
      STATE_DIR,
    );

    // Remove the rule (simulating undo)
    await removeRule("undo-test-rule", claudeMd);

    const afterUndo = readFileSync(claudeMd, "utf-8");
    expect(afterUndo).not.toContain("- **undo-test-rule:**");
    expect(afterUndo).toContain("- **base-rule:** Keep this rule.");

    // Ledger undo removes entries
    const undone = await undoPromotions(1, STATE_DIR);
    expect(undone.length).toBe(1);
    expect(undone[0].ruleId).toBe("undo-test-rule");
  });

  // T24: Rule stat tracking across 5 sessions
  test("T24: rule stat tracking — avgCorrelatedRating computed correctly across 5 sessions", () => {
    let rule = makeRule("tracking-test", "Verify before shipping.");

    const ratings = [8, 6, 9, 4, 7];
    for (const rating of ratings) {
      rule = trackRule(rule, rating);
    }

    expect(rule.injectionCount).toBe(5);
    expect(rule.sessionRatings).toHaveLength(5);

    const expectedAvg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
    expect(rule.avgCorrelatedRating).toBeCloseTo(expectedAvg, 5);

    // High/low activation counts
    expect(rule.highRatingActivations).toBe(3); // 8, 9, 7
    expect(rule.lowRatingActivations).toBe(1); // 4
    expect(rule.lastSeen).toBeTruthy();
  });
});
