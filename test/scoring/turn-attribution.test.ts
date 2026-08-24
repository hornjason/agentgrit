import { describe, it, expect } from "bun:test";
import {
  attributeOutcomesToRules,
  computeRuleAttributions,
  type TurnAttribution,
} from "../../src/scoring/turn-attribution";
import type { OutcomeEvent } from "../../src/capture/outcomes";
import type { RuleSnapshot } from "../../src/capture/rule-snapshots";

function makeEvent(type: OutcomeEvent["type"], turn: number, sessionId = "s1"): OutcomeEvent {
  return { type, sessionId, timestamp: new Date().toISOString(), turn };
}

function makeSnapshot(turn: number, activeRules: string[], sessionId = "s1"): RuleSnapshot {
  return { turn, activeRules, timestamp: new Date().toISOString(), sessionId };
}

describe("attributeOutcomesToRules", () => {
  it("creates attribution linking outcomes to active rules at that turn", () => {
    const snapshots: RuleSnapshot[] = [
      makeSnapshot(1, ["rule-a", "rule-b"]),
      makeSnapshot(10, ["rule-a", "rule-c"]),
    ];
    const events: OutcomeEvent[] = [
      makeEvent("commit-merged", 5),
      makeEvent("correction", 15),
    ];

    const result = attributeOutcomesToRules(events, snapshots);

    expect(result).toHaveLength(2);
    expect(result[0].turnIndex).toBe(5);
    expect(result[0].activeRuleIds).toEqual(["rule-a", "rule-b"]);
    expect(result[0].outcomeType).toBe("commit-merged");

    expect(result[1].turnIndex).toBe(15);
    expect(result[1].activeRuleIds).toEqual(["rule-a", "rule-c"]);
    expect(result[1].outcomeType).toBe("correction");
  });

  it("uses most recent snapshot at or before the turn", () => {
    const snapshots: RuleSnapshot[] = [
      makeSnapshot(1, ["rule-x"]),
      makeSnapshot(5, ["rule-y"]),
      makeSnapshot(10, ["rule-z"]),
    ];
    const events: OutcomeEvent[] = [
      makeEvent("tests-pass", 7),
    ];

    const result = attributeOutcomesToRules(events, snapshots);
    expect(result[0].activeRuleIds).toEqual(["rule-y"]);
  });

  it("does NOT blame rules from later snapshots for earlier outcomes", () => {
    const snapshots: RuleSnapshot[] = [
      makeSnapshot(1, ["rule-old"]),
      makeSnapshot(50, ["rule-new"]),
    ];
    const events: OutcomeEvent[] = [
      makeEvent("correction", 5),
    ];

    const result = attributeOutcomesToRules(events, snapshots);
    expect(result[0].activeRuleIds).toEqual(["rule-old"]);
    expect(result[0].activeRuleIds).not.toContain("rule-new");
  });

  it("returns empty rules when no snapshots exist before the outcome turn", () => {
    const snapshots: RuleSnapshot[] = [
      makeSnapshot(10, ["rule-late"]),
    ];
    const events: OutcomeEvent[] = [
      makeEvent("correction", 3),
    ];

    const result = attributeOutcomesToRules(events, snapshots);
    expect(result[0].activeRuleIds).toEqual([]);
  });

  it("handles empty events", () => {
    const result = attributeOutcomesToRules([], [makeSnapshot(1, ["rule-a"])]);
    expect(result).toHaveLength(0);
  });

  it("handles empty snapshots", () => {
    const result = attributeOutcomesToRules([makeEvent("commit-merged", 5)], []);
    expect(result).toHaveLength(1);
    expect(result[0].activeRuleIds).toEqual([]);
  });
});

describe("computeRuleAttributions", () => {
  it("aggregates positive and negative signals per rule", () => {
    const attributions: TurnAttribution[] = [
      { turnIndex: 5, outcomeType: "commit-merged", activeRuleIds: ["rule-a", "rule-b"], weight: 1.0 },
      { turnIndex: 10, outcomeType: "tests-pass", activeRuleIds: ["rule-a"], weight: 0.8 },
      { turnIndex: 15, outcomeType: "correction", activeRuleIds: ["rule-a", "rule-c"], weight: -0.3 },
    ];

    const result = computeRuleAttributions(attributions);

    const ruleA = result.get("rule-a")!;
    expect(ruleA.positiveSignals).toBe(2);
    expect(ruleA.negativeSignals).toBe(1);
    expect(ruleA.totalTurns).toBe(3);

    const ruleB = result.get("rule-b")!;
    expect(ruleB.positiveSignals).toBe(1);
    expect(ruleB.negativeSignals).toBe(0);
    expect(ruleB.totalTurns).toBe(1);

    const ruleC = result.get("rule-c")!;
    expect(ruleC.positiveSignals).toBe(0);
    expect(ruleC.negativeSignals).toBe(1);
    expect(ruleC.totalTurns).toBe(1);
  });

  it("computes weighted attribution score", () => {
    const attributions: TurnAttribution[] = [
      { turnIndex: 1, outcomeType: "commit-merged", activeRuleIds: ["rule-x"], weight: 1.0 },
      { turnIndex: 2, outcomeType: "tests-pass", activeRuleIds: ["rule-x"], weight: 0.8 },
    ];

    const result = computeRuleAttributions(attributions);
    const ruleX = result.get("rule-x")!;
    expect(ruleX.attributionScore).toBeGreaterThan(0);
  });

  it("returns negative attribution for consistently bad rules", () => {
    const attributions: TurnAttribution[] = [
      { turnIndex: 1, outcomeType: "correction", activeRuleIds: ["bad-rule"], weight: -0.3 },
      { turnIndex: 2, outcomeType: "correction", activeRuleIds: ["bad-rule"], weight: -0.3 },
      { turnIndex: 3, outcomeType: "reprompt", activeRuleIds: ["bad-rule"], weight: -0.5 },
    ];

    const result = computeRuleAttributions(attributions);
    const bad = result.get("bad-rule")!;
    expect(bad.attributionScore).toBeLessThan(0);
    expect(bad.negativeSignals).toBe(3);
    expect(bad.positiveSignals).toBe(0);
  });

  it("handles empty attributions", () => {
    const result = computeRuleAttributions([]);
    expect(result.size).toBe(0);
  });

  it("treats healthy-iteration as neutral (weight 0)", () => {
    const attributions: TurnAttribution[] = [
      { turnIndex: 1, outcomeType: "healthy-iteration", activeRuleIds: ["rule-a"], weight: 0.0 },
    ];

    const result = computeRuleAttributions(attributions);
    const ruleA = result.get("rule-a")!;
    expect(ruleA.positiveSignals).toBe(0);
    expect(ruleA.negativeSignals).toBe(0);
    expect(ruleA.attributionScore).toBe(0);
  });
});
