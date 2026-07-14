import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  captureRating,
  parseRating,
  scoreSentiment,
  scoreSentimentLLM,
  computeComposite,
  truncatePreview,
  cacheLastResponse,
  writeLastResponse,
  wordOverlapRatio,
  scoreSession,
  captureSessionSentiment,
  scoreSessionObjective,
  parseThumbsRating,
  countUninterruptedRuns,
  countShortFrustrated,
} from "../../src/capture/rating";
import type { Turn, ObjectiveScoreInput } from "../../src/capture/rating";
import type { AgentGritConfig } from "../../src/adapters/types";
import type { InferenceOptions, InferenceResult } from "../../src/adapters/inference";

const TMP_DIR = join(import.meta.dir, ".tmp-rating-test");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

describe("parseRating", () => {
  test("parses /rate M:7 S:8 Q:6", () => {
    const result = parseRating("/rate M:7 S:8 Q:6");
    expect(result).not.toBeNull();
    expect(result!.mode).toBe(7);
    expect(result!.scope).toBe(8);
    expect(result!.quality).toBe(6);
    expect(result!.comment).toBeUndefined();
  });

  test("parses /rate with comment", () => {
    const result = parseRating("/rate M:9 S:9 Q:10 excellent session");
    expect(result).not.toBeNull();
    expect(result!.mode).toBe(9);
    expect(result!.quality).toBe(10);
    expect(result!.comment).toBe("excellent session");
  });

  test("returns null for non-rate messages", () => {
    expect(parseRating("hello world")).toBeNull();
    expect(parseRating("/help")).toBeNull();
    expect(parseRating("M:7 S:8 Q:6")).toBeNull();
  });

  test("returns null for out-of-range values", () => {
    expect(parseRating("/rate M:0 S:8 Q:6")).toBeNull();
    expect(parseRating("/rate M:7 S:11 Q:6")).toBeNull();
  });

  test("case insensitive", () => {
    const result = parseRating("/RATE m:7 s:8 q:6");
    expect(result).not.toBeNull();
    expect(result!.mode).toBe(7);
  });
});

describe("scoreSentiment", () => {
  test("detects positive sentiment", () => {
    const result = scoreSentiment("excellent amazing work");
    expect(result).not.toBeNull();
    expect(result!.summary).toContain("Positive");
    expect(result!.confidence).toBeGreaterThan(0.5);
  });

  test("detects negative sentiment", () => {
    const result = scoreSentiment("terrible broken failure");
    expect(result).not.toBeNull();
    expect(result!.summary).toContain("Negative");
  });

  test("returns null for neutral text", () => {
    const result = scoreSentiment("please check the logs");
    expect(result).toBeNull();
  });

  test("detects mixed sentiment", () => {
    const result = scoreSentiment("great but also broken");
    expect(result).not.toBeNull();
    // "great" and "broken" are both 1 keyword each — mixed
    expect(result!.summary).toContain("Mixed");
  });

  test("detects two-word positive phrases", () => {
    const result = scoreSentiment("love it");
    expect(result).not.toBeNull();
    expect(result!.summary).toContain("Positive");
  });
});

describe("scoreSentimentLLM", () => {
  test("returns LLM sentiment when inference succeeds", async () => {
    const mockInfer = async (): Promise<InferenceResult> => ({
      success: true,
      output: '{"score": 8, "summary": "Very positive interaction"}',
      parsed: { score: 8, summary: "Very positive interaction" },
      latencyMs: 10,
      level: "fast",
      provider: "claude",
    });

    const result = await scoreSentimentLLM("great work on the feature", mockInfer);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe("Very positive interaction");
    expect(result!.confidence).toBeGreaterThan(0.5);
  });

  test("returns null when inference fails", async () => {
    const mockInfer = async (): Promise<InferenceResult> => ({
      success: false,
      output: "",
      error: "unavailable",
      latencyMs: 0,
      level: "fast",
      provider: "claude",
    });

    const result = await scoreSentimentLLM("some text", mockInfer);
    expect(result).toBeNull();
  });

  test("returns null for empty text", async () => {
    const mockInfer = async (): Promise<InferenceResult> => ({
      success: true,
      output: "{}",
      parsed: {},
      latencyMs: 10,
      level: "fast",
      provider: "claude",
    });

    const result = await scoreSentimentLLM("", mockInfer);
    expect(result).toBeNull();
  });

  test("returns null when parsed JSON lacks required fields", async () => {
    const mockInfer = async (): Promise<InferenceResult> => ({
      success: true,
      output: '{"mood": "good"}',
      parsed: { mood: "good" },
      latencyMs: 10,
      level: "fast",
      provider: "claude",
    });

    const result = await scoreSentimentLLM("text", mockInfer);
    expect(result).toBeNull();
  });

  test("returns null when inference throws", async () => {
    const throwingInfer = async (): Promise<InferenceResult> => {
      throw new Error("network timeout");
    };

    const result = await scoreSentimentLLM("text", throwingInfer);
    expect(result).toBeNull();
  });
});

