import { describe, it, expect } from "bun:test";
import { attributeOutcomesToRules, computeRuleAttributions } from "../../src/scoring/turn-attribution";
import { segmentIntoMiniSessions, aggregateMiniSessions } from "../../src/scoring/aggregation";
import { detectTaskType, getOutcomeWeights } from "../../src/scoring/task-types";
import type { OutcomeEvent } from "../../src/capture/outcomes";
import type { RuleSnapshot } from "../../src/capture/rule-snapshots";

function makeEvent(type: OutcomeEvent["type"], turn: number, sessionId = "int-s1"): OutcomeEvent {
  return { type, sessionId, timestamp: new Date().toISOString(), turn };
}

function makeSnapshot(turn: number, activeRules: string[], sessionId = "int-s1"): RuleSnapshot {
  return { turn, activeRules, timestamp: new Date().toISOString(), sessionId };
}

describe("Sprint 3 integration: full scoring pipeline", () => {
  it("end-to-end: snapshots → outcomes → attribution → aggregation", () => {
    // Step 1: Rule snapshots at various turns
    const snapshots: RuleSnapshot[] = [
      makeSnapshot(1, ["evidence-before-assertion", "tdd-mandatory"]),
      makeSnapshot(15, ["evidence-before-assertion", "tdd-mandatory", "delegate-immediately"]),
      makeSnapshot(30, ["tdd-mandatory", "delegate-immediately"]),
    ];

    // Step 2: Outcome events (commits, corrections) at various turns
    const events: OutcomeEvent[] = [
      makeEvent("commit-merged", 5),     // rules: evidence, tdd
      makeEvent("tests-pass", 8),         // rules: evidence, tdd
      makeEvent("correction", 20),        // rules: evidence, tdd, delegate
      makeEvent("commit-merged", 25),     // rules: evidence, tdd, delegate
      makeEvent("issue-closed", 35),      // rules: tdd, delegate
      makeEvent("tests-pass", 38),        // rules: tdd, delegate
    ];

    // Step 3: Run turn attribution → verify correct rules get blamed
    const turnAttrs = attributeOutcomesToRules(events, snapshots);
    expect(turnAttrs).toHaveLength(6);

    // Correction at turn 20 should blame evidence+tdd+delegate, NOT just tdd+delegate
    const correctionAttr = turnAttrs.find(a => a.outcomeType === "correction")!;
    expect(correctionAttr.activeRuleIds).toContain("evidence-before-assertion");
    expect(correctionAttr.activeRuleIds).toContain("tdd-mandatory");
    expect(correctionAttr.activeRuleIds).toContain("delegate-immediately");

    // Commit at turn 5 should only blame evidence+tdd (delegate not active yet)
    const earlyCommit = turnAttrs.find(a => a.turnIndex === 5)!;
    expect(earlyCommit.activeRuleIds).not.toContain("delegate-immediately");

    // Step 4: Compute rule attributions
    const ruleAttrs = computeRuleAttributions(turnAttrs);

    const tdd = ruleAttrs.get("tdd-mandatory")!;
    expect(tdd.totalTurns).toBe(6);  // present at all outcome turns
    expect(tdd.positiveSignals).toBe(5);
    expect(tdd.negativeSignals).toBe(1);

    const delegate = ruleAttrs.get("delegate-immediately")!;
    expect(delegate.totalTurns).toBe(4);  // only present from turn 15+
    expect(delegate.positiveSignals).toBe(3);
    expect(delegate.negativeSignals).toBe(1);

    // evidence-before-assertion was removed at turn 30, so not blamed for later successes
    const evidence = ruleAttrs.get("evidence-before-assertion")!;
    expect(evidence.totalTurns).toBe(4);  // turns 5, 8, 20, 25

    // Step 5: Segment into mini-sessions → verify boundaries respected
    const boundaries = [15, 30];
    const miniSessions = segmentIntoMiniSessions(events, boundaries, "ship");
    expect(miniSessions).toHaveLength(3);

    // First mini-session (turns 0-15): 2 positive outcomes
    expect(miniSessions[0].outcomeCount).toBe(2);
    expect(miniSessions[0].score).toBeGreaterThan(5);

    // Second mini-session (turns 15-30): 1 correction + 1 commit
    expect(miniSessions[1].outcomeCount).toBe(2);

    // Third mini-session (turns 30+): 2 positive outcomes
    expect(miniSessions[2].outcomeCount).toBe(2);
    expect(miniSessions[2].score).toBeGreaterThan(5);

    // Step 6: Aggregate → verify outcome-weighted score
    const finalScore = aggregateMiniSessions(miniSessions);
    expect(finalScore).toBeGreaterThan(1);
    expect(finalScore).toBeLessThanOrEqual(10);
  });

  it("task type detection feeds into outcome weights", () => {
    const prompt = "ship the new attribution engine";
    const taskType = detectTaskType(prompt);
    expect(taskType).toBe("ship");

    const weights = getOutcomeWeights(taskType);
    expect(weights["commit-merged"]).toBe(1.0);

    const researchPrompt = "research how other systems handle attribution";
    const researchType = detectTaskType(researchPrompt);
    expect(researchType).toBe("research");

    const researchWeights = getOutcomeWeights(researchType);
    expect(researchWeights["commit-merged"]).toBeLessThan(weights["commit-merged"]);
  });

  it("per-turn blame prevents global attribution contamination", () => {
    // Rule added at turn 50, correction at turn 5 — rule should NOT be blamed
    const snapshots: RuleSnapshot[] = [
      makeSnapshot(1, ["old-rule"]),
      makeSnapshot(50, ["old-rule", "new-rule"]),
    ];
    const events: OutcomeEvent[] = [
      makeEvent("correction", 5),
      makeEvent("commit-merged", 55),
    ];

    const attrs = attributeOutcomesToRules(events, snapshots);
    const corrAttr = attrs.find(a => a.outcomeType === "correction")!;
    expect(corrAttr.activeRuleIds).not.toContain("new-rule");
    expect(corrAttr.activeRuleIds).toContain("old-rule");

    const commitAttr = attrs.find(a => a.outcomeType === "commit-merged")!;
    expect(commitAttr.activeRuleIds).toContain("new-rule");

    const ruleAttrs = computeRuleAttributions(attrs);
    const newRule = ruleAttrs.get("new-rule")!;
    expect(newRule.negativeSignals).toBe(0);
    expect(newRule.positiveSignals).toBe(1);
  });
});
