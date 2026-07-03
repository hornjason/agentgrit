import { describe, expect, test } from "bun:test";
import { join } from "path";
import { composeRubrics, loadRubric, validateRubric } from "../../src/evaluate/rubric";
import type { RubricConfig } from "../../src/adapters/types";

const STARTER_PATH = join(import.meta.dir, "../../rubrics/starter.json");

describe("validateRubric", () => {
  test("valid rubric passes", () => {
    const rubric: RubricConfig = {
      version: "1.0",
      schemaVersion: 1,
      dimensions: [
        { name: "accuracy", description: "test", weight: 0.5, rubric: "Score 1-5" },
        { name: "conciseness", description: "test", weight: 0.5, rubric: "Score 1-5" },
      ],
      judgeModel: "gemini-2.5-flash",
    };
    const result = validateRubric(rubric);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("empty dimensions fails", () => {
    const rubric: RubricConfig = {
      version: "1.0",
      schemaVersion: 1,
      dimensions: [],
      judgeModel: "gemini-2.5-flash",
    };
    const result = validateRubric(rubric);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("dimensions must not be empty");
  });

  test("missing dimension name fails", () => {
    const rubric: RubricConfig = {
      version: "1.0",
      schemaVersion: 1,
      dimensions: [
        { name: "", description: "test", weight: 1.0, rubric: "Score 1-5" },
      ],
      judgeModel: "gemini-2.5-flash",
    };
    const result = validateRubric(rubric);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("name"))).toBe(true);
  });

  test("duplicate dimension names fails", () => {
    const rubric: RubricConfig = {
      version: "1.0",
      schemaVersion: 1,
      dimensions: [
        { name: "accuracy", description: "test", weight: 0.5, rubric: "Score 1-5" },
        { name: "accuracy", description: "test2", weight: 0.5, rubric: "Score 1-5" },
      ],
      judgeModel: "gemini-2.5-flash",
    };
    const result = validateRubric(rubric);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("duplicate"))).toBe(true);
  });

  test("weights not summing to 1.0 fails", () => {
    const rubric: RubricConfig = {
      version: "1.0",
      schemaVersion: 1,
      dimensions: [
        { name: "a", description: "test", weight: 0.3, rubric: "Score 1-5" },
        { name: "b", description: "test", weight: 0.3, rubric: "Score 1-5" },
      ],
      judgeModel: "gemini-2.5-flash",
    };
    const result = validateRubric(rubric);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("weights sum"))).toBe(true);
  });

  test("missing judgeModel fails", () => {
    const rubric = {
      version: "1.0",
      schemaVersion: 1,
      dimensions: [
        { name: "a", description: "test", weight: 1.0, rubric: "Score 1-5" },
      ],
    } as unknown as RubricConfig;
    const result = validateRubric(rubric);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("judgeModel"))).toBe(true);
  });
});

describe("loadRubric", () => {
  test("loads starter.json successfully", () => {
    const rubric = loadRubric(STARTER_PATH);
    expect(rubric.version).toBe("1.0");
    expect(rubric.dimensions.length).toBe(4);
    expect(rubric.dimensions.map((d) => d.name)).toContain("task-completion");
    expect(rubric.dimensions.map((d) => d.name)).toContain("accuracy");
  });

  test("throws for nonexistent file", () => {
    expect(() => loadRubric("/tmp/nonexistent-rubric.json")).toThrow("not found");
  });
});

describe("composeRubrics", () => {
  test("composes two rubrics, later overrides shared dimensions", () => {
    const base: RubricConfig = {
      version: "1.0",
      schemaVersion: 1,
      dimensions: [
        { name: "accuracy", description: "base", weight: 0.5, rubric: "base rubric" },
        { name: "safety", description: "base", weight: 0.5, rubric: "base safety" },
      ],
      judgeModel: "gemini-2.5-flash",
    };
    const custom: RubricConfig = {
      version: "1.0",
      schemaVersion: 1,
      dimensions: [
        { name: "accuracy", description: "custom", weight: 0.6, rubric: "custom rubric" },
        { name: "tone", description: "custom", weight: 0.4, rubric: "custom tone" },
      ],
      judgeModel: "claude-sonnet-5",
    };
    const composed = composeRubrics(base, custom);
    expect(composed.dimensions).toHaveLength(3);
    expect(composed.judgeModel).toBe("claude-sonnet-5");
    const accuracyDim = composed.dimensions.find((d) => d.name === "accuracy");
    expect(accuracyDim?.rubric).toBe("custom rubric");
    const names = composed.dimensions.map((d) => d.name);
    expect(names).toContain("safety");
    expect(names).toContain("tone");
    const totalWeight = composed.dimensions.reduce((s, d) => s + d.weight, 0);
    expect(Math.abs(totalWeight - 1.0)).toBeLessThan(0.01);
  });

  test("throws with zero rubrics", () => {
    expect(() => composeRubrics()).toThrow("at least one rubric");
  });

  test("single rubric normalizes weights", () => {
    const rubric: RubricConfig = {
      version: "1.0",
      schemaVersion: 1,
      dimensions: [
        { name: "a", description: "test", weight: 0.3, rubric: "r" },
        { name: "b", description: "test", weight: 0.7, rubric: "r" },
      ],
      judgeModel: "test-model",
    };
    const composed = composeRubrics(rubric);
    const totalWeight = composed.dimensions.reduce((s, d) => s + d.weight, 0);
    expect(Math.abs(totalWeight - 1.0)).toBeLessThan(0.01);
  });
});