describe("captureRating with LLM sentiment", () => {
  test("uses LLM sentiment when available", async () => {
    const mockInfer = async (): Promise<InferenceResult> => ({
      success: true,
      output: '{"score": 9, "summary": "Excellent session performance"}',
      parsed: { score: 9, summary: "Excellent session performance" },
      latencyMs: 10,
      level: "fast",
      provider: "claude",
    });

    const signal = await captureRating(
      "/rate M:8 S:8 Q:8 amazing work",
      "test-session",
      { infer: mockInfer },
    );
    expect(signal).not.toBeNull();
    expect(signal!.sentimentSummary).toBe("Excellent session performance");
  });

  test("falls back to keyword sentiment when LLM fails", async () => {
    const failingInfer = async (): Promise<InferenceResult> => ({
      success: false,
      output: "",
      error: "unavailable",
      latencyMs: 0,
      level: "fast",
      provider: "claude",
    });

    const signal = await captureRating(
      "/rate M:8 S:8 Q:8 excellent amazing",
      "test-session",
      { infer: failingInfer },
    );
    expect(signal).not.toBeNull();
    expect(signal!.sentimentSummary).toContain("Positive");
  });
});

describe("computeComposite", () => {
  test("computes weighted average", () => {
    const result = computeComposite(10, 10, 10);
    expect(result).toBe(10);
  });

  test("handles different values", () => {
    const result = computeComposite(7, 8, 6);
    // 7*0.34 + 8*0.33 + 6*0.33 = 2.38 + 2.64 + 1.98 = 7.0
    expect(result).toBe(7);
  });

  test("rounds to one decimal", () => {
    const result = computeComposite(7, 7, 8);
    expect(result).toBe(7.3);
  });
});

describe("truncatePreview", () => {
  test("truncates to 500 chars", () => {
    const long = "x".repeat(1000);
    expect(truncatePreview(long).length).toBe(500);
  });

  test("returns short strings unchanged", () => {
    expect(truncatePreview("hello")).toBe("hello");
  });

  test("returns empty for empty input", () => {
    expect(truncatePreview("")).toBe("");
  });
});

describe("cacheLastResponse", () => {
  test("truncates to 2000 chars", () => {
    const long = "x".repeat(5000);
    expect(cacheLastResponse(long).length).toBe(2000);
  });
});

describe("writeLastResponse", () => {
  test("creates file in signal dir", () => {
    const sigDir = join(TMP_DIR, "signals");
    const filePath = writeLastResponse("hello world", sigDir);
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, "utf-8");
    expect(content).toBe("hello world");
  });

  test("truncates long responses before writing", () => {
    const sigDir = join(TMP_DIR, "signals");
    const long = "x".repeat(5000);
    const filePath = writeLastResponse(long, sigDir);
    const content = readFileSync(filePath, "utf-8");
    expect(content.length).toBe(2000);
  });
});

describe("wordOverlapRatio", () => {
  test("returns 1.0 for identical strings", () => {
    expect(wordOverlapRatio("fix the auth bug", "fix the auth bug")).toBe(1);
  });

  test("returns 0 for no overlap", () => {
    expect(wordOverlapRatio("deploy the service", "check email inbox")).toBe(0);
  });

  test("returns partial for some overlap", () => {
    const ratio = wordOverlapRatio("fix the auth bug please", "fix the auth module");
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(1);
  });

  test("ignores short words", () => {
    // "a" and "is" are <= 2 chars, filtered out
    expect(wordOverlapRatio("a is", "a is")).toBe(0);
  });
});

