import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { keywordSentiment } from "../../bin/commands/capture";
import type { InferenceOptions, InferenceResult } from "../../src/adapters/inference";
import { generateHookConfig } from "../../src/capture/index";

const TMP_DIR = join(import.meta.dir, ".tmp-sentiment-test");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

// ── keywordSentiment unit tests ──

describe("keywordSentiment", () => {
  test("returns negative for frustrated keywords", () => {
    expect(keywordSentiment("stop doing that")).toBeLessThan(0);
    expect(keywordSentiment("that's wrong")).toBeLessThan(0);
    expect(keywordSentiment("don't do that")).toBeLessThan(0);
    expect(keywordSentiment("it's broken")).toBeLessThan(0);
  });

  test("returns positive for praise keywords", () => {
    expect(keywordSentiment("great work")).toBeGreaterThan(0);
    expect(keywordSentiment("perfect, exactly what I needed")).toBeGreaterThan(0);
    expect(keywordSentiment("thanks, good job")).toBeGreaterThan(0);
    expect(keywordSentiment("nice")).toBeGreaterThan(0);
  });

  test("returns 0 for neutral text", () => {
    expect(keywordSentiment("refactor the auth module")).toBe(0);
    expect(keywordSentiment("add a new endpoint")).toBe(0);
  });

  test("returns 0 for noise patterns like 'no problem'", () => {
    expect(keywordSentiment("no problem")).toBe(0);
    expect(keywordSentiment("no worries")).toBe(0);
    expect(keywordSentiment("no rush")).toBe(0);
  });

  test("clamps between -1 and 1", () => {
    const veryNegative = keywordSentiment("stop wrong broken bug fix don't");
    expect(veryNegative).toBeGreaterThanOrEqual(-1);
    expect(veryNegative).toBeLessThanOrEqual(1);

    const veryPositive = keywordSentiment("great perfect exactly good thanks nice");
    expect(veryPositive).toBeGreaterThanOrEqual(-1);
    expect(veryPositive).toBeLessThanOrEqual(1);
  });
});

// ── captureSentimentCommand integration (via dynamic import) ──

// We import the capture module dynamically to inject mock stdin
// Instead, test the exported function directly with a mock inference

describe("captureSentimentCommand", () => {
  // The captureSentimentCommand reads from stdin which is hard to mock in tests.
  // We test the components: keywordSentiment (above) and the inference flow via
  // the DI parameter. We'll re-import and call with a mock.

  // For the integration test, we use the module's internal function directly.
  // Since captureSentimentCommand is not exported, we test through the pipeline.

  test("keyword fallback produces valid score range", () => {
    const scores = [
      keywordSentiment("this is broken and wrong"),
      keywordSentiment("perfect, great work"),
      keywordSentiment("just do X"),
    ];
    for (const s of scores) {
      expect(s).toBeGreaterThanOrEqual(-1);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  test("mixed sentiment averages correctly", () => {
    const score = keywordSentiment("thanks for the fix");
    // "thanks" is positive (+1), "fix" is negative (-1), avg = 0
    expect(score).toBe(0);
  });
});

// ── Hook config includes sentiment ──

describe("hook config", () => {
  test("includes sentiment hook in UserPromptSubmit", () => {
    const config = generateHookConfig();
    const upsHooks = config.hooks.UserPromptSubmit;
    expect(upsHooks).toBeDefined();

    const sentimentHook = upsHooks.find((h) => h.command.includes("sentiment"));
    expect(sentimentHook).toBeDefined();
    expect(sentimentHook!.command).toContain("sentiment");
  });

  test("UserPromptSubmit has 3 hooks (rating, correction, sentiment)", () => {
    const config = generateHookConfig();
    expect(config.hooks.UserPromptSubmit).toHaveLength(3);
  });
});

// ── Sentiment JSONL record shape ──

describe("sentiment record shape", () => {
  test("keywordSentiment returns number type", () => {
    const score = keywordSentiment("good job");
    expect(typeof score).toBe("number");
  });
});
