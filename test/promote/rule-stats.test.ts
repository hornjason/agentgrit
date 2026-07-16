import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  persistRuleStats,
  loadRuleStats,
  ruleStatsPath,
  bootstrapRuleStats,
  type RuleStats,
} from "../../src/promote/rules";

const TMP_DIR = join(import.meta.dir, ".tmp-rule-stats-test");
const STATE_DIR = join(TMP_DIR, "state");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

describe("persistRuleStats + loadRuleStats", () => {
  test("round-trips stats through file", () => {
    const stats: RuleStats[] = [
      {
        ruleId: "rule-1",
        injectionCount: 5,
        avgCorrelatedRating: 7.2,
        sessionRatings: [7, 8, 6, 7, 8],
        highRatingActivations: 3,
        lowRatingActivations: 0,
        lastSeen: "2026-07-01T00:00:00Z",
      },
      {
        ruleId: "rule-2",
        injectionCount: 3,
        avgCorrelatedRating: 4.0,
        sessionRatings: [3, 5, 4],
        highRatingActivations: 0,
        lowRatingActivations: 1,
        lastSeen: "2026-07-02T00:00:00Z",
      },
    ];

    persistRuleStats(stats, STATE_DIR);

    const filePath = ruleStatsPath(STATE_DIR);
    expect(existsSync(filePath)).toBe(true);

    const loaded = loadRuleStats(STATE_DIR);
    expect(loaded.size).toBe(2);
    expect(loaded.get("rule-1")!.avgCorrelatedRating).toBe(7.2);
    expect(loaded.get("rule-2")!.injectionCount).toBe(3);
  });

  test("loadRuleStats returns empty map when file does not exist", () => {
    const loaded = loadRuleStats(join(TMP_DIR, "nonexistent"));
    expect(loaded.size).toBe(0);
  });

  test("loadRuleStats handles corrupt file", () => {
    const filePath = ruleStatsPath(STATE_DIR);
    const { writeFileSync: wfs } = require("fs");
    wfs(filePath, "NOT JSON", "utf-8");
    const loaded = loadRuleStats(STATE_DIR);
    expect(loaded.size).toBe(0);
  });

  test("persistRuleStats creates parent directories", () => {
    const deepDir = join(TMP_DIR, "a", "b", "c");
    const stats: RuleStats[] = [
      {
        ruleId: "r1",
        injectionCount: 1,
        avgCorrelatedRating: 5,
        sessionRatings: [5],
        highRatingActivations: 0,
        lowRatingActivations: 0,
        lastSeen: "",
      },
    ];
    persistRuleStats(stats, deepDir);
    expect(existsSync(ruleStatsPath(deepDir))).toBe(true);
  });
});

describe("bootstrapRuleStats skips legacy IDs", () => {
  test("skips ratings where all rule_ids start with rule-", () => {
    const { writeFileSync: wfs } = require("fs");
    const sessionHistoryPath = join(TMP_DIR, "session-history.jsonl");
    const ratingsPath = join(TMP_DIR, "ratings.jsonl");

    // Ratings with legacy IDs should be skipped
    const ratings = [
      JSON.stringify({ timestamp: "2026-07-01T10:00:00Z", rating: 5, rule_ids: ["rule-abc12", "rule-def34"] }),
      JSON.stringify({ timestamp: "2026-07-01T11:00:00Z", rating: 7, rule_ids: ["feedback_real_rule"] }),
    ];
    wfs(ratingsPath, ratings.join("\n"), "utf-8");

    // Empty session history
    wfs(sessionHistoryPath, "", "utf-8");

    const result = bootstrapRuleStats(sessionHistoryPath, ratingsPath, STATE_DIR);

    const loaded = loadRuleStats(STATE_DIR);
    expect(loaded.has("rule-abc12")).toBe(false);
    expect(loaded.has("rule-def34")).toBe(false);
    expect(loaded.has("feedback_real_rule")).toBe(true);
    expect(result.ratingsMatched).toBe(1);
  });

  test("keeps ratings with mix of legacy and real IDs", () => {
    const { writeFileSync: wfs } = require("fs");
    const sessionHistoryPath = join(TMP_DIR, "session-history.jsonl");
    const ratingsPath = join(TMP_DIR, "ratings.jsonl");

    const ratings = [
      JSON.stringify({ timestamp: "2026-07-01T10:00:00Z", rating: 6, rule_ids: ["rule-abc12", "feedback_real"] }),
    ];
    wfs(ratingsPath, ratings.join("\n"), "utf-8");
    wfs(sessionHistoryPath, "", "utf-8");

    bootstrapRuleStats(sessionHistoryPath, ratingsPath, STATE_DIR);

    const loaded = loadRuleStats(STATE_DIR);
    // Mixed entries are kept — both IDs get stats
    expect(loaded.has("rule-abc12")).toBe(true);
    expect(loaded.has("feedback_real")).toBe(true);
  });
});
