/**
 * The auto-reflection step, exercised through `runDaemonCycle` rather than
 * through the module it calls. The unit tests for composition live in
 * test/daemon/auto-reflection.test.ts; what is unproven without a fixture is
 * the wiring — that a cycle with scored sessions and no API key really does
 * land entries in `algorithm-reflections.jsonl` under `config.signalDir`,
 * really does count them on `CycleResult`, really does skip sessions it has
 * already written, and really does survive a failure in the step.
 *
 * Every assertion here reads the file the optimizer stack reads. Nothing is
 * mocked: the cycle writes to a temp `AGENTGRIT_DIR` and the test reads back
 * what landed on disk.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import type { AgentGritConfig } from "../../src/adapters/types";

const TEST_DIR = "/tmp/agentgrit-auto-reflection-fixture-" + process.pid;
const SIGNAL_DIR = join(TEST_DIR, "signals");
const STATE_DIR = join(TEST_DIR, "state");
const RATINGS_FILE = join(SIGNAL_DIR, "ratings.jsonl");
const REFLECTIONS_FILE = join(SIGNAL_DIR, "algorithm-reflections.jsonl");

/** No `judge` block: the cycle's scoring step is keyed off `judge.apiKey`. */
function makeConfig(overrides?: Partial<AgentGritConfig>): AgentGritConfig {
  return {
    signalDir: SIGNAL_DIR,
    adapter: "local",
    rubrics: [],
    rules: { globalBudget: 25, projectBudget: 25, autoPromote: false },
    daemon: { interval: "30m", weeklyDay: "sunday" },
    ...overrides,
  };
}

function ratingLine(sessionId: string, rating: number): string {
  return (
    JSON.stringify({
      type: "rating",
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      rating,
      source: "explicit",
    }) + "\n"
  );
}

function writeScoredSessions(count: number): string[] {
  const ids: string[] = [];
  let body = "";
  for (let i = 1; i <= count; i++) {
    const id = `auto-refl-session-${i}`;
    ids.push(id);
    // 4 and 5 for the same session: one entry per session, not per signal.
    body += ratingLine(id, 4) + ratingLine(id, 5);
  }
  writeFileSync(RATINGS_FILE, body);
  return ids;
}

function readReflections(): Array<Record<string, unknown>> {
  if (!existsSync(REFLECTIONS_FILE)) return [];
  return readFileSync(REFLECTIONS_FILE, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const SAVED_ENV: Record<string, string | undefined> = {};
const CLEARED_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"];

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(SIGNAL_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });

  SAVED_ENV.AGENTGRIT_DIR = process.env.AGENTGRIT_DIR;
  process.env.AGENTGRIT_DIR = TEST_DIR;
  for (const key of CLEARED_KEYS) {
    SAVED_ENV[key] = process.env[key];
    delete process.env[key];
  }
});

afterAll(() => {
  process.env.AGENTGRIT_DIR = SAVED_ENV.AGENTGRIT_DIR ?? process.env.AGENTGRIT_TEST_BASE ?? "";
  for (const key of CLEARED_KEYS) {
    if (SAVED_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED_ENV[key] as string;
  }
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("daemon auto-reflection step", () => {
  test("a cycle with N scored sessions and no API key appends N reflections", async () => {
    const { runDaemonCycle } = await import("../../src/daemon/daemon");
    const ids = writeScoredSessions(3);

    const result = await runDaemonCycle(makeConfig());

    expect(result.reflectionsGenerated).toBe(3);

    const entries = readReflections();
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.session_id).sort()).toEqual([...ids].sort());
    // Computed, not self-assessed: the mean of 4 and 5.
    expect(entries.every((e) => e.implied_sentiment === 4.5)).toBe(true);
    expect(entries.every((e) => e.source === "daemon-auto")).toBe(true);
  });

  test("a second cycle over the same ratings adds nothing", async () => {
    const { runDaemonCycle } = await import("../../src/daemon/daemon");
    writeScoredSessions(3);

    const first = await runDaemonCycle(makeConfig());
    expect(first.reflectionsGenerated).toBe(3);
    const afterFirst = readReflections();

    const second = await runDaemonCycle(makeConfig());

    expect(second.reflectionsGenerated).toBe(0);
    expect(readReflections()).toEqual(afterFirst);
  });

  test("a new session on a later cycle is the only entry added", async () => {
    const { runDaemonCycle } = await import("../../src/daemon/daemon");
    writeScoredSessions(2);
    await runDaemonCycle(makeConfig());

    writeFileSync(RATINGS_FILE, readFileSync(RATINGS_FILE, "utf-8") + ratingLine("auto-refl-session-late", 3));
    const second = await runDaemonCycle(makeConfig());

    expect(second.reflectionsGenerated).toBe(1);
    const ids = readReflections().map((e) => e.session_id);
    expect(ids).toHaveLength(3);
    expect(ids).toContain("auto-refl-session-late");
  });

  test("a failure in the step is recorded and the rest of the cycle still runs", async () => {
    const { runDaemonCycle } = await import("../../src/daemon/daemon");
    writeScoredSessions(2);
    // A directory where the step expects a file: reading it throws EISDIR.
    mkdirSync(REFLECTIONS_FILE, { recursive: true });

    const result = await runDaemonCycle(makeConfig());

    expect(result.errors.some((e) => e.startsWith("auto-reflection:"))).toBe(true);
    expect(result.reflectionsGenerated).toBe(0);
    // `cleanup.counts` is populated by a step that runs after this one, so a
    // non-null value here is evidence the throw did not abort the cycle.
    expect(result.cleanup.counts).not.toBeNull();
  });
});
