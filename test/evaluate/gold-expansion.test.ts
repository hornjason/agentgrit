import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const goldPath = join(homedir(), ".claude", "MEMORY", "LEARNING", "STATE", "graph-gold.json");

// The gold set is hand-labeled operator state under $HOME holding real session
// summaries, so it is not a repo fixture and cannot become one. A machine
// without it has not PASSED these five checks, it has not RUN them — and the
// two are only distinguishable if someone says so.
//
// Read at module scope, the absence is an ENOENT thrown out of the describe
// body. bun reports that as `1 error` beside `0 fail` and exits 1, so the
// suite summary names no failing test and anything counting `(fail)` lines
// reads the run as clean. That is what took CI red on #249 with 1847 passing.
const goldAvailable = existsSync(goldPath);

if (!goldAvailable) {
  console.warn(
    `UNMEASURED: gold set expansion did not run. ${goldPath} does not exist, ` +
      `so all 5 of its checks were skipped. This is not a pass.`,
  );
}

interface RawGoldSession {
  session_id?: string;
  sessionId?: string;
  task_context?: string;
  sentiment_summary?: string;
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

describe.skipIf(!goldAvailable)("gold set expansion", () => {
  // Guarded independently of skipIf: a describe body may be evaluated during
  // collection even when its tests are skipped, and the point of this change
  // is that an absent gold set must not throw. With no file the list is empty,
  // which makes the >= 30 check FAIL rather than pass vacuously — so if the
  // skip ever stops applying, the suite goes red and says so.
  const sessions: RawGoldSession[] = goldAvailable
    ? (Object.values(JSON.parse(readFileSync(goldPath, "utf-8")).labeled) as RawGoldSession[])
    : [];

  test("has >= 30 sessions with context", () => {
    const withContext = sessions.filter(s =>
      (s.task_context && s.task_context.length > 0) ||
      (s.sentiment_summary && (s.sentiment_summary as string).length > 0),
    );
    expect(withContext.length).toBeGreaterThanOrEqual(30);
  });

  test("has >= 10 sessions with domain annotations", () => {
    const withDomains = sessions.filter(s => s.domains && s.domains.length > 0);
    expect(withDomains.length).toBeGreaterThanOrEqual(10);
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
