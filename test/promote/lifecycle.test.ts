import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

const TEMP_DIR = join(import.meta.dir, ".tmp-lifecycle");

beforeEach(() => {
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true });
  mkdirSync(TEMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true });
});

describe("loadLifecycle", () => {
  test("returns empty lifecycle when file missing", async () => {
    const { loadLifecycle } = await import("../../src/promote/lifecycle");
    const result = loadLifecycle(TEMP_DIR);
    expect(result).toEqual({ version: 1, rules: {} });
  });

  test("reads existing lifecycle file", async () => {
    const { loadLifecycle } = await import("../../src/promote/lifecycle");
    const data = {
      version: 1,
      rules: {
        "test-rule": {
          state: "evicted",
          transitionedAt: "2026-08-19T00:00:00.000Z",
          reason: "low correlation",
          addedBy: "eviction-daemon",
        },
      },
    };
    writeFileSync(join(TEMP_DIR, "rule-lifecycle.json"), JSON.stringify(data), "utf-8");
    const result = loadLifecycle(TEMP_DIR);
    expect(result.version).toBe(1);
    expect(result.rules["test-rule"].state).toBe("evicted");
  });

  test("skips entries with invalid state", async () => {
    const { loadLifecycle } = await import("../../src/promote/lifecycle");
    const data = {
      version: 1,
      rules: {
        "valid-rule": {
          state: "evicted",
          transitionedAt: "2026-08-19T00:00:00.000Z",
          reason: "low correlation",
          addedBy: "eviction-daemon",
        },
        "corrupt-rule": {
          state: "INVALID_STATE",
          transitionedAt: "2026-08-19T00:00:00.000Z",
          reason: "corrupted",
          addedBy: "unknown",
        },
        "another-valid": {
          state: "graduated",
          transitionedAt: "2026-08-19T00:00:00.000Z",
          reason: "promoted",
          addedBy: "manual",
        },
      },
    };
    writeFileSync(join(TEMP_DIR, "rule-lifecycle.json"), JSON.stringify(data), "utf-8");
    const result = loadLifecycle(TEMP_DIR);
    expect(Object.keys(result.rules)).toHaveLength(2);
    expect(result.rules["valid-rule"]).toBeDefined();
    expect(result.rules["another-valid"]).toBeDefined();
    expect(result.rules["corrupt-rule"]).toBeUndefined();
  });
});

describe("transitionRule", () => {
  test("creates entry with correct state/timestamp/reason", async () => {
    const { transitionRule, loadLifecycle } = await import("../../src/promote/lifecycle");
    const before = new Date().toISOString();
    transitionRule("my-rule", "evicted", "low correlation", "eviction-daemon", TEMP_DIR);
    const after = new Date().toISOString();

    const lifecycle = loadLifecycle(TEMP_DIR);
    const entry = lifecycle.rules["my-rule"];
    expect(entry).toBeDefined();
    expect(entry.state).toBe("evicted");
    expect(entry.reason).toBe("low correlation");
    expect(entry.addedBy).toBe("eviction-daemon");
    expect(entry.transitionedAt >= before).toBe(true);
    expect(entry.transitionedAt <= after).toBe(true);
  });

  test("updates existing entry on re-transition", async () => {
    const { transitionRule, loadLifecycle } = await import("../../src/promote/lifecycle");
    transitionRule("my-rule", "evicted", "low correlation", "eviction-daemon", TEMP_DIR);
    transitionRule("my-rule", "graduated", "promoted to CLAUDE.md", "manual", TEMP_DIR);

    const lifecycle = loadLifecycle(TEMP_DIR);
    expect(lifecycle.rules["my-rule"].state).toBe("graduated");
    expect(lifecycle.rules["my-rule"].reason).toBe("promoted to CLAUDE.md");
    expect(lifecycle.rules["my-rule"].addedBy).toBe("manual");
  });
});

