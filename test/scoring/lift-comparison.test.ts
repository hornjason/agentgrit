import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";

const tmpDir = join(import.meta.dir, ".tmp-lift-comparison");
const stateDir = join(tmpDir, "state");
const signalDir = join(tmpDir, "signals");

import { compareLiftMethods, type LiftComparison } from "../../src/scoring/lift-comparison";
import type { OutcomeEvent } from "../../src/capture/outcomes";
import type { RuleStats } from "../../src/promote/rules";

function writeOutcomes(events: OutcomeEvent[]): void {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const content = events.map(e => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(stateDir, "outcome-events.jsonl"), content);
}

function writeRatings(entries: Array<{ session_id: string; rating: number; source: string; rule_ids?: string[] }>): void {
  if (!existsSync(signalDir)) mkdirSync(signalDir, { recursive: true });
  const content = entries.map(e => JSON.stringify({ ...e, timestamp: new Date().toISOString() })).join("\n") + "\n";
  writeFileSync(join(signalDir, "ratings.jsonl"), content);
}

function writeRuleStats(stats: RuleStats[]): void {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "rule-stats.json"), JSON.stringify(stats, null, 2));
}

describe("lift-comparison", () => {
  beforeEach(() => {
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(signalDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it("detects agreement when both lifts are positive", () => {
    const stats: RuleStats[] = [
      {
        ruleId: "rule-1",
        injectionCount: 5,
        avgCorrelatedRating: 8.0,
        sessionRatings: [8, 9, 7, 8, 8],
        highRatingActivations: 4,
        lowRatingActivations: 0,
        lastSeen: new Date().toISOString(),
        differentialLift: 2.0,
      },
    ];
    writeRuleStats(stats);

    const outcomes: OutcomeEvent[] = [
      { type: "commit-merged", sessionId: "s1", timestamp: new Date().toISOString(), turn: 1 },
      { type: "tests-pass", sessionId: "s1", timestamp: new Date().toISOString(), turn: 2 },
      { type: "issue-closed", sessionId: "s1", timestamp: new Date().toISOString(), turn: 3 },
    ];
    writeOutcomes(outcomes);
    writeRatings([
      { session_id: "s1", rating: 8.0, source: "transcript-analysis", rule_ids: ["rule-1"] },
    ]);

    const results = compareLiftMethods(stateDir, signalDir);
    expect(results.length).toBeGreaterThan(0);
    const r1 = results.find(r => r.ruleId === "rule-1");
    expect(r1).toBeDefined();
    expect(r1!.agreement).toBe("agree");
  });

  it("detects divergence when keyword positive but outcome negative", () => {
    const stats: RuleStats[] = [
      {
        ruleId: "rule-2",
        injectionCount: 5,
        avgCorrelatedRating: 7.5,
        sessionRatings: [7, 8, 7, 8, 7],
        highRatingActivations: 3,
        lowRatingActivations: 0,
        lastSeen: new Date().toISOString(),
        differentialLift: 1.5,
      },
    ];
    writeRuleStats(stats);

    // s1 (rule-2 active): corrections only → low outcome score
    // s2 (no rule-2): commits/merges → high outcome score
    // This pushes global outcome avg above rule-2's outcome avg → negative outcome lift
    const outcomes: OutcomeEvent[] = [
      { type: "correction", sessionId: "s1", timestamp: new Date().toISOString(), turn: 1 },
      { type: "correction", sessionId: "s1", timestamp: new Date().toISOString(), turn: 3 },
      { type: "reprompt", sessionId: "s1", timestamp: new Date().toISOString(), turn: 5 },
      { type: "commit-merged", sessionId: "s2", timestamp: new Date().toISOString(), turn: 1 },
      { type: "tests-pass", sessionId: "s2", timestamp: new Date().toISOString(), turn: 2 },
      { type: "issue-closed", sessionId: "s2", timestamp: new Date().toISOString(), turn: 3 },
      { type: "pr-merged", sessionId: "s2", timestamp: new Date().toISOString(), turn: 4 },
    ];
    writeOutcomes(outcomes);
    writeRatings([
      { session_id: "s1", rating: 7.5, source: "transcript-analysis", rule_ids: ["rule-2"] },
      { session_id: "s2", rating: 6.0, source: "transcript-analysis" },
    ]);

    const results = compareLiftMethods(stateDir, signalDir);
    const r2 = results.find(r => r.ruleId === "rule-2");
    expect(r2).toBeDefined();
    expect(r2!.agreement).toBe("diverge");
  });

  it("returns insufficient-data for rules with no outcome events", () => {
    const stats: RuleStats[] = [
      {
        ruleId: "rule-3",
        injectionCount: 2,
        avgCorrelatedRating: 6.0,
        sessionRatings: [6, 6],
        highRatingActivations: 0,
        lowRatingActivations: 0,
        lastSeen: new Date().toISOString(),
      },
    ];
    writeRuleStats(stats);
    writeOutcomes([]);
    writeRatings([
      { session_id: "s1", rating: 6.0, source: "transcript-analysis", rule_ids: ["rule-3"] },
    ]);

    const results = compareLiftMethods(stateDir, signalDir);
    const r3 = results.find(r => r.ruleId === "rule-3");
    expect(r3).toBeDefined();
    expect(r3!.agreement).toBe("insufficient-data");
  });
});
