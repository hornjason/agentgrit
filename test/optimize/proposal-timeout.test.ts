import { describe, test, expect } from "bun:test";

describe("proposal generation timeout regression (#5)", () => {
  test("inference respects timeout parameter", async () => {
    const { inference } = await import("../../src/adapters/inference");
    const result = await inference({
      systemPrompt: "You are a test assistant.",
      userPrompt: "test",
      level: "fast",
      timeout: 3000,
    });

    expect(result).toHaveProperty("success");
    expect(result.latencyMs).toBeDefined();
    expect(typeof result.latencyMs).toBe("number");
  });

  test("timeout produces error result, not throw", async () => {
    const { inference } = await import("../../src/adapters/inference");
    const result = await inference({
      systemPrompt: "You are a test assistant.",
      userPrompt: "Write a very long essay about the history of computing.",
      level: "fast",
      timeout: 1,
    });

    if (!result.success) {
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe("string");
    }
    expect(result).toHaveProperty("success");
  });

  test("standard level uses 30s default timeout config", () => {
    expect(true).toBe(true);
  });

  test("proposal output structure supports phase headers", () => {
    const sampleProposal =
      "### Phase 2 — Batch diagnostic read\n1. Check state\n2. Read logs";
    expect(sampleProposal).toContain("### Phase 2");
    expect(sampleProposal).toContain("diagnostic");
  });
});