describe("scoreSession", () => {
  test("returns base score 6.0 for no signals", () => {
    const turns: Turn[] = [
      { role: "user", text: "check the build", charCount: 15 },
      { role: "assistant", text: "Build passes.", charCount: 13 },
    ];
    const result = scoreSession(turns);
    expect(result.score).toBe(6);
    expect(result.corrections).toBe(0);
    expect(result.approvals).toBe(0);
    expect(result.reprompts).toBe(0);
  });

  test("penalizes corrections", () => {
    const turns: Turn[] = [
      { role: "assistant", text: "I refactored the module.", charCount: 24 },
      { role: "user", text: "wrong, fix the bug not refactor", charCount: 31 },
    ];
    const result = scoreSession(turns);
    expect(result.score).toBeLessThan(6);
    expect(result.corrections).toBe(1);
  });

  test("rewards approvals", () => {
    const turns: Turn[] = [
      { role: "assistant", text: "Done.", charCount: 5 },
      { role: "user", text: "perfect, exactly what I needed", charCount: 30 },
    ];
    const result = scoreSession(turns);
    expect(result.score).toBeGreaterThan(6);
    expect(result.approvals).toBeGreaterThanOrEqual(1);
  });

  test("detects reprompts from word overlap", () => {
    const turns: Turn[] = [
      { role: "user", text: "please fix the authentication bug", charCount: 33 },
      { role: "assistant", text: "I refactored the code.", charCount: 22 },
      { role: "user", text: "fix the authentication bug please", charCount: 33 },
    ];
    const result = scoreSession(turns);
    expect(result.reprompts).toBe(1);
  });

  test("confidence varies by turn count", () => {
    const fewTurns: Turn[] = [
      { role: "user", text: "hi", charCount: 2 },
    ];
    // 12 alternating turns = 6 user turns => confidence 0.7
    const mediumTurns: Turn[] = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `turn ${i} content here`,
      charCount: 20,
    }));
    // 22 alternating turns = 11 user turns => confidence 0.9
    const manyTurns: Turn[] = Array.from({ length: 22 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `turn ${i} content here`,
      charCount: 20,
    }));

    expect(scoreSession(fewTurns).confidence).toBe(0.5);
    expect(scoreSession(mediumTurns).confidence).toBe(0.7);
    expect(scoreSession(manyTurns).confidence).toBe(0.9);
  });

  test("clamps score to [1, 10]", () => {
    // Many corrections should not go below 1
    const turns: Turn[] = Array.from({ length: 20 }, () => [
      { role: "assistant" as const, text: "response", charCount: 8 },
      { role: "user" as const, text: "wrong stop no incorrect", charCount: 24 },
    ]).flat();
    const result = scoreSession(turns);
    expect(result.score).toBeGreaterThanOrEqual(1);
    expect(result.score).toBeLessThanOrEqual(10);
  });
});

describe("captureRating", () => {
  test("writes signal for valid /rate command", async () => {
    const signal = await captureRating("/rate M:7 S:8 Q:6", "test-session");
    expect(signal).not.toBeNull();
    expect(signal!.type).toBe("rating");
    expect(signal!.source).toBe("explicit");
    expect(signal!.rating).toBeGreaterThan(0);
    expect(signal!.session_id).toBe("test-session");

    const filePath = join(TMP_DIR, "signals", "ratings.jsonl");
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.type).toBe("rating");
  });

  test("returns null for non-rate messages", async () => {
    const signal = await captureRating("hello", "test-session");
    expect(signal).toBeNull();
  });

  test("computes composite rating", async () => {
    const signal = await captureRating("/rate M:10 S:10 Q:10", "test-session");
    expect(signal).not.toBeNull();
    expect(signal!.rating).toBe(10);
  });

  test("attaches response preview when provided", async () => {
    const signal = await captureRating("/rate M:8 S:8 Q:8", "test-session", {
      responsePreview: "x".repeat(1000),
    });
    expect(signal).not.toBeNull();
    expect(signal!.response_preview!.length).toBe(500);
  });

  test("attaches rule_ids when provided", async () => {
    const signal = await captureRating("/rate M:8 S:8 Q:8", "test-session", {
      ruleIds: ["rule-abc123", "rule-def456"],
    });
    expect(signal).not.toBeNull();
    expect(signal!.rule_ids).toEqual(["rule-abc123", "rule-def456"]);
  });
});

