/**
 * #323 — the daemon's score step: a vertex judge with no API key grades, the
 * rubric name resolves against <base>/rubrics, and scores are written to
 * quality-scores.jsonl exactly once per trace.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AgentGritConfig, RubricConfig, Score } from "../../src/adapters/types";
import type { JudgeConfig, Trace } from "../../src/evaluate/judge";
import { runScoreStep } from "../../src/daemon/score-step";

const RUBRIC: RubricConfig = {
  version: "1.0", schemaVersion: 1, judgeModel: "x",
  dimensions: [{ name: "accuracy", description: "correct?", weight: 1, rubric: "Score 1-5" }],
};

let signalDir: string;
let scratch: string;
const baseDir = () => process.env.AGENTGRIT_DIR!;

function config(judge: AgentGritConfig["judge"], rubrics = ["starter.json"]): AgentGritConfig {
  return {
    signalDir, adapter: "local", rubrics, judge,
    rules: { globalBudget: 25, projectBudget: 25, autoPromote: false },
    daemon: { interval: "daily", weeklyDay: "sunday" },
  };
}

function fakeJudge() {
  const calls: Array<{ trace: Trace; config: JudgeConfig }> = [];
  const judge = async (trace: Trace, rubric: RubricConfig, cfg: JudgeConfig): Promise<Score[]> => {
    calls.push({ trace, config: cfg });
    return rubric.dimensions.map((d) => ({
      traceId: trace.id!, dimension: d.name, value: 4, rubric: d.rubric, judgeModel: cfg.model,
      timestamp: "2026-11-26T00:00:00Z", schemaVersion: 1,
    }));
  };
  return { judge, calls };
}

const scoresFile = () => join(signalDir, "quality-scores.jsonl");
const scoreLines = () => (existsSync(scoresFile()) ? readFileSync(scoresFile(), "utf-8").split("\n").filter(Boolean) : []);

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "score-step-"));
  signalDir = join(scratch, "signals");
  mkdirSync(signalDir, { recursive: true });
  mkdirSync(join(baseDir(), "rubrics"), { recursive: true });
  writeFileSync(join(baseDir(), "rubrics", "starter.json"), JSON.stringify(RUBRIC));
  writeFileSync(join(signalDir, "ratings.jsonl"), [
    { id: "r-1", type: "rating", timestamp: "2026-09-30T10:00:00Z", session_id: "s-1", rating: 2, source: "explicit", response_preview: "reply one", schemaVersion: 1 },
    { id: "r-2", type: "rating", timestamp: "2026-09-30T11:00:00Z", session_id: "s-2", rating: 9, source: "explicit", response_preview: "reply two", schemaVersion: 1 },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(join(baseDir(), "rubrics", "starter.json"), { force: true });
});

describe("score step (#323)", () => {
  test("a vertex judge with no apiKey grades, and the project and location reach the judge", async () => {
    const { judge, calls } = fakeJudge();
    const { scores, warnings } = await runScoreStep(config({ provider: "vertex", model: "gemini-x", project: "proj-1", location: "global" }), { judge });

    expect(scores).toHaveLength(2);
    expect(warnings).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls[0].config).toMatchObject({ provider: "vertex", model: "gemini-x", project: "proj-1", location: "global" });
    expect(calls[0].config.apiKey).toBeUndefined();
  });

  test("the bare rubric name in config resolves against <base>/rubrics", async () => {
    const { judge, calls } = fakeJudge();
    const prevCwd = process.cwd();
    process.chdir("/");
    try {
      await runScoreStep(config({ provider: "vertex", model: "m", project: "p" }), { judge });
    } finally { process.chdir(prevCwd); }
    expect(calls.length).toBeGreaterThan(0);
  });

  test("graded scores are appended to quality-scores.jsonl", async () => {
    const { judge } = fakeJudge();
    await runScoreStep(config({ provider: "vertex", model: "m", project: "p" }), { judge });

    const rows = scoreLines().map((l) => JSON.parse(l) as Score);
    expect(rows.map((r) => r.traceId).sort()).toEqual(["r-1", "r-2"]);
  });

  test("a second run over the same ratings grades and appends nothing", async () => {
    const first = fakeJudge();
    await runScoreStep(config({ provider: "vertex", model: "m", project: "p" }), { judge: first.judge });
    const second = fakeJudge();
    const again = await runScoreStep(config({ provider: "vertex", model: "m", project: "p" }), { judge: second.judge });

    expect(second.calls).toHaveLength(0);
    expect(again.scores).toEqual([]);
    expect(again.warnings).toEqual([]);
    expect(scoreLines()).toHaveLength(2);
  });

  test("no judge configured: nothing is graded and no file is written", async () => {
    const { judge, calls } = fakeJudge();
    expect(await runScoreStep(config(undefined), { judge })).toEqual({ scores: [], warnings: [] });
    expect(calls).toHaveLength(0);
    expect(existsSync(scoresFile())).toBe(false);
  });

  test("a vertex judge with no project is not usable", async () => {
    const { judge, calls } = fakeJudge();
    expect((await runScoreStep(config({ provider: "vertex", model: "m" }), { judge })).scores).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("a rubric that does not load is reported, not skipped silently", async () => {
    const { judge, calls } = fakeJudge();
    const { scores, warnings } = await runScoreStep(config({ provider: "vertex", model: "m", project: "p" }, ["missing.json"]), { judge });
    expect(scores).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("missing.json");
  });

  test("a judge that grades nothing it was given is reported", async () => {
    const calls: Trace[] = [];
    const judge = async (trace: Trace): Promise<Score[]> => { calls.push(trace); return []; };
    const { scores, warnings } = await runScoreStep(config({ provider: "vertex", model: "m", project: "p" }), { judge });
    expect(calls).toHaveLength(2);
    expect(scores).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("0 of 2");
  });

  test("CONTROL — a key-based judge still grades", async () => {
    const { judge, calls } = fakeJudge();
    await runScoreStep(config({ provider: "gemini", model: "m", apiKey: "k" }), { judge });
    expect(calls).toHaveLength(2);
    expect(calls[0].config.apiKey).toBe("k");
  });
});
