import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { computeSkillMetrics } from "../../src/optimize/skill-metrics";

const TMP_DIR = join(import.meta.dir, ".tmp-skill-metrics-test");

function writeJsonl(filePath: string, entries: unknown[]): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(filePath, content, "utf8");
}

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

describe("computeSkillMetrics", () => {
  test("accuracy: correct primary skill detected", async () => {
    writeJsonl(join(TMP_DIR, "skill-sequences.jsonl"), [
      { session_id: "s1", timestamp: "2026-01-01T00:00:00Z", skill_name: "debugging-and-bug-fixes", args: "fix the broken thing", outcome: "ok", rating: 8 },
      { session_id: "s2", timestamp: "2026-01-01T01:00:00Z", skill_name: "testing-and-qa-validation", args: "test the feature", outcome: "ok", rating: 7 },
      { session_id: "s3", timestamp: "2026-01-01T02:00:00Z", skill_name: "debugging-and-bug-fixes", args: "research the api", outcome: "ok", rating: 6 },
    ]);

    const metrics = await computeSkillMetrics(TMP_DIR);

    expect(metrics.accuracy.totalSessions).toBe(3);
    expect(metrics.accuracy.detectableSessions).toBeGreaterThan(0);
    expect(metrics.accuracy.accuracy).toBeGreaterThanOrEqual(0);
    expect(metrics.accuracy.accuracy).toBeLessThanOrEqual(1);
  });

  test("conversion: suggestion matched to invocation", async () => {
    const now = Date.now();
    writeJsonl(join(TMP_DIR, "skill-router-suggestions.jsonl"), [
      { timestamp: new Date(now).toISOString(), session_id: "s1", prompt_snippet: "fix the bug", suggested_skills: ["debugging-and-bug-fixes"] },
      { timestamp: new Date(now + 1000).toISOString(), session_id: "s2", prompt_snippet: "<system-reminder>ignored", suggested_skills: ["ship"] },
    ]);
    writeJsonl(join(TMP_DIR, "skill-invocations.jsonl"), [
      { timestamp: new Date(now + 5000).toISOString(), session_id: "s1", skill: "debugging-and-bug-fixes", workflow: null },
    ]);

    const metrics = await computeSkillMetrics(TMP_DIR);

    expect(metrics.conversion.totalSuggestions).toBe(2);
    expect(metrics.conversion.matchedConversions).toBe(1);
    expect(metrics.conversion.falsePositiveCount).toBe(1);
    expect(metrics.conversion.perSkill["debugging-and-bug-fixes"].conversion).toBe(1);
  });

  test("cooccurrence: pairs counted symmetrically", async () => {
    writeJsonl(join(TMP_DIR, "skill-sequences.jsonl"), [
      { session_id: "s1", timestamp: "2026-01-01T00:00:00Z", skill_name: "ship", args: "", outcome: "ok", rating: null },
      { session_id: "s1", timestamp: "2026-01-01T00:01:00Z", skill_name: "tdd", args: "", outcome: "ok", rating: null },
      { session_id: "s2", timestamp: "2026-01-01T01:00:00Z", skill_name: "ship", args: "", outcome: "ok", rating: null },
      { session_id: "s2", timestamp: "2026-01-01T01:01:00Z", skill_name: "tdd", args: "", outcome: "ok", rating: null },
      { session_id: "s3", timestamp: "2026-01-01T02:00:00Z", skill_name: "research", args: "", outcome: "ok", rating: null },
    ]);

    const metrics = await computeSkillMetrics(TMP_DIR);

    expect(metrics.cooccurrence["ship"]["tdd"]).toBe(2);
    expect(metrics.cooccurrence["tdd"]["ship"]).toBe(2);
    expect(metrics.cooccurrence["research"]).toBeDefined();
    expect(Object.keys(metrics.cooccurrence["research"]).length).toBe(0);
  });

  test("usage: invocations correlated with ratings", async () => {
    writeJsonl(join(TMP_DIR, "skill-invocations.jsonl"), [
      { timestamp: "2026-01-01T00:00:00Z", session_id: "s1", skill: "ship", workflow: null },
      { timestamp: "2026-01-01T01:00:00Z", session_id: "s2", skill: "ship", workflow: null },
      { timestamp: "2026-01-01T02:00:00Z", session_id: "s3", skill: "tdd", workflow: null },
    ]);
    writeJsonl(join(TMP_DIR, "ratings.jsonl"), [
      { timestamp: "2026-01-01T00:30:00Z", session_id: "s1", rating: 9 },
      { timestamp: "2026-01-01T01:30:00Z", session_id: "s2", rating: 7 },
      { timestamp: "2026-01-01T02:30:00Z", session_id: "s3", rating: 6 },
      { timestamp: "2026-01-01T03:30:00Z", session_id: "s4", rating: 5 },
    ]);

    const metrics = await computeSkillMetrics(TMP_DIR);

    const shipUsage = metrics.usage.find((u) => u.skill === "ship");
    expect(shipUsage).toBeDefined();
    expect(shipUsage!.totalInvocations).toBe(2);
    expect(shipUsage!.uniqueSessions).toBe(2);
    expect(shipUsage!.avgRating).toBe(8);
    expect(shipUsage!.impactDelta).toBeGreaterThan(0);
  });

  test("empty signal dir produces zero-value metrics", async () => {
    const metrics = await computeSkillMetrics(TMP_DIR);

    expect(metrics.accuracy.totalSessions).toBe(0);
    expect(metrics.conversion.totalSuggestions).toBe(0);
    expect(Object.keys(metrics.cooccurrence).length).toBe(0);
    expect(metrics.usage.length).toBe(0);
    expect(metrics.generatedAt).toBeDefined();
  });

  test("false positives excluded from conversion denominator", async () => {
    const now = Date.now();
    writeJsonl(join(TMP_DIR, "skill-router-suggestions.jsonl"), [
      { timestamp: new Date(now).toISOString(), session_id: "s1", prompt_snippet: "<task-notification>check", suggested_skills: ["ship"] },
      { timestamp: new Date(now).toISOString(), session_id: "s2", prompt_snippet: "<system-reminder>hook", suggested_skills: ["ship"] },
    ]);

    const metrics = await computeSkillMetrics(TMP_DIR);

    expect(metrics.conversion.falsePositiveCount).toBe(2);
    expect(metrics.conversion.falsePositiveRate).toBe(1);
    expect(metrics.conversion.matchedConversions).toBe(0);
  });
});
