import { describe, test, expect } from "bun:test";
import {
  recallAtK,
  evaluateRecall,
  evaluateSessionRecall,
  aggregateRecallScores,
} from "../../src/evaluate/recall";
import {
  scoreSession,
  parseRating,
  type Turn,
} from "../../src/capture/rating";
import { existsSync, readFileSync } from "fs";
import { resolveSignalDir, resolveSignalFile, loadConfig } from "../../src/adapters/paths";
import type { Rule } from "../../src/adapters/types";
import { Tier, SCHEMA_VERSION } from "../../src/adapters/types";

function makeRule(id: string, tags: string[]): Rule {
  return {
    id,
    text: `Rule ${id}`,
    tier: Tier.Global,
    tags,
    created: new Date().toISOString(),
    correlationScore: 0,
    sourceSignals: [],
    schemaVersion: SCHEMA_VERSION,
  };
}

describe("Tier 5: Evaluation", () => {
  // T25: Recall@5 on real gold set
  test("T25: recall@5 on constructed gold set scores > 0", () => {
    // Build a gold set from rules with known domains
    const availableRules = [
      makeRule("verify-facts", ["verification"]),
      makeRule("check-scope", ["scope", "verification"]),
      makeRule("deploy-safety", ["deployment"]),
      makeRule("test-first", ["verification"]),
      makeRule("escalation-rule", ["escalation"]),
    ];

    // Simulate retrieval: we inject 3 of the 4 verification rules
    const injectedRules = [
      availableRules[0], // verify-facts
      availableRules[1], // check-scope
      availableRules[3], // test-first
    ];

    const result = evaluateRecall(
      ["verification"],
      injectedRules,
      ["ship"],
      ["ship", "tdd"],
      availableRules,
    );

    // 3 of 3 verification rules were injected (check-scope also has verification)
    expect(result.ruleRecall).toBeGreaterThan(0);
    expect(result.totalExpectedRules).toBeGreaterThan(0);

    // Also verify recall@K math directly
    const goldIds = ["a", "b", "c"];
    const retrieved = ["x", "a", "y", "b", "z"];
    const r5 = recallAtK(goldIds, retrieved, 5);
    expect(r5).toBeGreaterThan(0);
    expect(r5).toBeCloseTo(2 / 3, 5);
  });

  // T26: Session scoring matches PAI algorithm
  test("T26: session scoring produces score within expected range for known transcript", () => {
    // Construct a transcript that mimics a real PAI session:
    // - some approvals, some corrections, a debrief at end
    const turns: Turn[] = [
      { role: "user", text: "Fix the login bug in auth.ts", charCount: 30 },
      { role: "assistant", text: "I'll look into the auth module and fix the login flow. Let me read the file first.", charCount: 300 },
      { role: "user", text: "yes perfect, that's the right approach", charCount: 40 },
      { role: "assistant", text: "Found the issue. The session token comparison was using == instead of ===. I've fixed it and added a regression test.", charCount: 400 },
      { role: "user", text: "great, looks good", charCount: 18 },
      { role: "assistant", text: "The test passes. Here's the summary of changes.", charCount: 200 },
      { role: "user", text: "no wait, that test doesn't cover the edge case", charCount: 50 },
      { role: "assistant", text: "Good catch. Let me add an edge case test for expired tokens.", charCount: 250 },
      { role: "user", text: "exactly, nice work", charCount: 20 },
      { role: "assistant", text: "Added the edge case test. All tests pass.", charCount: 150 },
      { role: "user", text: "/debrief", charCount: 8 },
      { role: "assistant", text: "Running session debrief...", charCount: 100 },
    ];

    const result = scoreSession(turns);

    // Expected: base 6.0 + approvals (~3 * 0.4 = 1.2, capped at 2.0)
    // - 1 correction (-0.5) + debrief bonus (+1.0)
    // Score should be around 7-9 range
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(10);
    expect(result.score).toBeGreaterThanOrEqual(1);

    // Verify the scoring algorithm identifies signal types correctly
    expect(result.approvals).toBeGreaterThanOrEqual(2);
    expect(result.corrections).toBeGreaterThanOrEqual(1);
    expect(result.summary).toContain("approval");
    expect(result.summary).toContain("correction");
    expect(result.summary).toContain("/debrief");

    // Score within 0.5 of expected PAI range (7.0-8.5 for this transcript)
    // PAI: base 6 + ~1.2 approval + 1.0 debrief - 0.5 correction = ~7.7
    expect(result.score).toBeGreaterThanOrEqual(6.5);
    expect(result.score).toBeLessThanOrEqual(9.5);
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  // T27: Score trend calculation — 7-day avg is a valid number
  test("T27: score trend calculation produces valid 7-day average", () => {
    const config = loadConfig();
    const signalDir = config.signalDir ?? resolveSignalDir();
    const ratingsPath = resolveSignalFile(signalDir, "ratings.jsonl");

    if (!existsSync(ratingsPath)) {
      console.log("  [skip] ratings.jsonl not found — no real data available");
      return;
    }

    const content = readFileSync(ratingsPath, "utf-8");
    const entries: { timestamp: string; rating: number }[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (typeof obj.rating === "number" && obj.timestamp) {
          entries.push({ timestamp: obj.timestamp, rating: obj.rating });
        }
      } catch { /* skip */ }
    }

    expect(entries.length).toBeGreaterThan(0);

    // Compute 7-day average the same way status.ts does
    const now = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const recent = entries.filter(
      (e) => now - new Date(e.timestamp).getTime() < sevenDays,
    );

    if (recent.length > 0) {
      const avg =
        recent.reduce((s, e) => s + e.rating, 0) / recent.length;
      expect(avg).toBeGreaterThan(0);
      expect(avg).toBeLessThanOrEqual(10);
      expect(Number.isFinite(avg)).toBe(true);
    }

    // Verify aggregateRecallScores produces valid structure
    const sessions = [
      evaluateSessionRecall("s1", "test session", ["a"], ["a", "b"]),
    ];
    const agg = aggregateRecallScores(sessions);
    expect(Number.isFinite(agg.meanRecall5)).toBe(true);
    expect(agg.sessionsEvaluated).toBe(1);
  });
});
