import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  computeOutcomeScore,
  captureOutcome,
  readOutcomes,
  detectMiniBoundary,
} from "../../src/capture/outcomes";
import type { OutcomeEvent } from "../../src/capture/outcomes";

const TMP_DIR = join(import.meta.dir, ".tmp-outcomes-test");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

describe("computeOutcomeScore", () => {
  test("base score with no events returns 5.0", () => {
    const score = computeOutcomeScore([]);
    expect(score).toBe(5.0);
  });

  test("commit-merged adds 1.0", () => {
    const events: OutcomeEvent[] = [
      { type: "commit-merged", sessionId: "s1", timestamp: new Date().toISOString(), turn: 1 },
    ];
    expect(computeOutcomeScore(events)).toBe(6.0);
  });

  test("tests-pass adds 0.8", () => {
    const events: OutcomeEvent[] = [
      { type: "tests-pass", sessionId: "s1", timestamp: new Date().toISOString(), turn: 1 },
    ];
    expect(computeOutcomeScore(events)).toBe(5.8);
  });

  test("issue-closed adds 1.0", () => {
    const events: OutcomeEvent[] = [
      { type: "issue-closed", sessionId: "s1", timestamp: new Date().toISOString(), turn: 1 },
    ];
    expect(computeOutcomeScore(events)).toBe(6.0);
  });

  test("pr-merged adds 0.8", () => {
    const events: OutcomeEvent[] = [
      { type: "pr-merged", sessionId: "s1", timestamp: new Date().toISOString(), turn: 1 },
    ];
    expect(computeOutcomeScore(events)).toBe(5.8);
  });

  test("no-regressions adds 0.5", () => {
    const events: OutcomeEvent[] = [
      { type: "no-regressions", sessionId: "s1", timestamp: new Date().toISOString(), turn: 1 },
    ];
    expect(computeOutcomeScore(events)).toBe(5.5);
  });

  test("correction subtracts 0.3", () => {
    const events: OutcomeEvent[] = [
      { type: "correction", sessionId: "s1", timestamp: new Date().toISOString(), turn: 1 },
    ];
    expect(computeOutcomeScore(events)).toBe(4.7);
  });

  test("reprompt subtracts 0.5", () => {
    const events: OutcomeEvent[] = [
      { type: "reprompt", sessionId: "s1", timestamp: new Date().toISOString(), turn: 1 },
    ];
    expect(computeOutcomeScore(events)).toBe(4.5);
  });

  test("healthy-iteration adds 0.0", () => {
    const events: OutcomeEvent[] = [
      { type: "healthy-iteration", sessionId: "s1", timestamp: new Date().toISOString(), turn: 1 },
    ];
    expect(computeOutcomeScore(events)).toBe(5.0);
  });

  test("multiple events accumulate correctly", () => {
    const events: OutcomeEvent[] = [
      { type: "commit-merged", sessionId: "s1", timestamp: new Date().toISOString(), turn: 1 },
      { type: "tests-pass", sessionId: "s1", timestamp: new Date().toISOString(), turn: 2 },
      { type: "issue-closed", sessionId: "s1", timestamp: new Date().toISOString(), turn: 3 },
      { type: "correction", sessionId: "s1", timestamp: new Date().toISOString(), turn: 4 },
    ];
    // 5.0 + 1.0 + 0.8 + 1.0 - 0.3 = 7.5
    expect(computeOutcomeScore(events)).toBe(7.5);
  });

  test("score clamps to [1, 10]", () => {
    const manyPositive: OutcomeEvent[] = Array(20).fill(null).map((_, i) => ({
      type: "commit-merged" as const,
      sessionId: "s1",
      timestamp: new Date().toISOString(),
      turn: i,
    }));
    expect(computeOutcomeScore(manyPositive)).toBe(10);

    const manyNegative: OutcomeEvent[] = Array(20).fill(null).map((_, i) => ({
      type: "reprompt" as const,
      sessionId: "s1",
      timestamp: new Date().toISOString(),
      turn: i,
    }));
    expect(computeOutcomeScore(manyNegative)).toBe(1);
  });
});

describe("captureOutcome + readOutcomes", () => {
  test("captures and reads back outcome events", async () => {
    await captureOutcome({
      type: "commit-merged",
      sessionId: "test-session",
      timestamp: new Date().toISOString(),
      turn: 5,
    });
    await captureOutcome({
      type: "tests-pass",
      sessionId: "test-session",
      timestamp: new Date().toISOString(),
      turn: 6,
    });

    const events = readOutcomes();
    expect(events.length).toBe(2);
    expect(events[0].type).toBe("commit-merged");
    expect(events[1].type).toBe("tests-pass");
    expect(events[0].sessionId).toBe("test-session");
  });

  test("readOutcomes returns empty array when no file exists", () => {
    const events = readOutcomes();
    expect(events.length).toBe(0);
  });

  test("captureOutcome with metadata", async () => {
    await captureOutcome({
      type: "issue-closed",
      sessionId: "s1",
      timestamp: new Date().toISOString(),
      turn: 10,
      metadata: { issueNumber: 42 },
    });

    const events = readOutcomes();
    expect(events.length).toBe(1);
    expect(events[0].metadata?.issueNumber).toBe(42);
  });
});

describe("detectMiniBoundary", () => {
  test("returns true for /clear command", () => {
    expect(detectMiniBoundary("/clear", "some previous prompt")).toBe(true);
  });

  test("returns true for /compact command", () => {
    expect(detectMiniBoundary("/compact", "some previous prompt")).toBe(true);
  });

  test("returns true when Jaccard similarity < 0.2", () => {
    const current = "deploy the container to production server with nginx";
    const previous = "write unit tests for the authentication module parser";
    expect(detectMiniBoundary(current, previous)).toBe(true);
  });

  test("returns false for similar prompts", () => {
    const current = "fix the authentication bug in the login handler";
    const previous = "debug the authentication issue in the login handler";
    expect(detectMiniBoundary(current, previous)).toBe(false);
  });

  test("returns false with no previous prompt", () => {
    expect(detectMiniBoundary("hello world", undefined)).toBe(false);
  });

  test("returns true for /clear embedded in longer text", () => {
    expect(detectMiniBoundary("/clear and start fresh", "previous")).toBe(true);
  });
});
