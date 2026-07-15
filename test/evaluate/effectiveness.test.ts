import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { trackRuleEffectiveness } from "../../src/evaluate/effectiveness";
import type { EffectivenessResult } from "../../src/evaluate/effectiveness";
import type { PromotionRecord, CorrectionSignal } from "../../src/adapters/types";
import { Tier } from "../../src/adapters/types";

const TMP_DIR = join(import.meta.dir, ".tmp-effectiveness-test");
const STATE_DIR = join(TMP_DIR, "state");
const SIGNAL_DIR = join(TMP_DIR, "signals");

function makePromotion(
  id: string,
  ruleId: string,
  timestamp: string,
  overrides: Partial<PromotionRecord> = {},
): PromotionRecord {
  return {
    id,
    ruleId,
    tier: Tier.Global,
    timestamp,
    beforeSnapshot: "before",
    afterSnapshot: "after",
    approved: true,
    ...overrides,
  };
}

function makeCorrection(
  phrase: string,
  timestamp: string,
  sessionId = "s1",
): CorrectionSignal {
  return {
    type: "correction",
    timestamp,
    session_id: sessionId,
    correction_phrase: phrase,
    context: `User: ${phrase}\nAssistant: I apologize`,
    schemaVersion: 1,
  };
}

function writePromotions(records: PromotionRecord[]): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  const content = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(join(STATE_DIR, "promotions.jsonl"), content);
}

function writeCorrections(signals: CorrectionSignal[]): void {
  if (!existsSync(SIGNAL_DIR)) mkdirSync(SIGNAL_DIR, { recursive: true });
  const content = signals.map((s) => JSON.stringify(s)).join("\n") + "\n";
  writeFileSync(join(SIGNAL_DIR, "corrections.jsonl"), content);
}

