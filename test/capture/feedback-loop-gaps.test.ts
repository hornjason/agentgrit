/**
 * Tests for #163 feedback loop gaps — AC-4 through AC-8
 *
 * Track A: processUnattributedRatings (AC-4, AC-5)
 * Track B: session context enrichment (AC-6, AC-7)
 * Track C: decay observability (AC-8)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";

const TMP_DIR = join(import.meta.dir, ".tmp-feedback-loop-gaps-test");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(join(TMP_DIR, "signals"), { recursive: true });
  mkdirSync(join(TMP_DIR, "state"), { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

// ── Track A: processUnattributedRatings (AC-4) ──

describe("processUnattributedRatings", () => {
  test("processes unattributed ratings from JSONL and updates cursor", async () => {
    const { processUnattributedRatings } = await import("../../src/capture/rating");
    const { loadRuleStats, persistRuleStats } = await import("../../src/promote/rules");

    const ratingsPath = join(TMP_DIR, "signals", "ratings.jsonl");
    const cursorPath = join(TMP_DIR, "state", "attribution-cursor.json");

    // Write ratings with rule_ids
    const ts1 = "2026-08-01T10:00:00Z";
    const ts2 = "2026-08-01T11:00:00Z";
    writeFileSync(ratingsPath, [
      JSON.stringify({ timestamp: ts1, rating: 8, rule_ids: ["rule-a"] }),
      JSON.stringify({ timestamp: ts2, rating: 6, rule_ids: ["rule-b"] }),
    ].join("\n") + "\n");

    await processUnattributedRatings(ratingsPath, cursorPath);

    // Cursor should be updated to last timestamp
    const cursor = JSON.parse(readFileSync(cursorPath, "utf-8"));
    expect(cursor.lastTimestamp).toBe(ts2);

    // Stats should exist for both rules
    const stats = loadRuleStats();
    expect(stats.has("rule-a")).toBe(true);
    expect(stats.has("rule-b")).toBe(true);
  });

  test("respects existing cursor position", async () => {
    const { processUnattributedRatings } = await import("../../src/capture/rating");
    const { loadRuleStats } = await import("../../src/promote/rules");

    const ratingsPath = join(TMP_DIR, "signals", "ratings.jsonl");
    const cursorPath = join(TMP_DIR, "state", "attribution-cursor.json");

    const ts1 = "2026-08-01T10:00:00Z";
    const ts2 = "2026-08-01T11:00:00Z";
    writeFileSync(ratingsPath, [
      JSON.stringify({ timestamp: ts1, rating: 8, rule_ids: ["rule-old"] }),
      JSON.stringify({ timestamp: ts2, rating: 7, rule_ids: ["rule-new"] }),
    ].join("\n") + "\n");

    // Set cursor past first entry
    writeFileSync(cursorPath, JSON.stringify({ lastTimestamp: ts1 }));

    await processUnattributedRatings(ratingsPath, cursorPath);

    // Only rule-new should be tracked (rule-old was already processed)
    const stats = loadRuleStats();
    expect(stats.has("rule-new")).toBe(true);
    // rule-old should NOT be in stats since it was before cursor
    expect(stats.has("rule-old")).toBe(false);
  });

  test("skips entries without rule_ids", async () => {
    const { processUnattributedRatings } = await import("../../src/capture/rating");
    const { loadRuleStats } = await import("../../src/promote/rules");

    const ratingsPath = join(TMP_DIR, "signals", "ratings.jsonl");
    const cursorPath = join(TMP_DIR, "state", "attribution-cursor.json");

    writeFileSync(ratingsPath, [
      JSON.stringify({ timestamp: "2026-08-01T10:00:00Z", rating: 8 }),
      JSON.stringify({ timestamp: "2026-08-01T11:00:00Z", rating: 6, rule_ids: [] }),
    ].join("\n") + "\n");

    await processUnattributedRatings(ratingsPath, cursorPath);

    const stats = loadRuleStats();
    expect(stats.size).toBe(0);
  });

  test("handles missing ratings file gracefully", async () => {
    const { processUnattributedRatings } = await import("../../src/capture/rating");

    const ratingsPath = join(TMP_DIR, "signals", "nonexistent.jsonl");
    const cursorPath = join(TMP_DIR, "state", "attribution-cursor.json");

    // Should not throw
    await processUnattributedRatings(ratingsPath, cursorPath);
  });
});

// ── Track B: tool-audit filePath (AC-7) ──

describe("buildMinimalAudit with filePath", () => {
  test("includes filePath when provided", async () => {
    const { buildMinimalAudit } = await import("../../src/capture/tool-audit");

    const audit = buildMinimalAudit("Read", false, "/src/index.ts");
    expect(audit.filePath).toBe("/src/index.ts");
  });

  test("omits filePath when not provided", async () => {
    const { buildMinimalAudit } = await import("../../src/capture/tool-audit");

    const audit = buildMinimalAudit("Bash", false);
    expect(audit.filePath).toBeUndefined();
  });
});

// ── Track C: Decay observability (AC-8) ──

describe("trackRule decay observability", () => {
  test("stores both rawAvgRating and decayedRating", async () => {
    const { trackRule } = await import("../../src/promote/rules");
    const { Tier, SCHEMA_VERSION } = await import("../../src/adapters/types");

    const rule = {
      id: "r1",
      text: "test rule",
      tier: Tier.Global,
      tags: [],
      created: "2024-01-01T00:00:00Z",
      correlationScore: 0,
      sourceSignals: [],
      schemaVersion: SCHEMA_VERSION,
      sessionRatings: [6, 8, 4],
    };

    const updated = trackRule(rule, 10);

    // rawAvgRating should be simple average: (6+8+4+10)/4 = 7
    expect(updated.rawAvgRating).toBeCloseTo(7, 1);

    // decayedRating should differ from raw because it applies exponential decay
    expect(updated.decayedRating).toBeDefined();
    expect(typeof updated.decayedRating).toBe("number");

    // decayedRating should favor recent (10) more than raw average
    expect(updated.decayedRating!).toBeGreaterThan(updated.rawAvgRating!);
  });

  test("rawAvgRating is simple arithmetic mean", async () => {
    const { trackRule } = await import("../../src/promote/rules");
    const { Tier, SCHEMA_VERSION } = await import("../../src/adapters/types");

    const rule = {
      id: "r1",
      text: "test rule",
      tier: Tier.Global,
      tags: [],
      created: "2024-01-01T00:00:00Z",
      correlationScore: 0,
      sourceSignals: [],
      schemaVersion: SCHEMA_VERSION,
      sessionRatings: [5, 5, 5, 5],
    };

    const updated = trackRule(rule, 5);

    // All 5s, simple avg = 5
    expect(updated.rawAvgRating).toBeCloseTo(5, 5);
    // Decayed average of equal values also equals that value
    expect(updated.decayedRating).toBeCloseTo(5, 1);
  });

  test("correlateRules preserves rawAvgRating and decayedRating", async () => {
    const { correlateRules } = await import("../../src/promote/rules");
    const { Tier, SCHEMA_VERSION } = await import("../../src/adapters/types");

    const rules = [{
      id: "r1",
      text: "test",
      tier: Tier.Global,
      tags: [],
      created: "",
      correlationScore: 0,
      sourceSignals: [],
      schemaVersion: SCHEMA_VERSION,
      rawAvgRating: 6.5,
      decayedRating: 7.2,
      injectionCount: 3,
      avgCorrelatedRating: 7.2,
      sessionRatings: [6, 7, 8],
    }];

    const stats = correlateRules(rules);
    expect(stats[0].rawAvgRating).toBe(6.5);
    expect(stats[0].decayedRating).toBe(7.2);
  });

  test("persistRuleStats writes rawAvgRating and decayedRating to file", async () => {
    const { persistRuleStats, loadRuleStats } = await import("../../src/promote/rules");

    persistRuleStats([{
      ruleId: "r1",
      injectionCount: 5,
      avgCorrelatedRating: 7.0,
      sessionRatings: [6, 7, 8],
      highRatingActivations: 2,
      lowRatingActivations: 0,
      lastSeen: "2026-08-01",
      rawAvgRating: 7.0,
      decayedRating: 7.5,
    }]);

    const stats = loadRuleStats();
    const r1 = stats.get("r1");
    expect(r1?.rawAvgRating).toBe(7.0);
    expect(r1?.decayedRating).toBe(7.5);
  });
});
