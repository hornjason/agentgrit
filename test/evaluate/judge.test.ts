import { describe, expect, mock, test } from "bun:test";
import { judgeBatch, judgeTrace, jsonlToScores, scoresToJsonl } from "../../src/evaluate/judge";
import type { RubricConfig, Score } from "../../src/adapters/types";

const testRubric: RubricConfig = { version: "1.0", schemaVersion: 1, dimensions: [{ name: "accuracy", description: "correct?", weight: 0.5, rubric: "Score 1-5" }, { name: "conciseness", description: "minimal?", weight: 0.5, rubric: "Score 1-5" }], judgeModel: "test" };

describe("judgeTrace", () => {
  test("no key", async () => { expect(await judgeTrace({ input: "a", output: "b" }, testRubric, { provider: "openai", model: "gpt-4o" })).toEqual([]); });
  test("empty key", async () => { expect(await judgeTrace({ input: "a", output: "b" }, testRubric, { provider: "openai", model: "gpt-4o", apiKey: "" })).toEqual([]); });
  test("openai", async () => { const f = globalThis.fetch; globalThis.fetch = mock(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ accuracy: { score: 4, reasoning: "ok" }, conciseness: { score: 5, reasoning: "tight" } }) } }] }) } as Response)); try { const s = await judgeTrace({ input: "x", output: "4", id: "t1" }, testRubric, { provider: "openai", model: "gpt-4o", apiKey: "k" }); expect(s).toHaveLength(2); expect(s.find((x) => x.dimension === "accuracy")?.value).toBe(4); expect(s.find((x) => x.dimension === "accuracy")?.traceId).toBe("t1"); } finally { globalThis.fetch = f; } });
  test("claude", async () => { const f = globalThis.fetch; globalThis.fetch = mock(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ content: [{ text: JSON.stringify({ accuracy: { score: 3, reasoning: "err" }, conciseness: { score: 4, reasoning: "ok" } }) }] }) } as Response)); try { expect((await judgeTrace({ input: "a", output: "b" }, testRubric, { provider: "claude", model: "claude-sonnet-5", apiKey: "k" })).find((x) => x.dimension === "accuracy")?.value).toBe(3); } finally { globalThis.fetch = f; } });
  test("gemini", async () => { const f = globalThis.fetch; globalThis.fetch = mock(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ candidates: [{ content: { parts: [{ text: JSON.stringify({ accuracy: { score: 5, reasoning: "p" }, conciseness: { score: 2, reasoning: "v" } }) }] } }] }) } as Response)); try { const s = await judgeTrace({ input: "a", output: "b" }, testRubric, { provider: "gemini", model: "g", apiKey: "k" }); expect(s.find((x) => x.dimension === "accuracy")?.value).toBe(5); } finally { globalThis.fetch = f; } });
  test("api failure", async () => { const f = globalThis.fetch; globalThis.fetch = mock(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response)); try { expect(await judgeTrace({ input: "a", output: "b" }, testRubric, { provider: "openai", model: "gpt-4o", apiKey: "k", maxRetries: 0 })).toEqual([]); } finally { globalThis.fetch = f; } });
  test("plain numbers", async () => { const f = globalThis.fetch; globalThis.fetch = mock(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ accuracy: 4, conciseness: 3 }) } }] }) } as Response)); try { expect((await judgeTrace({ input: "a", output: "b" }, testRubric, { provider: "openai", model: "gpt-4o", apiKey: "k" })).find((x) => x.dimension === "accuracy")?.value).toBe(4); } finally { globalThis.fetch = f; } });
});

describe("judgeBatch", () => {
  test("no key", async () => { const { evaluated, failed } = await judgeBatch([{ input: "a", output: "b", id: "t1" }], testRubric, { provider: "openai", model: "m" }); expect(evaluated).toBe(0); expect(failed).toBe(1); });
  test("batch", async () => { const f = globalThis.fetch; globalThis.fetch = mock(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ accuracy: { score: 4, reasoning: "" }, conciseness: { score: 3, reasoning: "" } }) } }] }) } as Response)); try { const p: number[] = []; const { evaluated, results } = await judgeBatch([{ input: "a", output: "b", id: "t1" }, { input: "c", output: "d", id: "t2" }], testRubric, { provider: "openai", model: "m", apiKey: "k" }, { delayMs: 0, onProgress: (d) => p.push(d) }); expect(evaluated).toBe(2); expect(results).toHaveLength(2); expect(p).toEqual([1, 2]); } finally { globalThis.fetch = f; } });
});

describe("JSONL", () => {
  test("round-trip", () => { const s: Score[] = [{ traceId: "t1", dimension: "a", value: 4, rubric: "r", judgeModel: "m", timestamp: "t", schemaVersion: 1 }]; expect(jsonlToScores(scoresToJsonl(s))[0].traceId).toBe("t1"); });
  test("empty", () => { expect(scoresToJsonl([])).toBe(""); expect(jsonlToScores("")).toEqual([]); });
  test("malformed", () => { expect(jsonlToScores('{"traceId":"t1","dimension":"a","value":4,"rubric":"r","judgeModel":"m","timestamp":"t","schemaVersion":1}\nnot json\n')).toHaveLength(1); });
});