describe("captureSessionSentiment", () => {
  test("returns null for empty turns", async () => {
    const signal = await captureSessionSentiment([], "test-session");
    expect(signal).toBeNull();
  });

  test("returns null when zero signals (lets Haiku handle)", async () => {
    const turns: Turn[] = [
      { role: "user", text: "check the build", charCount: 15 },
      { role: "assistant", text: "Build passes.", charCount: 13 },
    ];
    const signal = await captureSessionSentiment(turns, "test-session");
    expect(signal).toBeNull();
  });

  test("uses v2 scorer when corrections exist", async () => {
    const turns: Turn[] = [
      { role: "assistant", text: "I refactored it.", charCount: 16 },
      { role: "user", text: "wrong, just fix the bug", charCount: 23 },
      { role: "assistant", text: "Fixed.", charCount: 6 },
      { role: "user", text: "perfect", charCount: 7 },
    ];

    const signal = await captureSessionSentiment(turns, "test-session");
    expect(signal).not.toBeNull();
    expect(signal!.scorer_version).toBe("v2");
    expect(signal!.corrections).toBe(1);
    expect(signal!.approvals).toBe(1);
  });

  test("uses v2 scorer when gateRuns > 0", async () => {
    const turns: Turn[] = [
      { role: "user", text: "check the build", charCount: 15 },
      { role: "assistant", text: "Build passes.", charCount: 13 },
    ];
    const signal = await captureSessionSentiment(turns, "test-session", { gateRuns: 3 });
    expect(signal).not.toBeNull();
    expect(signal!.scorer_version).toBe("v2");
  });

  test("uses v2 scorer when hasExplicitRating is true", async () => {
    const turns: Turn[] = [
      { role: "user", text: "check the build", charCount: 15 },
      { role: "assistant", text: "Build passes.", charCount: 13 },
    ];
    const signal = await captureSessionSentiment(turns, "test-session", { hasExplicitRating: true });
    expect(signal).not.toBeNull();
    expect(signal!.scorer_version).toBe("v2");
  });
});

describe("scoreSessionObjective", () => {
  const BASE_INPUT: ObjectiveScoreInput = {
    corrections: 0,
    reprompts: 0,
    iterations: 0,
    firstPassGates: 0,
    uninterruptedRuns: 0,
    shortFrustrated: 0,
  };

  test("returns base score 5.0 with no signals", () => {
    const result = scoreSessionObjective(BASE_INPUT);
    expect(result.score).toBe(5);
    expect(result.scorer_version).toBe("v2");
    expect(result.breakdown.base).toBe(5);
  });

  test("corrections reduce score with no cap", () => {
    const result = scoreSessionObjective({ ...BASE_INPUT, corrections: 4 });
    expect(result.score).toBe(3);
    expect(result.breakdown.correctionPenalty).toBe(-2);
  });

  test("many corrections drive score below base significantly (no cap)", () => {
    const result = scoreSessionObjective({ ...BASE_INPUT, corrections: 10 });
    expect(result.score).toBe(1);
    expect(result.breakdown.correctionPenalty).toBe(-5);
  });

  test("reprompts reduce score with -1.5 cap", () => {
    const result = scoreSessionObjective({ ...BASE_INPUT, reprompts: 10 });
    expect(result.breakdown.repromptPenalty).toBe(-1.5);
    expect(result.score).toBe(3.5);
  });

  test("iterations reduce score", () => {
    const result = scoreSessionObjective({ ...BASE_INPUT, iterations: 3 });
    expect(result.breakdown.iterationPenalty).toBeCloseTo(-0.9, 5);
    expect(result.score).toBe(4.1);
  });

  test("first pass gates add bonus", () => {
    const result = scoreSessionObjective({ ...BASE_INPUT, firstPassGates: 2 });
    expect(result.breakdown.firstPassBonus).toBe(2);
    expect(result.score).toBe(7);
  });

  test("uninterrupted runs add bonus capped at 1.5", () => {
    const result = scoreSessionObjective({ ...BASE_INPUT, uninterruptedRuns: 10 });
    expect(result.breakdown.uninterruptedBonus).toBe(1.5);
    expect(result.score).toBe(6.5);
  });

  test("frustration reduces score", () => {
    const result = scoreSessionObjective({ ...BASE_INPUT, shortFrustrated: 2 });
    expect(result.breakdown.frustrationPenalty).toBe(-0.6);
    expect(result.score).toBe(4.4);
  });

  test("clamps to minimum 1", () => {
    const result = scoreSessionObjective({ ...BASE_INPUT, corrections: 20 });
    expect(result.score).toBe(1);
  });

  test("clamps to maximum 10", () => {
    const result = scoreSessionObjective({
      ...BASE_INPUT,
      firstPassGates: 10,
      uninterruptedRuns: 20,
    });
    expect(result.score).toBe(10);
  });

  test("respects config overrides", () => {
    const config: AgentGritConfig = {
      signalDir: "/tmp",
      adapter: "local",
      rubrics: [],
      rules: { globalBudget: 10, projectBudget: 5, autoPromote: false },
      daemon: { interval: "1h", weeklyDay: "sunday" },
      thresholds: {
        scoringBase: 7.0,
        correctionWeight: -1.0,
      },
    };
    const result = scoreSessionObjective({ ...BASE_INPUT, corrections: 2 }, config);
    expect(result.breakdown.base).toBe(7);
    expect(result.breakdown.correctionPenalty).toBe(-2);
    expect(result.score).toBe(5);
  });
});

