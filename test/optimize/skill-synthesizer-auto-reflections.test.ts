/**
 * `recommendSkills` — the inference-free half of the synthesizer, exercised
 * over reflections the daemon really wrote.
 *
 * The LLM path in skill-synthesizer.ts is useless to a standalone install with
 * no API key, which is the whole of #250. The end-to-end case here drives ten
 * synthetic scored sessions through `runDaemonCycle` with every provider key
 * deleted from the environment, reads back the `algorithm-reflections.jsonl`
 * the cycle wrote, and clusters it. Nothing is mocked and nothing is typed in:
 * the reflections under test are produced by the daemon, not by the test.
 *
 * The last case is a source check rather than a behavioural one on purpose.
 * `inference()` returns `{success: false}` when it cannot reach a provider, so
 * a function that called it with no API key would still return results — a
 * behavioural test cannot tell "did not call inference" from "called it and
 * got nothing". It cuts the function's own body out of the module and asserts
 * the cut is non-empty and smaller than the file before asserting anything
 * about its contents, because an empty slice contains no `inference(` either.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  loadReflections,
  recommendSkills,
  type Reflection,
} from "../../src/optimize/skill-synthesizer";
import type { AgentGritConfig } from "../../src/adapters/types";

const TEST_DIR = "/tmp/agentgrit-synthesizer-auto-reflections-" + process.pid;
const SIGNAL_DIR = join(TEST_DIR, "signals");
const RATINGS_FILE = join(SIGNAL_DIR, "ratings.jsonl");
const REFLECTIONS_FILE = join(SIGNAL_DIR, "algorithm-reflections.jsonl");

/** No `judge` block: the cycle's scoring step is keyed off `judge.apiKey`. */
function makeConfig(): AgentGritConfig {
  return {
    signalDir: SIGNAL_DIR,
    adapter: "local",
    rubrics: [],
    rules: { globalBudget: 25, projectBudget: 25, autoPromote: false },
    daemon: { interval: "30m", weeklyDay: "sunday" },
  };
}

/**
 * Ten sessions in two task families, five each, every description distinct so
 * a description maps back to exactly one reflection. The ratings differ per
 * family — 5/6 against 6/7 — so a mean that ignored its backing entries would
 * have to guess which family it was looking at.
 *
 * Both means sit strictly between 4 and 8 deliberately: the cycle's
 * AutoFeedback step takes sessions averaging <= 4 and AutoSuccess takes >= 8,
 * and both of those DO call `inference`. Scoring inside that band keeps this
 * case measuring the reflection path rather than waiting on a provider the
 * environment has no key for.
 */
const DEPLOY_SESSIONS = [1, 2, 3, 4, 5].map((n) => ({
  id: `refl-deploy-${n}`,
  comment: `deploy the staging container image for release ${n}`,
  ratings: [5, 6],
}));

const FLAKY_SESSIONS = [1, 2, 3, 4, 5].map((n) => ({
  id: `refl-flaky-${n}`,
  comment: `quarantine the flaky timeout spec in shard ${n}`,
  ratings: [6, 7],
}));

const ALL_SESSIONS = [...DEPLOY_SESSIONS, ...FLAKY_SESSIONS];

function writeTenScoredSessions(): void {
  let body = "";
  for (const s of ALL_SESSIONS) {
    for (const rating of s.ratings) {
      body +=
        JSON.stringify({
          type: "rating",
          session_id: s.id,
          timestamp: new Date().toISOString(),
          rating,
          comment: s.comment,
          source: "explicit",
        }) + "\n";
    }
  }
  writeFileSync(RATINGS_FILE, body);
}

const SAVED_ENV: Record<string, string | undefined> = {};
const CLEARED_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"];

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(SIGNAL_DIR, { recursive: true });

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