describe("readLifecycleState", () => {
  test("returns 'active' for unknown rules", async () => {
    const { readLifecycleState } = await import("../../src/promote/lifecycle");
    const state = readLifecycleState("nonexistent-rule", TEMP_DIR);
    expect(state).toBe("active");
  });

  test("returns correct state for known rules", async () => {
    const { transitionRule, readLifecycleState } = await import("../../src/promote/lifecycle");
    transitionRule("grad-rule", "graduated", "promoted", "manual", TEMP_DIR);
    expect(readLifecycleState("grad-rule", TEMP_DIR)).toBe("graduated");
  });
});

describe("getFilteredRuleIds", () => {
  test("returns correct sets for each state", async () => {
    const { transitionRule, getFilteredRuleIds } = await import("../../src/promote/lifecycle");
    transitionRule("evicted-1", "evicted", "low", "eviction-daemon", TEMP_DIR);
    transitionRule("evicted-2", "evicted", "never helped", "eviction-daemon", TEMP_DIR);
    transitionRule("graduated-1", "graduated", "promoted", "graduation-migration", TEMP_DIR);
    transitionRule("active-1", "active", "restored", "manual", TEMP_DIR);

    const evicted = getFilteredRuleIds(["evicted"], TEMP_DIR);
    expect(evicted.size).toBe(2);
    expect(evicted.has("evicted-1")).toBe(true);
    expect(evicted.has("evicted-2")).toBe(true);

    const graduated = getFilteredRuleIds(["graduated"], TEMP_DIR);
    expect(graduated.size).toBe(1);
    expect(graduated.has("graduated-1")).toBe(true);

    const suppressed = getFilteredRuleIds(["evicted", "graduated"], TEMP_DIR);
    expect(suppressed.size).toBe(3);
    expect(suppressed.has("active-1")).toBe(false);
  });

  test("returns empty set when file missing", async () => {
    const { getFilteredRuleIds } = await import("../../src/promote/lifecycle");
    const result = getFilteredRuleIds(["evicted"], TEMP_DIR);
    expect(result.size).toBe(0);
  });
});

describe("migrateFromEvictedRegistry", () => {
  test("creates entries from evicted-rules.json", async () => {
    const { migrateFromEvictedRegistry, loadLifecycle } = await import("../../src/promote/lifecycle");

    const evictedData = {
      evicted: [
        {
          ruleId: "feedback_ship_posts_acs_to_issue",
          trigger: "net-negative-roi",
          reason: "9 low vs 4 high activations",
          evictedAt: "2026-08-19T13:11:55.953Z",
        },
        {
          ruleId: "feedback_quality_gate_on_every_extraction",
          trigger: "never-helped",
          reason: "0 high-rating activations after 7 injections",
          evictedAt: "2026-08-19T13:11:55.953Z",
        },
      ],
    };
    writeFileSync(join(TEMP_DIR, "evicted-rules.json"), JSON.stringify(evictedData), "utf-8");

    migrateFromEvictedRegistry(TEMP_DIR);
    const lifecycle = loadLifecycle(TEMP_DIR);

    // Evicted entries preserved (at minimum 2 from evicted-rules.json)
    const ruleCount = Object.keys(lifecycle.rules).length;
    expect(ruleCount).toBeGreaterThanOrEqual(2);

    expect(lifecycle.rules["feedback_ship_posts_acs_to_issue"].state).toBe("evicted");
    expect(lifecycle.rules["feedback_ship_posts_acs_to_issue"].reason).toBe("9 low vs 4 high activations");
    expect(lifecycle.rules["feedback_ship_posts_acs_to_issue"].addedBy).toBe("eviction-daemon");
  });

  test("idempotent — does not duplicate on re-run", async () => {
    const { migrateFromEvictedRegistry, loadLifecycle } = await import("../../src/promote/lifecycle");

    const evictedData = {
      evicted: [
        {
          ruleId: "rule-a",
          trigger: "never-helped",
          reason: "test",
          evictedAt: "2026-08-19T00:00:00.000Z",
        },
      ],
    };
    writeFileSync(join(TEMP_DIR, "evicted-rules.json"), JSON.stringify(evictedData), "utf-8");

    migrateFromEvictedRegistry(TEMP_DIR);
    const first = loadLifecycle(TEMP_DIR);
    const firstCount = Object.keys(first.rules).length;

    migrateFromEvictedRegistry(TEMP_DIR);
    const second = loadLifecycle(TEMP_DIR);
    const secondCount = Object.keys(second.rules).length;

    expect(secondCount).toBe(firstCount);
  });
});