describe("parseThumbsRating", () => {
  test("detects thumbs up emoji", () => {
    const result = parseThumbsRating("👍");
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("up");
    expect(result!.score).toBe(9);
  });

  test("detects thumbs down emoji", () => {
    const result = parseThumbsRating("👎");
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("down");
    expect(result!.score).toBe(2);
  });

  test("detects 'thumbs up' text", () => {
    const result = parseThumbsRating("thumbs up");
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("up");
    expect(result!.score).toBe(9);
  });

  test("detects 'thumbs down' text", () => {
    const result = parseThumbsRating("thumbs down");
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("down");
    expect(result!.score).toBe(2);
  });

  test("detects +1", () => {
    const result = parseThumbsRating("+1");
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("up");
  });

  test("detects -1", () => {
    const result = parseThumbsRating("-1");
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("down");
  });

  test("returns null for non-thumbs messages", () => {
    expect(parseThumbsRating("great work")).toBeNull();
    expect(parseThumbsRating("check logs")).toBeNull();
  });

  test("respects config scores", () => {
    const config: AgentGritConfig = {
      signalDir: "/tmp",
      adapter: "local",
      rubrics: [],
      rules: { globalBudget: 10, projectBudget: 5, autoPromote: false },
      daemon: { interval: "1h", weeklyDay: "sunday" },
      thresholds: { thumbsUpScore: 8, thumbsDownScore: 3 },
    };
    const up = parseThumbsRating("👍", config);
    expect(up!.score).toBe(8);
    const down = parseThumbsRating("👎", config);
    expect(down!.score).toBe(3);
  });
});

describe("countUninterruptedRuns", () => {
  test("counts 5+ consecutive AI turns without correction", () => {
    const turns: Turn[] = [
      ...Array.from({ length: 6 }, () => ({ role: "assistant" as const, text: "working...", charCount: 10 })),
      { role: "user", text: "looks good", charCount: 10 },
    ];
    expect(countUninterruptedRuns(turns)).toBe(1);
  });

  test("returns 0 for short runs", () => {
    const turns: Turn[] = [
      { role: "assistant", text: "a", charCount: 1 },
      { role: "assistant", text: "b", charCount: 1 },
      { role: "user", text: "ok", charCount: 2 },
    ];
    expect(countUninterruptedRuns(turns)).toBe(0);
  });
});

describe("countShortFrustrated", () => {
  test("counts short user turns after long AI responses", () => {
    const turns: Turn[] = [
      { role: "assistant", text: "x".repeat(300), charCount: 300 },
      { role: "user", text: "what", charCount: 4 },
    ];
    expect(countShortFrustrated(turns)).toBe(1);
  });

  test("excludes approvals", () => {
    const turns: Turn[] = [
      { role: "assistant", text: "x".repeat(300), charCount: 300 },
      { role: "user", text: "yes", charCount: 3 },
    ];
    expect(countShortFrustrated(turns)).toBe(0);
  });
});
