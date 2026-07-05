import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import type { RatingSignal } from "../../src/adapters/types";
import type { InferenceFn } from "../../src/daemon/feedback";
import type { InferenceResult } from "../../src/adapters/inference";

const TEST_DIR = "/tmp/agentgrit-feedback-test-" + process.pid;
const MEMORY_DIR = join(TEST_DIR, "memory");

function makeRating(overrides: Partial<RatingSignal> = {}): RatingSignal {
  return {
    type: "rating",
    timestamp: new Date().toISOString(),
    session_id: "sess-" + Math.random().toString(36).slice(2, 8),
    rating: 5,
    source: "explicit",
    ...overrides,
  };
}

function mockInfer(parsed: Record<string, unknown>): InferenceFn {
  return async () => ({
    success: true,
    output: JSON.stringify(parsed),
    parsed,
    latencyMs: 50,
    level: "fast",
    provider: "claude",
  }) as InferenceResult;
}

function failingInfer(error: string): InferenceFn {
  return async () => ({
    success: false,
    output: "",
    error,
    latencyMs: 0,
    level: "fast",
    provider: "claude",
  }) as InferenceResult;
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(MEMORY_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("generateFeedback", () => {
  test("skips sessions with avg rating > 4", async () => {
    const { generateFeedback } = await import("../../src/daemon/feedback");
    const ratings = [
      makeRating({ session_id: "s1", rating: 7, comment: "good session" }),
      makeRating({ session_id: "s2", rating: 5, comment: "ok session" }),
    ];

    const result = await generateFeedback(ratings, MEMORY_DIR);
    expect(result.filesWritten).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test("skips sessions without comments", async () => {
    const { generateFeedback } = await import("../../src/daemon/feedback");
    const ratings = [
      makeRating({ session_id: "s1", rating: 2 }),
      makeRating({ session_id: "s1", rating: 3 }),
    ];

    const result = await generateFeedback(ratings, MEMORY_DIR);
    expect(result.filesWritten).toHaveLength(0);
  });

  test("writes feedback file for sessions with avg rating <= 4", async () => {
    const { generateFeedback } = await import("../../src/daemon/feedback");
    const infer = mockInfer({
      name: "test-lesson",
      description: "Test desc",
      lesson: "Test lesson text",
    });

    const ratings = [
      makeRating({ session_id: "low-sess", rating: 2, comment: "terrible output" }),
      makeRating({ session_id: "low-sess", rating: 3, comment: "still bad" }),
    ];

    const result = await generateFeedback(ratings, MEMORY_DIR, infer);
    expect(result.filesWritten).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  test("writes feedback file with correct frontmatter structure", async () => {
    const { generateFeedback } = await import("../../src/daemon/feedback");
    const infer = mockInfer({
      name: "verify-before-assert",
      description: "Always verify first",
      lesson: "Check before claiming",
    });

    const ratings = [
      makeRating({ session_id: "bad-sess", rating: 2, comment: "wrong output, didn't verify" }),
    ];

    const result = await generateFeedback(ratings, MEMORY_DIR, infer);
    expect(result.filesWritten).toHaveLength(1);

    const content = readFileSync(result.filesWritten[0], "utf-8");
    expect(content).toContain("name: verify-before-assert");
    expect(content).toContain("description: Always verify first");
    expect(content).toContain("type: feedback");
    expect(content).toContain("source_session: bad-sess");
    expect(content).toContain("Check before claiming");
    expect(result.filesWritten[0]).toContain("feedback_");
    expect(result.filesWritten[0]).toEndWith(".md");
  });

  test("handles inference failure gracefully", async () => {
    const { generateFeedback } = await import("../../src/daemon/feedback");
    const infer = failingInfer("claude CLI not found");

    const ratings = [
      makeRating({ session_id: "err-sess", rating: 1, comment: "bad session" }),
    ];

    const result = await generateFeedback(ratings, MEMORY_DIR, infer);
    expect(result.filesWritten).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("err-sess");
  });

  test("does not re-generate for already processed sessions", async () => {
    const { generateFeedback } = await import("../../src/daemon/feedback");
    let callCount = 0;
    const infer: InferenceFn = async () => {
      callCount++;
      return {
        success: true,
        output: '{"name": "dup-test", "description": "Dup", "lesson": "Dup lesson"}',
        parsed: { name: "dup-test", description: "Dup", lesson: "Dup lesson" },
        latencyMs: 50,
        level: "fast",
        provider: "claude",
      } as InferenceResult;
    };

    const ratings = [
      makeRating({ session_id: "dup-sess", rating: 2, comment: "bad output" }),
    ];

    await generateFeedback(ratings, MEMORY_DIR, infer);
    expect(callCount).toBe(1);

    await generateFeedback(ratings, MEMORY_DIR, infer);
    expect(callCount).toBe(1);
  });

  test("creates memory dir if it does not exist", async () => {
    const { generateFeedback } = await import("../../src/daemon/feedback");
    const newDir = join(TEST_DIR, "new-memory-dir");
    expect(existsSync(newDir)).toBe(false);

    await generateFeedback([], newDir);
    expect(existsSync(newDir)).toBe(true);
  });
});

describe("generateSuccess", () => {
  test("skips sessions with avg rating < 8", async () => {
    const { generateSuccess } = await import("../../src/daemon/feedback");
    const ratings = [
      makeRating({ session_id: "s1", rating: 5, comment: "ok session" }),
      makeRating({ session_id: "s2", rating: 7, comment: "good but not great" }),
    ];

    const result = await generateSuccess(ratings, MEMORY_DIR);
    expect(result.filesWritten).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test("skips sessions without comments", async () => {
    const { generateSuccess } = await import("../../src/daemon/feedback");
    const ratings = [
      makeRating({ session_id: "s1", rating: 9 }),
      makeRating({ session_id: "s1", rating: 10 }),
    ];

    const result = await generateSuccess(ratings, MEMORY_DIR);
    expect(result.filesWritten).toHaveLength(0);
  });

  test("writes success file with correct frontmatter structure", async () => {
    const { generateSuccess } = await import("../../src/daemon/feedback");
    const infer = mockInfer({
      name: "great-approach",
      description: "Systematic debugging",
      pattern: "Break down into steps",
    });

    const ratings = [
      makeRating({ session_id: "great-sess", rating: 9, comment: "excellent systematic approach" }),
    ];

    const result = await generateSuccess(ratings, MEMORY_DIR, infer);
    expect(result.filesWritten).toHaveLength(1);

    const content = readFileSync(result.filesWritten[0], "utf-8");
    expect(content).toContain("name: great-approach");
    expect(content).toContain("description: Systematic debugging");
    expect(content).toContain("type: success");
    expect(content).toContain("source_session: great-sess");
    expect(content).toContain("Break down into steps");
    expect(result.filesWritten[0]).toContain("success_");
    expect(result.filesWritten[0]).toEndWith(".md");
  });

  test("handles inference failure gracefully", async () => {
    const { generateSuccess } = await import("../../src/daemon/feedback");
    const infer = failingInfer("timeout");

    const ratings = [
      makeRating({ session_id: "timeout-sess", rating: 10, comment: "great session" }),
    ];

    const result = await generateSuccess(ratings, MEMORY_DIR, infer);
    expect(result.filesWritten).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("does not re-generate for already processed sessions", async () => {
    const { generateSuccess } = await import("../../src/daemon/feedback");
    let callCount = 0;
    const infer: InferenceFn = async () => {
      callCount++;
      return {
        success: true,
        output: '{"name": "reuse", "description": "Reuse", "pattern": "Reuse pattern"}',
        parsed: { name: "reuse", description: "Reuse", pattern: "Reuse pattern" },
        latencyMs: 50,
        level: "fast",
        provider: "claude",
      } as InferenceResult;
    };

    const ratings = [
      makeRating({ session_id: "reuse-sess", rating: 9, comment: "amazing session" }),
    ];

    await generateSuccess(ratings, MEMORY_DIR, infer);
    expect(callCount).toBe(1);

    await generateSuccess(ratings, MEMORY_DIR, infer);
    expect(callCount).toBe(1);
  });

  test("creates memory dir if it does not exist", async () => {
    const { generateSuccess } = await import("../../src/daemon/feedback");
    const newDir = join(TEST_DIR, "new-success-dir");
    expect(existsSync(newDir)).toBe(false);

    await generateSuccess([], newDir);
    expect(existsSync(newDir)).toBe(true);
  });
});

describe("session grouping", () => {
  test("groups multiple ratings by session_id and generates for each", async () => {
    const { generateFeedback } = await import("../../src/daemon/feedback");
    let inferCalls = 0;
    const infer: InferenceFn = async () => {
      inferCalls++;
      return {
        success: true,
        output: `{"name": "group-${inferCalls}", "description": "Grouped", "lesson": "Grouped lesson"}`,
        parsed: { name: `group-${inferCalls}`, description: "Grouped", lesson: "Grouped lesson" },
        latencyMs: 50,
        level: "fast",
        provider: "claude",
      } as InferenceResult;
    };

    const ratings = [
      makeRating({ session_id: "low-a", rating: 2, comment: "bad" }),
      makeRating({ session_id: "low-a", rating: 3, comment: "still bad" }),
      makeRating({ session_id: "low-b", rating: 1, comment: "terrible" }),
    ];

    const result = await generateFeedback(ratings, MEMORY_DIR, infer);
    expect(inferCalls).toBe(2);
    expect(result.filesWritten).toHaveLength(2);
  });
});