function writeGraphWithRules(rules: { id: string; text: string }[]): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  const nodes: Record<string, any> = {};
  for (const r of rules) {
    nodes[r.id] = {
      id: r.id,
      file: "test.md",
      type: "rule",
      name: r.id,
      description: r.text,
      domains: [],
      severity: 5,
      occurrence_count: 1,
      last_updated: new Date().toISOString(),
      content_hash: "test",
      memoryType: "rule",
    };
  }
  writeFileSync(
    join(STATE_DIR, "knowledge-graph.json"),
    JSON.stringify({ nodes, edges: [] }),
  );
}

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(SIGNAL_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

describe("trackRuleEffectiveness", () => {
  test("effective rule — corrections decrease after promotion", () => {
    const promotionDate = "2026-06-15T00:00:00Z";

    writeGraphWithRules([
      { id: "verify-before-assert", text: "Verify facts before asserting claims" },
    ]);

    writePromotions([
      makePromotion("p1", "verify-before-assert", promotionDate),
    ]);

    writeCorrections([
      // 3 corrections BEFORE promotion matching the rule's domain
      makeCorrection("wrong, you didn't verify that", "2026-06-10T00:00:00Z", "s1"),
      makeCorrection("stop asserting without evidence", "2026-06-11T00:00:00Z", "s2"),
      makeCorrection("that's wrong, verify first", "2026-06-12T00:00:00Z", "s3"),
      // 1 correction AFTER promotion
      makeCorrection("wrong, you didn't verify", "2026-06-20T00:00:00Z", "s4"),
    ]);

    const results = trackRuleEffectiveness(STATE_DIR, SIGNAL_DIR);

    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.ruleId).toBe("verify-before-assert");
    expect(r.beforeFreq).toBe(3);
    expect(r.afterFreq).toBe(1);
    expect(r.delta).toBe(-2);
    expect(r.effective).toBe(true);
  });

  test("ineffective rule — corrections stay same or increase after promotion", () => {
    const promotionDate = "2026-06-15T00:00:00Z";

    writeGraphWithRules([
      { id: "delegate-tasks", text: "Delegate implementation tasks to specialist agents" },
    ]);

    writePromotions([
      makePromotion("p1", "delegate-tasks", promotionDate),
    ]);

    writeCorrections([
      // 1 correction BEFORE
      makeCorrection("you should have delegated that task", "2026-06-10T00:00:00Z", "s1"),
      // 2 corrections AFTER — increased
      makeCorrection("stop doing implementation, delegate to agents", "2026-06-20T00:00:00Z", "s2"),
      makeCorrection("I said delegate tasks to specialists", "2026-06-25T00:00:00Z", "s3"),
    ]);

    const results = trackRuleEffectiveness(STATE_DIR, SIGNAL_DIR);

    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.ruleId).toBe("delegate-tasks");
    expect(r.beforeFreq).toBe(1);
    expect(r.afterFreq).toBe(2);
    expect(r.delta).toBe(1);
    expect(r.effective).toBe(false);
  });

  test("no-data rule — no matching corrections at all", () => {
    const promotionDate = "2026-06-15T00:00:00Z";

    writeGraphWithRules([
      { id: "unique-niche-rule", text: "Always use container-first deployment for production services" },
    ]);

    writePromotions([
      makePromotion("p1", "unique-niche-rule", promotionDate),
    ]);

    // No corrections match this rule's domain
    writeCorrections([
      makeCorrection("wrong color on the button", "2026-06-10T00:00:00Z", "s1"),
      makeCorrection("fix the typo in the header", "2026-06-20T00:00:00Z", "s2"),
    ]);

    const results = trackRuleEffectiveness(STATE_DIR, SIGNAL_DIR);

    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.ruleId).toBe("unique-niche-rule");
    expect(r.beforeFreq).toBe(0);
    expect(r.afterFreq).toBe(0);
    expect(r.delta).toBe(0);
    expect(r.effective).toBe(false);
  });

  test("returns empty when no promotions exist", () => {
    writeCorrections([
      makeCorrection("some correction", "2026-06-10T00:00:00Z"),
    ]);

    const results = trackRuleEffectiveness(STATE_DIR, SIGNAL_DIR);
    expect(results).toEqual([]);
  });

  test("handles multiple promoted rules independently", () => {
    writeGraphWithRules([
      { id: "rule-a", text: "Verify before answering questions" },
      { id: "rule-b", text: "Delegate code changes to engineers" },
    ]);

    writePromotions([
      makePromotion("p1", "rule-a", "2026-06-10T00:00:00Z"),
      makePromotion("p2", "rule-b", "2026-06-20T00:00:00Z"),
    ]);

    writeCorrections([
      // rule-a related
      makeCorrection("wrong answer, verify first", "2026-06-05T00:00:00Z", "s1"),
      makeCorrection("you didn't verify that answer", "2026-06-15T00:00:00Z", "s2"),
      // rule-b related
      makeCorrection("stop writing code, delegate to engineer", "2026-06-15T00:00:00Z", "s3"),
      makeCorrection("delegate the code changes", "2026-06-25T00:00:00Z", "s4"),
    ]);

    const results = trackRuleEffectiveness(STATE_DIR, SIGNAL_DIR);
    expect(results).toHaveLength(2);

    const ruleA = results.find((r) => r.ruleId === "rule-a");
    const ruleB = results.find((r) => r.ruleId === "rule-b");

    expect(ruleA).toBeDefined();
    expect(ruleB).toBeDefined();
  });

  test("result has correct shape", () => {
    writeGraphWithRules([
      { id: "test-rule", text: "Always check before asserting" },
    ]);

    writePromotions([
      makePromotion("p1", "test-rule", "2026-06-15T00:00:00Z"),
    ]);

    writeCorrections([]);

    const results = trackRuleEffectiveness(STATE_DIR, SIGNAL_DIR);
    expect(results).toHaveLength(1);
    const r = results[0];

    // Verify all required fields exist
    expect(r).toHaveProperty("ruleId");
    expect(r).toHaveProperty("patternText");
    expect(r).toHaveProperty("beforeFreq");
    expect(r).toHaveProperty("afterFreq");
    expect(r).toHaveProperty("delta");
    expect(r).toHaveProperty("effective");
    expect(typeof r.ruleId).toBe("string");
    expect(typeof r.patternText).toBe("string");
    expect(typeof r.beforeFreq).toBe("number");
    expect(typeof r.afterFreq).toBe("number");
    expect(typeof r.delta).toBe("number");
    expect(typeof r.effective).toBe("boolean");
  });

  test("only counts approved promotions", () => {
    writeGraphWithRules([
      { id: "approved-rule", text: "Always verify before responding" },
      { id: "rejected-rule", text: "Never skip test suite" },
    ]);

    writePromotions([
      makePromotion("p1", "approved-rule", "2026-06-15T00:00:00Z", { approved: true }),
      makePromotion("p2", "rejected-rule", "2026-06-15T00:00:00Z", { approved: false }),
    ]);

    writeCorrections([]);

    const results = trackRuleEffectiveness(STATE_DIR, SIGNAL_DIR);
    // Only the approved promotion should be tracked
    expect(results).toHaveLength(1);
    expect(results[0].ruleId).toBe("approved-rule");
  });
});
