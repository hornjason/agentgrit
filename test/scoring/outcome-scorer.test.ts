import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";

// Mock the paths module to use temp dirs
const tmpDir = join(import.meta.dir, ".tmp-outcome-scorer");
const stateDir = join(tmpDir, "state");
const signalDir = join(tmpDir, "signals");

import { scoreSessionByOutcome, scoreAllSessions, type ScoredSession } from "../../src/scoring/outcome-scorer";
import type { OutcomeEvent } from "../../src/capture/outcomes";

function writeOutcomes(events: OutcomeEvent[]): void {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const content = events.map(e => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(stateDir, "outcome-events.jsonl"), content);
}

function writeRatings(entries: Array<{ session_id: string; rating: number; source: string }>): void {
  if (!existsSync(signalDir)) mkdirSync(signalDir, { recursive: true });
  const content = entries.map(e => JSON.stringify({ ...e, timestamp: new Date().toISOString() })).join("\n") + "\n";
  writeFileSync(join(signalDir, "ratings.jsonl"), content);
}

describe("outcome-scorer", () => {
  beforeEach(() => {
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(signalDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it("scores session with multiple positive outcomes as high", () => {
    const events: OutcomeEvent[] = [
      { type: "commit-merged", sessionId: "s1", timestamp: new Date().toISOString(), turn: 5 },
      { type: "tests-pass", sessionId: "s1", timestamp: new Date().toISOString(), turn: 6 },
      { type: "issue-closed", sessionId: "s1", timestamp: new Date().toISOString(), turn: 10 },
    ];
    writeOutcomes(events);
    writeRatings([{ session_id: "s1", rating: 6.0, source: "transcript-analysis" }]);

    const result = scoreSessionByOutcome("s1", stateDir, signalDir);
    expect(result.outcomeScore).toBeGreaterThan(7);
    expect(result.confidence).toBe("high");
    expect(result.outcomeEvents.length).toBe(3);
  });

  it("scores session with corrections as lower", () => {
    const events: OutcomeEvent[] = [
      { type: "correction", sessionId: "s2", timestamp: new Date().toISOString(), turn: 3 },
      { type: "correction", sessionId: "s2", timestamp: new Date().toISOString(), turn: 7 },
      { type: "commit-merged", sessionId: "s2", timestamp: new Date().toISOString(), turn: 12 },
    ];
    writeOutcomes(events);
    writeRatings([{ session_id: "s2", rating: 6.0, source: "transcript-analysis" }]);

    const result = scoreSessionByOutcome("s2", stateDir, signalDir);
    expect(result.outcomeScore).toBeLessThan(result.keywordScore + 1);
    expect(result.confidence).toBe("high");
  });

  it("returns high confidence for 3+ events", () => {
    const events: OutcomeEvent[] = [
      { type: "commit-merged", sessionId: "s3", timestamp: new Date().toISOString(), turn: 1 },
      { type: "tests-pass", sessionId: "s3", timestamp: new Date().toISOString(), turn: 2 },
      { type: "pr-merged", sessionId: "s3", timestamp: new Date().toISOString(), turn: 3 },
    ];
    writeOutcomes(events);
    writeRatings([{ session_id: "s3", rating: 6.0, source: "transcript-analysis" }]);

    const result = scoreSessionByOutcome("s3", stateDir, signalDir);
    expect(result.confidence).toBe("high");
  });

  it("returns medium confidence for 1-2 events", () => {
    const events: OutcomeEvent[] = [
      { type: "commit-merged", sessionId: "s4", timestamp: new Date().toISOString(), turn: 5 },
    ];
    writeOutcomes(events);
    writeRatings([{ session_id: "s4", rating: 6.0, source: "transcript-analysis" }]);

    const result = scoreSessionByOutcome("s4", stateDir, signalDir);
    expect(result.confidence).toBe("medium");
  });

  it("returns low confidence and falls back to keyword when no outcome events", () => {
    writeOutcomes([]);
    writeRatings([{ session_id: "s5", rating: 7.0, source: "transcript-analysis" }]);

    const result = scoreSessionByOutcome("s5", stateDir, signalDir);
    expect(result.confidence).toBe("low");
    expect(result.outcomeScore).toBe(result.keywordScore);
  });

  it("computes correct delta between outcome and keyword scores", () => {
    const events: OutcomeEvent[] = [
      { type: "commit-merged", sessionId: "s6", timestamp: new Date().toISOString(), turn: 5 },
      { type: "issue-closed", sessionId: "s6", timestamp: new Date().toISOString(), turn: 10 },
    ];
    writeOutcomes(events);
    writeRatings([{ session_id: "s6", rating: 4.0, source: "transcript-analysis" }]);

    const result = scoreSessionByOutcome("s6", stateDir, signalDir);
    expect(result.delta).toBe(result.outcomeScore - result.keywordScore);
  });

  it("scoreAllSessions returns results for all sessions with ratings", () => {
    const events: OutcomeEvent[] = [
      { type: "commit-merged", sessionId: "sA", timestamp: new Date().toISOString(), turn: 1 },
      { type: "tests-pass", sessionId: "sB", timestamp: new Date().toISOString(), turn: 2 },
    ];
    writeOutcomes(events);
    writeRatings([
      { session_id: "sA", rating: 6.0, source: "transcript-analysis" },
      { session_id: "sB", rating: 7.0, source: "transcript-analysis" },
    ]);

    const results = scoreAllSessions(stateDir, signalDir);
    expect(results.length).toBe(2);
    const ids = results.map(r => r.sessionId);
    expect(ids).toContain("sA");
    expect(ids).toContain("sB");
  });
});