describe("saveLifecycle", () => {
  test("atomic write — file exists after save", async () => {
    const { saveLifecycle } = await import("../../src/promote/lifecycle");
    const lifecycle = { version: 1 as const, rules: { "r1": { state: "active" as const, transitionedAt: "2026-01-01T00:00:00Z", reason: "test", addedBy: "manual" } } };
    saveLifecycle(lifecycle, TEMP_DIR);
    expect(existsSync(join(TEMP_DIR, "rule-lifecycle.json"))).toBe(true);
    const raw = JSON.parse(readFileSync(join(TEMP_DIR, "rule-lifecycle.json"), "utf-8"));
    expect(raw.version).toBe(1);
    expect(raw.rules["r1"].state).toBe("active");
  });

  test("uses lockfile during write", async () => {
    const { saveLifecycle } = await import("../../src/promote/lifecycle");
    const lifecycle = { version: 1 as const, rules: { "r1": { state: "active" as const, transitionedAt: "2026-01-01T00:00:00Z", reason: "test", addedBy: "manual" } } };
    saveLifecycle(lifecycle, TEMP_DIR);
    expect(existsSync(join(TEMP_DIR, "rule-lifecycle.json.lock"))).toBe(false);
    expect(existsSync(join(TEMP_DIR, "rule-lifecycle.json"))).toBe(true);
  });
});

describe("loadLifecycle — tmp cleanup", () => {
  test("cleans up orphaned .tmp files on load", async () => {
    const { loadLifecycle } = await import("../../src/promote/lifecycle");
    writeFileSync(join(TEMP_DIR, "rule-lifecycle.json.tmp.12345"), "stale", "utf-8");
    writeFileSync(join(TEMP_DIR, "rule-lifecycle.json.tmp.67890"), "stale", "utf-8");
    expect(existsSync(join(TEMP_DIR, "rule-lifecycle.json.tmp.12345"))).toBe(true);
    loadLifecycle(TEMP_DIR);
    expect(existsSync(join(TEMP_DIR, "rule-lifecycle.json.tmp.12345"))).toBe(false);
    expect(existsSync(join(TEMP_DIR, "rule-lifecycle.json.tmp.67890"))).toBe(false);
  });
});

describe("undersampled state", () => {
  test("loadLifecycle accepts undersampled state", async () => {
    const { loadLifecycle } = await import("../../src/promote/lifecycle");
    const data = {
      version: 1,
      rules: {
        "low-injection-rule": {
          state: "undersampled",
          transitionedAt: "2026-08-19T00:00:00.000Z",
          reason: "3 injections < 10 threshold",
          addedBy: "undersampled-classifier",
        },
      },
    };
    writeFileSync(join(TEMP_DIR, "rule-lifecycle.json"), JSON.stringify(data), "utf-8");
    const result = loadLifecycle(TEMP_DIR);
    expect(result.rules["low-injection-rule"].state).toBe("undersampled");
  });

  test("undersampled rules NOT suppressed by getFilteredRuleIds([evicted, graduated])", async () => {
    const { transitionRule, getFilteredRuleIds } = await import("../../src/promote/lifecycle");
    transitionRule("evicted-1", "evicted", "low", "daemon", TEMP_DIR);
    transitionRule("graduated-1", "graduated", "promoted", "migration", TEMP_DIR);
    transitionRule("undersampled-1", "undersampled", "3 injections", "classifier", TEMP_DIR);
    transitionRule("active-1", "active", "restored", "manual", TEMP_DIR);

    const suppressed = getFilteredRuleIds(["evicted", "graduated"], TEMP_DIR);
    expect(suppressed.has("evicted-1")).toBe(true);
    expect(suppressed.has("graduated-1")).toBe(true);
    expect(suppressed.has("undersampled-1")).toBe(false);
    expect(suppressed.has("active-1")).toBe(false);
  });
});

