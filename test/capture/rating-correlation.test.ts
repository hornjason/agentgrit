import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { captureRating, readToolAuditForSession } from "../../src/capture/rating";
import { loadRuleStats, ruleStatsPath } from "../../src/promote/rules";

const TMP_DIR = join(import.meta.dir, ".tmp-rating-correlation-test");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

describe("captureRating → rule stats feedback loop", () => {
  test("updates rule-stats.json when ruleIds provided", async () => {
    const signal = await captureRating("/rate M:8 S:8 Q:8", "test-session", {
      ruleIds: ["rule-abc", "rule-def"],
    });
    expect(signal).not.toBeNull();

    const stateDir = join(TMP_DIR, "state");
    const statsMap = loadRuleStats(stateDir);
    expect(statsMap.size).toBe(2);

    const abc = statsMap.get("rule-abc");
    expect(abc).toBeDefined();
    expect(abc!.injectionCount).toBe(1);
    expect(abc!.avgCorrelatedRating).toBeGreaterThan(0);

    const def = statsMap.get("rule-def");
    expect(def).toBeDefined();
    expect(def!.injectionCount).toBe(1);
  });

  test("accumulates stats across multiple ratings", async () => {
    await captureRating("/rate M:9 S:9 Q:9", "sess-1", {
      ruleIds: ["rule-x"],
    });
    await captureRating("/rate M:3 S:3 Q:3", "sess-2", {
      ruleIds: ["rule-x"],
    });

    const stateDir = join(TMP_DIR, "state");
    const statsMap = loadRuleStats(stateDir);
    const x = statsMap.get("rule-x");
    expect(x).toBeDefined();
    expect(x!.injectionCount).toBe(2);
    expect(x!.sessionRatings).toHaveLength(2);
    expect(x!.highRatingActivations).toBe(1);
    expect(x!.lowRatingActivations).toBe(1);
  });

  test("does not write stats when ruleIds is empty", async () => {
    await captureRating("/rate M:8 S:8 Q:8", "test-session", {
      ruleIds: [],
    });

    const stateDir = join(TMP_DIR, "state");
    expect(existsSync(ruleStatsPath(stateDir))).toBe(false);
  });

  test("does not write stats when no ruleIds option", async () => {
    await captureRating("/rate M:8 S:8 Q:8", "test-session");

    const stateDir = join(TMP_DIR, "state");
    expect(existsSync(ruleStatsPath(stateDir))).toBe(false);
  });
});

describe("readToolAuditForSession", () => {
  const auditPath = join(TMP_DIR, "tool-audit.jsonl");

  test("returns tool names filtered by session timestamp", () => {
    const lines = [
      JSON.stringify({ ts: "2026-07-28T10:00:00Z", tool: "Bash", ok: true }),
      JSON.stringify({ ts: "2026-07-28T11:00:00Z", tool: "Read", ok: true }),
      JSON.stringify({ ts: "2026-07-28T12:00:00Z", tool: "Edit", ok: true }),
      JSON.stringify({ ts: "2026-07-28T12:05:00Z", tool: "Bash", ok: true }),
    ].join("\n");
    writeFileSync(auditPath, lines, "utf-8");

    const result = readToolAuditForSession("2026-07-28T11:00:00Z", auditPath);
    expect(result.toolNames).toContain("Read");
    expect(result.toolNames).toContain("Edit");
    expect(result.toolNames).toContain("Bash");
    expect(result.toolNames).not.toContain("Bash-duplicate");
    expect(result.toolNames.length).toBe(3);
  });

  test("excludes entries before session timestamp", () => {
    const lines = [
      JSON.stringify({ ts: "2026-07-28T08:00:00Z", tool: "OldTool", ok: true }),
      JSON.stringify({ ts: "2026-07-28T12:00:00Z", tool: "NewTool", ok: true }),
    ].join("\n");
    writeFileSync(auditPath, lines, "utf-8");

    const result = readToolAuditForSession("2026-07-28T10:00:00Z", auditPath);
    expect(result.toolNames).toEqual(["NewTool"]);
  });

  test("returns empty for missing file", () => {
    const result = readToolAuditForSession("2026-07-28T10:00:00Z", join(TMP_DIR, "nonexistent.jsonl"));
    expect(result.toolNames).toEqual([]);
  });

  test("skips malformed lines gracefully", () => {
    const lines = [
      "not json at all",
      JSON.stringify({ ts: "2026-07-28T12:00:00Z", tool: "Bash", ok: true }),
      "{broken",
    ].join("\n");
    writeFileSync(auditPath, lines, "utf-8");

    const result = readToolAuditForSession("2026-07-28T10:00:00Z", auditPath);
    expect(result.toolNames).toEqual(["Bash"]);
  });

  test("deduplicates tool names", () => {
    const lines = [
      JSON.stringify({ ts: "2026-07-28T12:00:00Z", tool: "Bash", ok: true }),
      JSON.stringify({ ts: "2026-07-28T12:01:00Z", tool: "Bash", ok: true }),
      JSON.stringify({ ts: "2026-07-28T12:02:00Z", tool: "Bash", ok: false }),
    ].join("\n");
    writeFileSync(auditPath, lines, "utf-8");

    const result = readToolAuditForSession("2026-07-28T10:00:00Z", auditPath);
    expect(result.toolNames).toEqual(["Bash"]);
  });
});