describe("recommendSkills over daemon-generated reflections", () => {
  test("ten scored sessions through the cycle with no API key yield two recommendations", async () => {
    const { runDaemonCycle } = await import("../../src/daemon/daemon");
    writeTenScoredSessions();

    const cycle = await runDaemonCycle(makeConfig());
    expect(cycle.reflectionsGenerated).toBe(10);

    const reflections = loadReflections(REFLECTIONS_FILE);
    expect(reflections).toHaveLength(10);

    const recommendations = recommendSkills(reflections);
    expect(recommendations.length).toBeGreaterThanOrEqual(2);

    // The two families separate: no recommendation mixes a deploy description
    // with a flaky-test one, which is what makes the count meaningful.
    for (const rec of recommendations) {
      const families = new Set(
        rec.taskDescriptions.map((d) => (d.startsWith("deploy") ? "deploy" : "flaky")),
      );
      expect(families.size).toBe(1);
    }

    // Every reflection is accounted for at most once.
    const covered = recommendations.flatMap((r) => r.taskDescriptions);
    expect(new Set(covered).size).toBe(covered.length);
    expect(covered.length).toBeLessThanOrEqual(10);
  });

  test("each recommendation reports its support count and the mean of its backing entries", async () => {
    const { runDaemonCycle } = await import("../../src/daemon/daemon");
    writeTenScoredSessions();
    await runDaemonCycle(makeConfig());

    const reflections = loadReflections(REFLECTIONS_FILE);
    const byDescription = new Map(reflections.map((r) => [r.task_description, r]));

    for (const rec of recommendSkills(reflections)) {
      expect(rec.reflectionCount).toBe(rec.taskDescriptions.length);
      expect(rec.reflectionCount).toBeGreaterThanOrEqual(2);

      // Recomputed from the entries, not read back off the recommendation.
      const backing = rec.taskDescriptions.map((d) => byDescription.get(d) as Reflection);
      expect(backing.every(Boolean)).toBe(true);
      const sentiments = backing.map((r) => r.implied_sentiment as number);
      const expected = sentiments.reduce((a, b) => a + b, 0) / sentiments.length;
      expect(rec.meanSentiment).toBeCloseTo(expected, 10);
      // 5.5 for the deploy family, 6.5 for the flaky one — a recommendation
      // reporting a constant would fail one of the two.
      expect([5.5, 6.5]).toContain(rec.meanSentiment);
    }
  });

  test("a cluster whose entries carry no sentiment reports null, not a substituted default", () => {
    const unscored: Reflection[] = [1, 2, 3].map((n) => ({
      timestamp: "2026-10-21T00:00:00.000Z",
      effort_level: "auto",
      task_description: `rotate the expired deployment credential ${n}`,
    }));

    const [rec] = recommendSkills(unscored);
    expect(rec).toBeDefined();
    expect(rec.reflectionCount).toBe(3);
    expect(rec.meanSentiment).toBeNull();
  });

  test("a token carried by one reflection alone is not a recommendation", () => {
    const reflections: Reflection[] = [
      {
        timestamp: "2026-10-21T00:00:00.000Z",
        effort_level: "auto",
        task_description: "regenerate the kubernetes ingress manifest",
        implied_sentiment: 5,
      },
      {
        timestamp: "2026-10-21T00:00:00.000Z",
        effort_level: "auto",
        task_description: "write the postgres migration rollback",
        implied_sentiment: 4,
      },
    ];

    expect(recommendSkills(reflections)).toEqual([]);
  });

  test("the recommendation path calls no inference", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/optimize/skill-synthesizer.ts"),
      "utf-8",
    );
    const start = source.indexOf("export function recommendSkills");
    expect(start).toBeGreaterThan(-1);

    // Cut to the end of the exported function: the next top-level `export` or
    // the end of file, whichever comes first.
    const after = source.indexOf("\nexport ", start + 1);
    const body = source.slice(start, after === -1 ? source.length : after);

    expect(body.length).toBeGreaterThan(100);
    expect(body.length).toBeLessThan(source.length);
    expect(body).toContain("recommendSkills");
    expect(body).not.toContain("inference(");
    expect(body).not.toContain("await ");
  });
});
