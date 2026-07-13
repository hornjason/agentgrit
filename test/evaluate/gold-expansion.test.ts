import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const goldPath = join(homedir(), ".claude", "MEMORY", "LEARNING", "STATE", "graph-gold.json");

interface RawGoldSession {
  session_id?: string;
  sessionId?: string;
  task_context?: string;
  description?: string;
  domains?: string[];
  relevant_rules?: string[];
  relevantRules?: string[];
  excluded_rules?: string[];
  [key: string]: unknown;
}

function getRules(s: RawGoldSession): string[] {
  return s.relevant_rules ?? s.relevantRules ?? [];
}

describe("gold set expansion", () => {
  const raw = JSON.parse(readFileSync(goldPath, "utf-8"));
  const sessions = Object.values(raw.labeled) as RawGoldSession[];

  test("has >= 60 sessions with task_context", () => {
    const withContext = sessions.filter(s => s.task_context && s.task_context.length > 0);
    expect(withContext.length).toBeGreaterThanOrEqual(60);
  });

  test("has >= 10 negative sessions with excluded_rules", () => {
    const negative = sessions.filter(s => s.excluded_rules && s.excluded_rules.length > 0);
    expect(negative.length).toBeGreaterThanOrEqual(10);
  });

  test("every negative session has >= 1 excluded rule ID", () => {
    const negative = sessions.filter(s => s.excluded_rules && s.excluded_rules.length > 0);
    for (const s of negative) {
      expect(s.excluded_rules!.length).toBeGreaterThanOrEqual(1);
    }
  });

  test("every session has relevant rules", () => {
    for (const s of sessions) {
      const rules = getRules(s);
      expect(rules.length).toBeGreaterThan(0);
    }
  });

  test("excluded_rules do not overlap with relevant rules", () => {
    for (const s of sessions) {
      if (!s.excluded_rules) continue;
      const relevant = new Set(getRules(s));
      for (const ex of s.excluded_rules) {
        expect(relevant.has(ex)).toBe(false);
      }
    }
  });
});
