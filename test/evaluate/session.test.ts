import { describe, expect, test } from "bun:test";
import { buildQualityJudgePrompt, compositeQuality, scoreSession, scoreTranscript, scoreTranscriptBatch, type TranscriptQualityResult } from "../../src/evaluate/session";
import type { CorrectionSignal, RatingSignal, SentimentSignal } from "../../src/adapters/types";

function mkR(rating: number): RatingSignal { return { id: `r-${Math.random()}`, timestamp: new Date().toISOString(), session_id: "s", schemaVersion: 1, type: "rating", rating, source: "explicit" }; }
function mkC(): CorrectionSignal { return { id: `c-${Math.random()}`, timestamp: new Date().toISOString(), session_id: "s", schemaVersion: 1, type: "correction", correction_phrase: "no", context: "ctx" }; }
function mkS(rating: number): SentimentSignal { return { id: `s-${Math.random()}`, timestamp: new Date().toISOString(), session_id: "s", schemaVersion: 1, type: "sentiment", rating, source: "transcript-analysis", confidence: 0.8, corrections: 0, approvals: 1, reprompts: 0 }; }

describe("scoreSession", () => {
  test("perfect", () => { const s = scoreSession({ ratings: [mkR(10)], corrections: [], sentiment: [mkS(10)] }); expect(s).toBeGreaterThan(0.9); expect(s).toBeLessThanOrEqual(1.0); });
  test("terrible", () => { expect(scoreSession({ ratings: [mkR(1)], corrections: [mkC(), mkC()], sentiment: [mkS(1)] })).toBeLessThan(0.2); });
  test("baseline", () => { expect(scoreSession({ ratings: [], corrections: [], sentiment: [] })).toBeCloseTo(0.65, 1); });
  test("corrections reduce", () => { expect(scoreSession({ ratings: [mkR(7)], corrections: [mkC(), mkC()], sentiment: [mkS(7)] })).toBeLessThan(scoreSession({ ratings: [mkR(7)], corrections: [], sentiment: [mkS(7)] })); });
  test("avg ratings", () => { expect(scoreSession({ ratings: [mkR(10), mkR(6)], corrections: [], sentiment: [mkS(5)] })).toBeCloseTo(0.4 * (8 / 10) + 0.3 * 1.0 + 0.3 * (5 / 10), 2); });
  test("clamped", () => { const s = scoreSession({ ratings: [mkR(0)], corrections: [mkC(), mkC()], sentiment: [mkS(0)] }); expect(s).toBeGreaterThanOrEqual(0); expect(s).toBeLessThanOrEqual(1); });
});

describe("buildQualityJudgePrompt", () => {
  test("defaults", () => { const p = buildQualityJudgePrompt(); expect(p).toContain("task_completion"); expect(p).toContain("conciseness"); });
  test("custom", () => { const p = buildQualityJudgePrompt(["accuracy"]); expect(p).toContain("accuracy"); expect(p).not.toContain("task_completion"); });
});

describe("scoreTranscript", () => {
  test("scores", async () => { const r = await scoreTranscript("s1", "a".repeat(5000), { judge: async () => ({ task_completion: 4, tool_correctness: 5, rule_adherence: 3, coherence: 4, conciseness: 4, overall: 4.0, notes: "ok" }) }); expect(r.overall).toBe(4.0); expect(r.dimensions).toHaveLength(5); expect(r.notes).toBe("ok"); });
  test("null judge", async () => { const r = await scoreTranscript("s1", "t", { judge: async () => null }); expect(r.error).toBe("judge returned null"); expect(r.overall).toBe(0); });
  test("judge throws", async () => { const r = await scoreTranscript("s1", "t", { judge: async () => { throw new Error("timeout"); } }); expect(r.error).toBe("timeout"); });
  test("computes overall", async () => { const r = await scoreTranscript("s1", "t", { judge: async () => ({ task_completion: 4, tool_correctness: 5, rule_adherence: 3, coherence: 4, conciseness: 4 }) }); expect(r.overall).toBe(4.0); });
  test("tailChars", async () => { let cap = ""; await scoreTranscript("s1", "x".repeat(10000), { tailChars: 100, judge: async (_s, u) => { cap = u; return { task_completion: 3, overall: 3 }; } }); expect(cap).toContain("last 100 chars"); });
});

describe("compositeQuality", () => {
  test("no transcript", () => { const sigs = { ratings: [mkR(10)], corrections: [], sentiment: [mkS(10)] }; expect(compositeQuality(sigs)).toBe(scoreSession(sigs)); });
  test("blends", () => { const sigs = { ratings: [mkR(10)], corrections: [], sentiment: [mkS(10)] }; const tr: TranscriptQualityResult = { sessionId: "s", sessionLengthChars: 5000, dimensions: [{ name: "t", score: 5 }], overall: 5.0, scoredAt: new Date().toISOString() }; expect(compositeQuality(sigs, tr)).toBeCloseTo(0.6 * scoreSession(sigs) + 0.4, 2); });
  test("ignores error", () => { const sigs = { ratings: [mkR(5)], corrections: [], sentiment: [mkS(5)] }; const tr: TranscriptQualityResult = { sessionId: "s", sessionLengthChars: 0, dimensions: [], overall: 0, scoredAt: new Date().toISOString(), error: "fail" }; expect(compositeQuality(sigs, tr)).toBe(scoreSession(sigs)); });
});

describe("scoreTranscriptBatch", () => {
  test("multi", async () => { const r = await scoreTranscriptBatch([{ sessionId: "s1", transcript: "a" }, { sessionId: "s2", transcript: "b" }], { judge: async () => ({ overall: 4 }) }); expect(r).toHaveLength(2); expect(r[0].sessionId).toBe("s1"); });
  test("progress", async () => { const p: number[] = []; await scoreTranscriptBatch([{ sessionId: "s1", transcript: "a" }, { sessionId: "s2", transcript: "b" }], { judge: async () => ({ overall: 3 }) }, { onProgress: (d) => p.push(d) }); expect(p).toEqual([1, 2]); });
});
