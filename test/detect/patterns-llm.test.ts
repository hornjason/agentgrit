import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { appendSignal } from "../../src/adapters/jsonl";
import { minePatterns } from "../../src/detect/patterns";
import type { InferenceOptions, InferenceResult } from "../../src/adapters/inference";
import type { CorrectionSignal } from "../../src/adapters/types";
import { SCHEMA_VERSION } from "../../src/adapters/types";

const TMP_DIR = join(import.meta.dir, ".tmp-patterns-llm-test");

function makeCorrection(id: string, sessionId: string, phrase: string): CorrectionSignal {
  return {
    id,
    type: "correction",
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    schemaVersion: SCHEMA_VERSION,
    correction_phrase: phrase,
    context: `Context for ${phrase}`,
  };
}

function mockInference(clusters: unknown[]): (opts: InferenceOptions) => Promise<InferenceResult> {
  return async () => ({
    success: true,
    output: JSON.stringify(clusters),
    parsed: clusters,
    latencyMs: 10,
    level: "fast" as const,
    provider: "claude" as const,
  });
}

function mockFailingInference(): (opts: InferenceOptions) => Promise<InferenceResult> {
  return async () => ({
    success: false,
    output: "",
    error: "inference unavailable",
    latencyMs: 0,
    level: "fast" as const,
    provider: "claude" as const,
  });
}

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

describe("minePatterns LLM mode", () => {
  test("LLM mode finds additional semantic cluster patterns", async () => {
    const correctionsFile = join(TMP_DIR, "corrections.jsonl");
    for (let i = 0; i < 5; i++) {
      await appendSignal(correctionsFile, makeCorrection(`c${i}`, `sess-${i}`, "wrong approach taken"));
    }

    const clusters = [
      { theme: "scope-creep", description: "Agent frequently exceeds task scope", severity: 7, phrases: ["wrong approach taken", "too much"] },
      { theme: "missing-verify", description: "Assertions made without verification", severity: 8, phrases: ["didn't check", "assumed"] },
    ];

    const patterns = await minePatterns(TMP_DIR, { llm: true, infer: mockInference(clusters) });

    const llmPatterns = patterns.filter((p) => p.type === "llm-semantic-cluster");
    expect(llmPatterns.length).toBe(2);
    expect(llmPatterns[0].id).toContain("llm-cluster-");
    expect(llmPatterns[0].candidateRule).toBeTruthy();
  });

  test("without LLM mode, no semantic cluster patterns are returned", async () => {
    const correctionsFile = join(TMP_DIR, "corrections.jsonl");
    for (let i = 0; i < 5; i++) {
      await appendSignal(correctionsFile, makeCorrection(`c${i}`, `sess-${i}`, "wrong approach"));
    }

    const patterns = await minePatterns(TMP_DIR);
    const llmPatterns = patterns.filter((p) => p.type === "llm-semantic-cluster");
    expect(llmPatterns.length).toBe(0);
  });

  test("LLM mode falls back gracefully when inference fails", async () => {
    const correctionsFile = join(TMP_DIR, "corrections.jsonl");
    for (let i = 0; i < 5; i++) {
      await appendSignal(correctionsFile, makeCorrection(`c${i}`, `sess-${i}`, "wrong approach"));
    }

    const patterns = await minePatterns(TMP_DIR, { llm: true, infer: mockFailingInference() });
    const llmPatterns = patterns.filter((p) => p.type === "llm-semantic-cluster");
    expect(llmPatterns.length).toBe(0);
  });

  test("LLM patterns are merged with rule-based and deduped", async () => {
    const correctionsFile = join(TMP_DIR, "corrections.jsonl");
    const ratingsFile = join(TMP_DIR, "ratings.jsonl");
    const skillsFile = join(TMP_DIR, "skills.jsonl");

    for (let i = 0; i < 3; i++) {
      await appendSignal(correctionsFile, makeCorrection(`c${i}`, `sess-${i}`, "wrong approach"));
      await appendSignal(ratingsFile, {
        id: `r${i}`,
        type: "rating",
        timestamp: new Date().toISOString(),
        session_id: `sess-${i}`,
        schemaVersion: SCHEMA_VERSION,
        rating: 3,
        source: "explicit",
      });
      await appendSignal(skillsFile, {
        id: `s${i}`,
        type: "skill-invocation",
        timestamp: new Date().toISOString(),
        session_id: `sess-${i}`,
        schemaVersion: SCHEMA_VERSION,
        skill: "ship",
      });
    }

    const clusters = [
      { theme: "scope-issue", description: "Scope problems", severity: 6, phrases: ["wrong approach"] },
    ];

    const patterns = await minePatterns(TMP_DIR, { llm: true, infer: mockInference(clusters) });

    const ruleBasedTypes = patterns.filter((p) => p.type !== "llm-semantic-cluster");
    const llmTypes = patterns.filter((p) => p.type === "llm-semantic-cluster");

    expect(ruleBasedTypes.length).toBeGreaterThan(0);
    expect(llmTypes.length).toBe(1);

    for (let i = 1; i < patterns.length; i++) {
      expect(patterns[i].severity).toBeLessThanOrEqual(patterns[i - 1].severity);
    }
  });

  test("LLM mode with fewer than 3 corrections skips clustering", async () => {
    const correctionsFile = join(TMP_DIR, "corrections.jsonl");
    await appendSignal(correctionsFile, makeCorrection("c1", "sess-1", "wrong"));

    let called = false;
    const trackingInfer = async (_opts: InferenceOptions): Promise<InferenceResult> => {
      called = true;
      return { success: true, output: "[]", parsed: [], latencyMs: 10, level: "fast", provider: "claude" };
    };

    await minePatterns(TMP_DIR, { llm: true, infer: trackingInfer });
    expect(called).toBe(false);
  });

  test("severity is clamped to 1-10 range", async () => {
    const correctionsFile = join(TMP_DIR, "corrections.jsonl");
    for (let i = 0; i < 5; i++) {
      await appendSignal(correctionsFile, makeCorrection(`c${i}`, `sess-${i}`, "bad approach"));
    }

    const clusters = [
      { theme: "over-severity", description: "Test", severity: 15, phrases: ["bad"] },
      { theme: "under-severity", description: "Test", severity: -3, phrases: ["bad"] },
    ];

    const patterns = await minePatterns(TMP_DIR, { llm: true, infer: mockInference(clusters) });
    const llmPatterns = patterns.filter((p) => p.type === "llm-semantic-cluster");

    for (const p of llmPatterns) {
      expect(p.severity).toBeGreaterThanOrEqual(1);
      expect(p.severity).toBeLessThanOrEqual(10);
    }
  });

  test("LLM mode handles inference throwing an exception", async () => {
    const correctionsFile = join(TMP_DIR, "corrections.jsonl");
    for (let i = 0; i < 5; i++) {
      await appendSignal(correctionsFile, makeCorrection(`c${i}`, `sess-${i}`, "bad"));
    }

    const throwingInfer = async (): Promise<InferenceResult> => {
      throw new Error("network timeout");
    };

    const patterns = await minePatterns(TMP_DIR, { llm: true, infer: throwingInfer });
    const llmPatterns = patterns.filter((p) => p.type === "llm-semantic-cluster");
    expect(llmPatterns.length).toBe(0);
  });
});
