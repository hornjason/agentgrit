import { describe, expect, mock, test } from "bun:test";
import { judgeTrace } from "../../src/evaluate/judge";
import type { RubricConfig } from "../../src/adapters/types";

const testRubric: RubricConfig = {
  version: "1.0",
  schemaVersion: 1,
  dimensions: [
    { name: "accuracy", description: "Are claims correct?", weight: 0.5, rubric: "Score 1-5" },
    { name: "conciseness", description: "Is it minimal?", weight: 0.5, rubric: "Score 1-5" },
  ],
  judgeModel: "test-model",
};

describe("judgeTrace", () => {
  test("returns empty Score[] when no API key configured", async () => {
    const scores = await judgeTrace(
      { input: "test input", output: "test output" },
      testRubric,
      { provider: "openai", model: "gpt-4o", apiKey: undefined },
    );
    expect(scores).toEqual([]);
  });

  test("returns empty Score[] when apiKey is empty string", async () => {
    const scores = await judgeTrace(
      { input: "test input", output: "test output" },
      testRubric,
      { provider: "openai", model: "gpt-4o", apiKey: "" },
    );
    expect(scores).toEqual([]);
  });

  test("parses OpenAI response into Score[]", async () => {
    const mockResponse = {
      choices: [{
        message: {
          content: JSON.stringify({
            accuracy: { score: 4, reasoning: "mostly right" },
            conciseness: { score: 5, reasoning: "very tight" },
          }),
        },
      }],
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(mockResponse) } as Response),
    );
    try {
      const scores = await judgeTrace(
        { input: "what is 2+2", output: "4", id: "trace-123" },
        testRubric,
        { provider: "openai", model: "gpt-4o", apiKey: "sk-test-key" },
      );
      expect(scores).toHaveLength(2);
      const accuracy = scores.find((s) => s.dimension === "accuracy");
      expect(accuracy?.value).toBe(4);
      expect(accuracy?.reasoning).toBe("mostly right");
      expect(accuracy?.traceId).toBe("trace-123");
      expect(accuracy?.judgeModel).toBe("gpt-4o");
      expect(accuracy?.schemaVersion).toBe(1);
      const conciseness = scores.find((s) => s.dimension === "conciseness");
      expect(conciseness?.value).toBe(5);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("parses Claude response into Score[]", async () => {
    const mockResponse = {
      content: [{
        text: JSON.stringify({
          accuracy: { score: 3, reasoning: "has errors" },
          conciseness: { score: 4, reasoning: "ok" },
        }),
      }],
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(mockResponse) } as Response),
    );
    try {
      const scores = await judgeTrace(
        { input: "test", output: "result" },
        testRubric,
        { provider: "claude", model: "claude-sonnet-5", apiKey: "sk-ant-test" },
      );
      expect(scores).toHaveLength(2);
      expect(scores.find((s) => s.dimension === "accuracy")?.value).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("parses Gemini response into Score[]", async () => {
    const mockResponse = {
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              accuracy: { score: 5, reasoning: "perfect" },
              conciseness: { score: 2, reasoning: "verbose" },
            }),
          }],
        },
      }],
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(mockResponse) } as Response),
    );
    try {
      const scores = await judgeTrace(
        { input: "test", output: "result" },
        testRubric,
        { provider: "gemini", model: "gemini-2.5-flash", apiKey: "AIza-test" },
      );
      expect(scores).toHaveLength(2);
      expect(scores.find((s) => s.dimension === "accuracy")?.value).toBe(5);
      expect(scores.find((s) => s.dimension === "conciseness")?.value).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns empty Score[] on API failure", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response),
    );
    try {
      const scores = await judgeTrace(
        { input: "test", output: "result" },
        testRubric,
        { provider: "openai", model: "gpt-4o", apiKey: "sk-test", maxRetries: 0 },
      );
      expect(scores).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("handles plain number scores (no reasoning object)", async () => {
    const mockResponse = {
      choices: [{
        message: { content: JSON.stringify({ accuracy: 4, conciseness: 3 }) },
      }],
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(mockResponse) } as Response),
    );
    try {
      const scores = await judgeTrace(
        { input: "test", output: "result" },
        testRubric,
        { provider: "openai", model: "gpt-4o", apiKey: "sk-test" },
      );
      expect(scores).toHaveLength(2);
      expect(scores.find((s) => s.dimension === "accuracy")?.value).toBe(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
