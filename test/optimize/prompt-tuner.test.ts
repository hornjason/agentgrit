import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tunePrompt } from "../../src/optimize/prompt-tuner";
import type { TraceFetcher, PromptProposer, ContentGenerator, TraceWithScore } from "../../src/optimize/prompt-tuner";
import type { RubricConfig } from "../../src/adapters/types";
import type { JudgeConfig } from "../../src/evaluate/judge";

const TMP_DIR = join(import.meta.dir, ".tmp-prompt-tuner-test");

const testRubric: RubricConfig = {
  version: "1.0",
  schemaVersion: 1,
  dimensions: [
    { name: "accuracy", description: "Correct?", weight: 0.5, rubric: "Score 1-5" },
    { name: "clarity", description: "Clear?", weight: 0.5, rubric: "Score 1-5" },
  ],
  judgeModel: "test-model",
};

const judgeConfig: JudgeConfig = {
  provider: "openai",
  model: "gpt-4o",
  apiKey: "test-key",
};

function makeTestCases(systemPrompt: string, count: number): TraceWithScore[] {
  return Array.from({ length: count }, (_, i) => ({
    trace: { input: `query ${i}`, output: `response ${i}`, id: `trace-${i}` },
    score: 2,
    systemPrompt,
    userPrompt: `query ${i}`,
  }));
}

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

describe("tunePrompt", () => {
  test("selects lowest-scoring traces and applies improvement", async () => {
    const testCases = makeTestCases("You are a helpful assistant.", 3);

    const fetcher: TraceFetcher = {
      fetchLowestScoring: async (dimension, count) => {
        expect(dimension).toBe("accuracy");
        expect(count).toBe(3);
        return testCases;
      },
    };

    let proposeCallCount = 0;
    const proposer: PromptProposer = {
      propose: async (currentPrompt, targetDimension, badOutputs) => {
        proposeCallCount++;
        expect(targetDimension.name).toBe("accuracy");
        return currentPrompt + " Be more accurate.";
      },
    };

    let generateCount = 0;
    const generator: ContentGenerator = {
      generate: async (systemPrompt, userPrompt) => {
        generateCount++;
        return `Generated output for ${userPrompt}`;
      },
    };

    const mockJudgeScores = { accuracy: { score: 4, reasoning: "good" }, clarity: { score: 4, reasoning: "clear" } };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(mockJudgeScores) } }] }),
      }) as Response;

    try {
      const result = await tunePrompt({
        dimension: "accuracy",
        rubric: testRubric,
        judgeConfig,
        fetcher,
        proposer,
        generator,
        testSize: 3,
        rounds: 1,
        stateDir: TMP_DIR,
      });

      expect(result.originalPrompt).toBe("You are a helpful assistant.");
      expect(result.baselineWeighted).toBeGreaterThan(0);
      expect(generateCount).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("throws on unknown dimension", async () => {
    const fetcher: TraceFetcher = { fetchLowestScoring: async () => [] };
    const proposer: PromptProposer = { propose: async (p) => p };
    const generator: ContentGenerator = { generate: async () => null };

    await expect(
      tunePrompt({
        dimension: "nonexistent",
        rubric: testRubric,
        judgeConfig,
        fetcher,
        proposer,
        generator,
        testSize: 3,
        rounds: 1,
        stateDir: TMP_DIR,
      }),
    ).rejects.toThrow("Unknown dimension");
  });

  test("throws when no traces found", async () => {
    const fetcher: TraceFetcher = { fetchLowestScoring: async () => [] };
    const proposer: PromptProposer = { propose: async (p) => p };
    const generator: ContentGenerator = { generate: async () => null };

    await expect(
      tunePrompt({
        dimension: "accuracy",
        rubric: testRubric,
        judgeConfig,
        fetcher,
        proposer,
        generator,
        testSize: 3,
        rounds: 1,
        stateDir: TMP_DIR,
      }),
    ).rejects.toThrow("No traces found");
  });

  test("uses most common system prompt from test cases", async () => {
    const testCases: TraceWithScore[] = [
      { trace: { input: "q1", output: "r1", id: "t1" }, score: 2, systemPrompt: "prompt A", userPrompt: "q1" },
      { trace: { input: "q2", output: "r2", id: "t2" }, score: 2, systemPrompt: "prompt B", userPrompt: "q2" },
      { trace: { input: "q3", output: "r3", id: "t3" }, score: 2, systemPrompt: "prompt B", userPrompt: "q3" },
    ];

    let capturedPrompt = "";
    const fetcher: TraceFetcher = { fetchLowestScoring: async () => testCases };
    const proposer: PromptProposer = {
      propose: async (currentPrompt) => {
        capturedPrompt = currentPrompt;
        return currentPrompt + " extra";
      },
    };
    const generator: ContentGenerator = { generate: async () => "output" };

    const mockScores = { accuracy: { score: 3, reasoning: "" }, clarity: { score: 3, reasoning: "" } };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(mockScores) } }] }),
      }) as Response;

    try {
      await tunePrompt({
        dimension: "accuracy",
        rubric: testRubric,
        judgeConfig,
        fetcher,
        proposer,
        generator,
        testSize: 3,
        rounds: 1,
        stateDir: TMP_DIR,
      });
      expect(capturedPrompt).toBe("prompt B");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
