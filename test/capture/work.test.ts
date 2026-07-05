import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { generateWorkInsights } from "../../src/capture/work";
import type { InferenceOptions, InferenceResult } from "../../src/adapters/inference";
import type { WorkLearning } from "../../src/capture/corrections";

const TEST_DIR = "/tmp/agentgrit-work-test-" + process.pid;

function makeLearning(overrides?: Partial<WorkLearning>): WorkLearning {
  return {
    id: `learning-${Math.random().toString(36).slice(2, 8)}`,
    category: "approach",
    title: "Fix authentication bug",
    filesChanged: 3,
    toolsUsed: ["Read", "Edit", "Bash"],
    insights: ["Touched 3 files", "Session duration: 45m"],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function mockInference(response: { name: string; description: string; insight: string }): (opts: InferenceOptions) => Promise<InferenceResult> {
  return async () => ({
    success: true,
    output: JSON.stringify(response),
    parsed: response,
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
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("generateWorkInsights", () => {
  test("writes work_*.md files with correct frontmatter", async () => {
    const learning = makeLearning();
    const infer = mockInference({
      name: "auth-session-fix",
      description: "Authentication debugging requires session state check first",
      insight: "Always verify session state before debugging auth issues. Check token expiry, cookie state, and OAuth flow before diving into code.",
    });

    const result = await generateWorkInsights([learning], TEST_DIR, infer);

    expect(result.filesWritten.length).toBe(1);
    expect(result.errors).toEqual([]);

    const filepath = result.filesWritten[0];
    expect(filepath).toContain("work_");
    expect(filepath).toEndWith(".md");

    const content = readFileSync(filepath, "utf-8");
    expect(content).toContain("name: auth-session-fix");
    expect(content).toContain("type: work-insight");
    expect(content).toContain("category: approach");
    expect(content).toContain("Authentication debugging");
  });

  test("falls back to deterministic insights when inference fails", async () => {
    const learning = makeLearning();
    const result = await generateWorkInsights([learning], TEST_DIR, mockFailingInference());

    expect(result.filesWritten.length).toBe(0);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("inference failed");
  });

  test("skips already-generated learnings", async () => {
    const learning = makeLearning({ id: "fixed-id-123" });
    const infer = mockInference({
      name: "test-insight",
      description: "Test insight",
      insight: "Test content",
    });

    const result1 = await generateWorkInsights([learning], TEST_DIR, infer);
    expect(result1.filesWritten.length).toBe(1);

    const result2 = await generateWorkInsights([learning], TEST_DIR, infer);
    expect(result2.filesWritten.length).toBe(0);
  });

  test("creates memory directory if it does not exist", async () => {
    const newDir = join(TEST_DIR, "subdir", "memory");
    const learning = makeLearning();
    const infer = mockInference({
      name: "test",
      description: "Test",
      insight: "Test insight",
    });

    await generateWorkInsights([learning], newDir, infer);
    expect(existsSync(newDir)).toBe(true);
  });

  test("processes multiple learnings", async () => {
    const learnings = [
      makeLearning({ id: "l1", title: "Fix bug A" }),
      makeLearning({ id: "l2", title: "Fix bug B" }),
      makeLearning({ id: "l3", title: "Fix bug C" }),
    ];

    let callCount = 0;
    const infer = async (_opts: InferenceOptions): Promise<InferenceResult> => {
      callCount++;
      return {
        success: true,
        output: "{}",
        parsed: {
          name: `insight-${callCount}`,
          description: `Insight ${callCount}`,
          insight: `Learning from call ${callCount}`,
        },
        latencyMs: 10,
        level: "fast" as const,
        provider: "claude" as const,
      };
    };

    const result = await generateWorkInsights(learnings, TEST_DIR, infer);
    expect(result.filesWritten.length).toBe(3);
    expect(callCount).toBe(3);

    const workFiles = readdirSync(TEST_DIR).filter((f) => f.startsWith("work_"));
    expect(workFiles.length).toBe(3);
  });

  test("handles inference throwing an exception", async () => {
    const learning = makeLearning();
    const throwingInfer = async (): Promise<InferenceResult> => {
      throw new Error("network timeout");
    };

    const result = await generateWorkInsights([learning], TEST_DIR, throwingInfer);
    expect(result.filesWritten.length).toBe(0);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("network timeout");
  });

  test("tooling category is preserved in frontmatter", async () => {
    const learning = makeLearning({ category: "tooling" });
    const infer = mockInference({
      name: "tooling-issue",
      description: "Tooling insight",
      insight: "Check tool versions before debugging",
    });

    const result = await generateWorkInsights([learning], TEST_DIR, infer);
    expect(result.filesWritten.length).toBe(1);

    const content = readFileSync(result.filesWritten[0], "utf-8");
    expect(content).toContain("category: tooling");
  });
});
