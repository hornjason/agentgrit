import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import {
  captureRuleSnapshot,
  getActiveRulesAtTurn,
} from "../../src/capture/rule-snapshots";
import type { RuleSnapshot } from "../../src/capture/rule-snapshots";

const TMP_DIR = join(import.meta.dir, ".tmp-snapshots-test");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

describe("captureRuleSnapshot", () => {
  test("captures and persists a rule snapshot", () => {
    captureRuleSnapshot({
      turn: 1,
      activeRules: ["rule-a", "rule-b"],
      timestamp: new Date().toISOString(),
      sessionId: "s1",
    });

    const rules = getActiveRulesAtTurn(1);
    expect(rules).toEqual(["rule-a", "rule-b"]);
  });

  test("captures multiple snapshots at different turns", () => {
    captureRuleSnapshot({
      turn: 1,
      activeRules: ["rule-a"],
      timestamp: new Date().toISOString(),
      sessionId: "s1",
    });
    captureRuleSnapshot({
      turn: 5,
      activeRules: ["rule-a", "rule-b", "rule-c"],
      timestamp: new Date().toISOString(),
      sessionId: "s1",
    });
    captureRuleSnapshot({
      turn: 10,
      activeRules: ["rule-b", "rule-c"],
      timestamp: new Date().toISOString(),
      sessionId: "s1",
    });

    expect(getActiveRulesAtTurn(1)).toEqual(["rule-a"]);
    expect(getActiveRulesAtTurn(5)).toEqual(["rule-a", "rule-b", "rule-c"]);
    expect(getActiveRulesAtTurn(10)).toEqual(["rule-b", "rule-c"]);
  });
});

describe("getActiveRulesAtTurn", () => {
  test("returns most recent snapshot at or before given turn (binary search)", () => {
    captureRuleSnapshot({ turn: 1, activeRules: ["r1"], timestamp: "2026-01-01T00:00:00Z", sessionId: "s1" });
    captureRuleSnapshot({ turn: 5, activeRules: ["r1", "r2"], timestamp: "2026-01-01T00:05:00Z", sessionId: "s1" });
    captureRuleSnapshot({ turn: 10, activeRules: ["r2", "r3"], timestamp: "2026-01-01T00:10:00Z", sessionId: "s1" });

    expect(getActiveRulesAtTurn(3)).toEqual(["r1"]);
    expect(getActiveRulesAtTurn(7)).toEqual(["r1", "r2"]);
    expect(getActiveRulesAtTurn(15)).toEqual(["r2", "r3"]);
  });

  test("returns empty array when no snapshots exist", () => {
    expect(getActiveRulesAtTurn(5)).toEqual([]);
  });

  test("returns empty array when turn is before first snapshot", () => {
    captureRuleSnapshot({ turn: 5, activeRules: ["r1"], timestamp: "2026-01-01T00:00:00Z", sessionId: "s1" });
    expect(getActiveRulesAtTurn(2)).toEqual([]);
  });

  test("returns exact match when turn equals snapshot turn", () => {
    captureRuleSnapshot({ turn: 3, activeRules: ["exact-match"], timestamp: "2026-01-01T00:00:00Z", sessionId: "s1" });
    expect(getActiveRulesAtTurn(3)).toEqual(["exact-match"]);
  });
});
