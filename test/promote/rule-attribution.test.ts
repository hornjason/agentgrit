import { describe, test, expect } from "bun:test";
import { attributeRulesToCorrections } from "../../src/promote/attribution";
import type { CorrectionSignal } from "../../src/adapters/types";

function makeCorrection(phrase: string, context: string, sessionId = "s1"): CorrectionSignal {
  return {
    type: "correction",
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    correction_phrase: phrase,
    context,
  };
}

describe("attributeRulesToCorrections", () => {
  test("returns empty array for empty rules", () => {
    const result = attributeRulesToCorrections([], [], 7);
    expect(result).toEqual([]);
  });

  test("all rules get base score when no corrections", () => {
    const rules = [
      { id: "r1", text: "always verify before answering" },
      { id: "r2", text: "keep scope minimal" },
    ];
    const result = attributeRulesToCorrections(rules, [], 8);

    expect(result).toHaveLength(2);
    expect(result[0].baseScore).toBe(8);
    expect(result[0].attributedScore).toBe(8);
    expect(result[1].attributedScore).toBe(8);
  });

  test("rules matching correction context get penalized", () => {
    const rules = [
      { id: "verify-rule", text: "always verify state before deploying to production" },
      { id: "scope-rule", text: "keep scope minimal and focused on the task" },
    ];

    const corrections = [
      makeCorrection("you didn't verify", "you deployed without verifying the production state"),
    ];

    const result = attributeRulesToCorrections(rules, corrections, 7);

    const verifyAttr = result.find(a => a.ruleId === "verify-rule")!;
    const scopeAttr = result.find(a => a.ruleId === "scope-rule")!;

    expect(verifyAttr.attributedScore).toBeLessThan(verifyAttr.baseScore);
    expect(verifyAttr.correctionProximity).toBeGreaterThan(0.3);
    expect(scopeAttr.correctionProximity).toBeLessThan(verifyAttr.correctionProximity);
  });

  test("attributed score cannot exceed session score", () => {
    const rules = [
      { id: "r1", text: "unrelated rule about something random", domains: ["security"] },
    ];

    const result = attributeRulesToCorrections(rules, [], 6, ["security"]);

    expect(result[0].attributedScore).toBeLessThanOrEqual(6);
  });

  test("attributed score floors at 1", () => {
    const rules = [
      { id: "r1", text: "verify production deploy state verify deploy" },
    ];

    const corrections = [
      makeCorrection("wrong", "verify production deploy state"),
      makeCorrection("still wrong", "verify production deploy again"),
      makeCorrection("not right", "verify deploy production"),
      makeCorrection("fix this", "deploy production verify state"),
    ];

    const result = attributeRulesToCorrections(rules, corrections, 2);

    expect(result[0].attributedScore).toBeGreaterThanOrEqual(1);
  });

  test("correctionProximity tracks highest BM25 similarity", () => {
    const rules = [
      { id: "r1", text: "always run make rebuild before deploying containers" },
    ];

    const corrections = [
      makeCorrection("no", "unrelated context about testing"),
      makeCorrection("wrong deploy", "you should have run make rebuild before deploying"),
    ];

    const result = attributeRulesToCorrections(rules, corrections, 7);

    expect(result[0].correctionProximity).toBeGreaterThan(0);
  });

  test("domain match bonus applied when no corrections and domains match", () => {
    const rules = [
      { id: "r1", text: "generic rule about something", domains: ["deployment"] },
      { id: "r2", text: "another rule about things", domains: ["security"] },
    ];

    const result = attributeRulesToCorrections(rules, [], 5, ["deployment"]);

    const r1 = result.find(a => a.ruleId === "r1")!;
    const r2 = result.find(a => a.ruleId === "r2")!;

    expect(r1.attributedScore).toBeLessThanOrEqual(5);
    expect(r2.attributedScore).toBe(5);
  });

  test("domain bonus not applied when corrections exist", () => {
    const rules = [
      { id: "r1", text: "generic rule about something", domains: ["deployment"] },
    ];

    const corrections = [
      makeCorrection("wrong", "completely unrelated correction context"),
    ];

    const resultWithCorr = attributeRulesToCorrections(rules, corrections, 5, ["deployment"]);
    const resultWithout = attributeRulesToCorrections(rules, [], 5, ["deployment"]);

    expect(resultWithCorr[0].attributedScore).toBeLessThanOrEqual(resultWithout[0].attributedScore);
  });

  test("sessionId populated from first correction", () => {
    const rules = [{ id: "r1", text: "some rule text" }];
    const corrections = [makeCorrection("no", "context", "session-abc")];

    const result = attributeRulesToCorrections(rules, corrections, 6);
    expect(result[0].sessionId).toBe("session-abc");
  });

  test("sessionId empty string when no corrections", () => {
    const rules = [{ id: "r1", text: "some rule text" }];
    const result = attributeRulesToCorrections(rules, [], 6);
    expect(result[0].sessionId).toBe("");
  });

  test("multiple corrections compound penalties for matching rules", () => {
    const rules = [
      { id: "r1", text: "always verify endpoints before deploying to production environment" },
    ];

    const corrections = [
      makeCorrection("wrong", "you didn't verify the endpoints before deploying"),
      makeCorrection("still wrong", "verify endpoints production deploy"),
    ];

    const result = attributeRulesToCorrections(rules, corrections, 8);

    expect(result[0].attributedScore).toBeLessThan(8);
    expect(result[0].attributedScore).toBeGreaterThanOrEqual(1);
  });
});