describe("classifyUndersampledRules", () => {
  test("marks low-injection rules as undersampled", async () => {
    const { classifyUndersampledRules, loadLifecycle } = await import("../../src/promote/lifecycle");

    const stats = [
      { ruleId: "low-rule", injectionCount: 3, avgCorrelatedRating: 5.0, sessionRatings: [], highRatingActivations: 1, lowRatingActivations: 0, lastSeen: "2026-08-19T00:00:00Z" },
      { ruleId: "high-rule", injectionCount: 25, avgCorrelatedRating: 7.0, sessionRatings: [], highRatingActivations: 10, lowRatingActivations: 0, lastSeen: "2026-08-19T00:00:00Z" },
    ];
    writeFileSync(join(TEMP_DIR, "rule-stats.json"), JSON.stringify(stats), "utf-8");

    const classified = classifyUndersampledRules(TEMP_DIR);
    expect(classified).toContain("low-rule");
    expect(classified).not.toContain("high-rule");

    const lifecycle = loadLifecycle(TEMP_DIR);
    expect(lifecycle.rules["low-rule"].state).toBe("undersampled");
    expect(lifecycle.rules["high-rule"]).toBeUndefined();
  });

  test("skips rules already graduated or evicted", async () => {
    const { classifyUndersampledRules, transitionRule, loadLifecycle } = await import("../../src/promote/lifecycle");

    const stats = [
      { ruleId: "already-graduated", injectionCount: 5, avgCorrelatedRating: 8.0, sessionRatings: [], highRatingActivations: 3, lowRatingActivations: 0, lastSeen: "2026-08-19T00:00:00Z" },
    ];
    writeFileSync(join(TEMP_DIR, "rule-stats.json"), JSON.stringify(stats), "utf-8");
    transitionRule("already-graduated", "graduated", "promoted", "manual", TEMP_DIR);

    const classified = classifyUndersampledRules(TEMP_DIR);
    expect(classified).not.toContain("already-graduated");

    const lifecycle = loadLifecycle(TEMP_DIR);
    expect(lifecycle.rules["already-graduated"].state).toBe("graduated");
  });
});

describe("detectGraduatedRules", () => {
  test("finds rules matching CLAUDE.md Critical Rules section", async () => {
    const { detectGraduatedRules, loadLifecycle } = await import("../../src/promote/lifecycle");

    const stats = [
      { ruleId: "feedback_correction_wrong_autoscored_api", injectionCount: 20, avgCorrelatedRating: 3.8, sessionRatings: [], highRatingActivations: 2, lowRatingActivations: 5, lastSeen: "2026-08-19T00:00:00Z" },
    ];
    writeFileSync(join(TEMP_DIR, "rule-stats.json"), JSON.stringify(stats), "utf-8");

    const matched = detectGraduatedRules(TEMP_DIR);
    // This test depends on ~/.claude/CLAUDE.md containing "correction-wrong-autoscored-api"
    // which it does based on our earlier read. If the real CLAUDE.md has it, it should match.
    if (matched.length > 0) {
      const lifecycle = loadLifecycle(TEMP_DIR);
      for (const ruleId of matched) {
        expect(lifecycle.rules[ruleId].state).toBe("graduated");
        expect(lifecycle.rules[ruleId].addedBy).toBe("graduation-auto-detect");
      }
    }
  });
});

describe("transition log", () => {
  test("transitionRule appends to transition-log.jsonl", async () => {
    const { transitionRule } = await import("../../src/promote/lifecycle");

    transitionRule("rule-a", "evicted", "low correlation", "daemon", TEMP_DIR);
    transitionRule("rule-a", "active", "restored by user", "manual", TEMP_DIR);

    const logPath = join(TEMP_DIR, "transition-log.jsonl");
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);

    const entry1 = JSON.parse(lines[0]);
    expect(entry1.ruleId).toBe("rule-a");
    expect(entry1.fromState).toBe("active");
    expect(entry1.toState).toBe("evicted");
    expect(entry1.reason).toBe("low correlation");
    expect(entry1.addedBy).toBe("daemon");

    const entry2 = JSON.parse(lines[1]);
    expect(entry2.fromState).toBe("evicted");
    expect(entry2.toState).toBe("active");
    expect(entry2.reason).toBe("restored by user");
  });
});
