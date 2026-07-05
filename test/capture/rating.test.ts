import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  captureRating,
  parseRating,
  scoreSentiment,
  computeComposite,
  truncatePreview,
  cacheLastResponse,
  writeLastResponse,
  wordOverlapRatio,
  scoreSession,
  captureSessionSentiment,
} from "../../src/capture/rating";
import type { Turn } from "../../src/capture/rating";

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
  test("writes sentiment signal for non-empty turns", async () => {
    const turns: Turn[] = [
      { role: "user", text: "fix the bug", charCount: 11 },
      { role: "assistant", text: "Fixed.", charCount: 6 },
      { role: "user", text: "perfect, great work", charCount: 19 },
    ];

    const signal = await captureSessionSentiment(turns, "test-session");
    expect(signal).not.toBeNull();
    expect(signal!.type).toBe("sentiment");
    expect(signal!.source).toBe("transcript-analysis");
    expect(signal!.rating).toBeGreaterThan(0);
    expect(signal!.confidence).toBeGreaterThan(0);
  });

  test("returns null for empty turns", async () => {
    const signal = await captureSessionSentiment([], "test-session");
    expect(signal).toBeNull();
  });

  test("attaches correction and approval counts", async () => {
    const turns: Turn[] = [
      { role: "assistant", text: "I refactored it.", charCount: 16 },
      { role: "user", text: "wrong, just fix the bug", charCount: 23 },
      { role: "assistant", text: "Fixed.", charCount: 6 },
      { role: "user", text: "perfect", charCount: 7 },
    ];

    const signal = await captureSessionSentiment(turns, "test-session");
    expect(signal).not.toBeNull();
    expect(signal!.corrections).toBe(1);
    expect(signal!.approvals).toBe(1);
  });
});
