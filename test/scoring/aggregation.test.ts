import { describe, it, expect } from "bun:test";
import {
  segmentIntoMiniSessions,
  aggregateMiniSessions,
  type MiniSession,
} from "../../src/scoring/aggregation";
import type { OutcomeEvent } from "../../src/capture/outcomes";

function makeEvent(type: OutcomeEvent["type"], turn: number): OutcomeEvent {
  return { type, sessionId: "s1", timestamp: new Date().toISOString(), turn };
}

describe("segmentIntoMiniSessions", () => {
  it("splits events by boundary turn indices", () => {
    const events: OutcomeEvent[] = [
      makeEvent("commit-merged", 2),
      makeEvent("tests-pass", 5),
      makeEvent("correction", 12),
      makeEvent("issue-closed", 20),
    ];
    const boundaries = [10];

    const result = segmentIntoMiniSessions(events, boundaries, "ship");

    expect(result).toHaveLength(2);
    expect(result[0].startTurn).toBe(0);
    expect(result[0].endTurn).toBe(10);
    expect(result[0].outcomeCount).toBe(2);
    expect(result[1].startTurn).toBe(10);
    expect(result[1].endTurn).toBe(Infinity);
    expect(result[1].outcomeCount).toBe(2);
  });

  it("creates single session when no boundaries", () => {
    const events: OutcomeEvent[] = [
      makeEvent("commit-merged", 5),
      makeEvent("tests-pass", 10),
    ];

    const result = segmentIntoMiniSessions(events, [], "ship");

    expect(result).toHaveLength(1);
    expect(result[0].outcomeCount).toBe(2);
    expect(result[0].startTurn).toBe(0);
    expect(result[0].endTurn).toBe(Infinity);
  });

  it("handles empty events", () => {
    const result = segmentIntoMiniSessions([], [5, 10], "ship");
    expect(result).toHaveLength(3);
    result.forEach(s => expect(s.outcomeCount).toBe(0));
  });

  it("handles multiple boundaries", () => {
    const events: OutcomeEvent[] = [
      makeEvent("commit-merged", 3),
      makeEvent("correction", 8),
      makeEvent("tests-pass", 15),
      makeEvent("issue-closed", 25),
    ];

    const result = segmentIntoMiniSessions(events, [5, 10, 20], "ship");
    expect(result).toHaveLength(4);
  });

  it("computes score per mini-session using outcome weights", () => {
    const events: OutcomeEvent[] = [
      makeEvent("commit-merged", 3),
      makeEvent("tests-pass", 5),
    ];

    const result = segmentIntoMiniSessions(events, [], "ship");
    expect(result[0].score).toBeGreaterThan(5);
  });
});

describe("aggregateMiniSessions", () => {
  it("weights mini-sessions by outcome count (not equal averaging)", () => {
    const sessions: MiniSession[] = [
      { startTurn: 0, endTurn: 10, score: 8.0, outcomeCount: 5, taskType: "ship" },
      { startTurn: 10, endTurn: 20, score: 3.0, outcomeCount: 1, taskType: "ship" },
    ];

    const result = aggregateMiniSessions(sessions);
    // (8*5 + 3*1) / (5+1) = 43/6 ≈ 7.17 — closer to 8 than simple average of 5.5
    expect(result).toBeGreaterThan(5.5);
    expect(result).toBeLessThan(8.0);
  });

  it("returns 5.0 when all sessions have zero outcomes", () => {
    const sessions: MiniSession[] = [
      { startTurn: 0, endTurn: 10, score: 3.0, outcomeCount: 0, taskType: "ship" },
      { startTurn: 10, endTurn: 20, score: 8.0, outcomeCount: 0, taskType: "ship" },
    ];

    const result = aggregateMiniSessions(sessions);
    expect(result).toBe(5.0);
  });

  it("returns single session score when only one session", () => {
    const sessions: MiniSession[] = [
      { startTurn: 0, endTurn: Infinity, score: 7.5, outcomeCount: 3, taskType: "ship" },
    ];

    const result = aggregateMiniSessions(sessions);
    expect(result).toBe(7.5);
  });

  it("handles empty sessions array", () => {
    const result = aggregateMiniSessions([]);
    expect(result).toBe(5.0);
  });

  it("silence (zero outcomes) does not drag down active sessions", () => {
    const sessions: MiniSession[] = [
      { startTurn: 0, endTurn: 10, score: 9.0, outcomeCount: 4, taskType: "ship" },
      { startTurn: 10, endTurn: 20, score: 5.0, outcomeCount: 0, taskType: "ship" },
      { startTurn: 20, endTurn: 30, score: 5.0, outcomeCount: 0, taskType: "ship" },
    ];

    const result = aggregateMiniSessions(sessions);
    // Silent sessions have 0 weight, so result = 9.0
    expect(result).toBe(9.0);
  });
});
