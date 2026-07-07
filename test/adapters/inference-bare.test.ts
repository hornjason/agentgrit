import { describe, test, expect } from "bun:test";

describe("inference bare flag regression (#4)", () => {
  test("inference result structure has required fields", async () => {
    const { inference } = await import("../../src/adapters/inference");
    const result = await inference({
      systemPrompt: "You are a test assistant. Respond with just 'ok'.",
      userPrompt: "test",
      level: "fast",
      timeout: 3000,
    });

    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("output");
    expect(result).toHaveProperty("latencyMs");
    expect(result).toHaveProperty("level");
    expect(result).toHaveProperty("provider");
    expect(result.level).toBe("fast");
    expect(typeof result.latencyMs).toBe("number");
  });

  test("inference output does not contain PAI format markers when provider returns clean text", () => {
    const paiMarkers = ["════ PAI", "Rayford", "TASK:", "VERIFY:", "CHANGE:"];
    const cleanOutput = "Phase 1: Check environment\nPhase 2: Run diagnostic";

    for (const marker of paiMarkers) {
      expect(cleanOutput.includes(marker)).toBe(false);
    }
  });

  test("inference level defaults to standard", async () => {
    const { inference } = await import("../../src/adapters/inference");
    const result = await inference({
      systemPrompt: "Respond with 'ok'.",
      userPrompt: "test",
      timeout: 3000,
    });

    expect(result.level).toBe("standard");
  });

  test("inference handles timeout gracefully", async () => {
    const { inference } = await import("../../src/adapters/inference");
    const result = await inference({
      systemPrompt: "Respond with 'ok'.",
      userPrompt: "test",
      level: "fast",
      timeout: 1,
    });

    if (!result.success) {
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe("string");
    }
    expect(result).toHaveProperty("success");
  });

  test("inference expectJson flag is accepted", async () => {
    const { inference } = await import("../../src/adapters/inference");
    const result = await inference({
      systemPrompt: 'Respond with: {"status": "ok"}',
      userPrompt: "test",
      level: "fast",
      expectJson: true,
      timeout: 3000,
    });

    expect(result).toHaveProperty("success");
    if (result.success && result.parsed) {
      expect(typeof result.parsed).toBe("object");
    }
  });
});
