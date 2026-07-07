import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  getStepsForSkill,
  loadPatterns,
  getFailurePatterns,
  formatAsReminder,
  type PatternsFile,
} from "../../src/capture/failure-surfacing";

const TEST_DIR = "/tmp/agentgrit-failure-surfacing-test-" + process.pid;

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("getStepsForSkill", () => {
  test("maps ship to SCOPE, EXECUTION, VERIFICATION", () => {
    expect(getStepsForSkill("ship")).toEqual(["SCOPE", "EXECUTION", "VERIFICATION"]);
  });

  test("maps goal to GOAL", () => {
    expect(getStepsForSkill("goal")).toEqual(["GOAL"]);
  });

  test("maps Research to RESEARCH", () => {
    expect(getStepsForSkill("Research")).toEqual(["RESEARCH"]);
  });

  test("maps research-and-api-investigation to RESEARCH", () => {
    expect(getStepsForSkill("research-and-api-investigation")).toEqual(["RESEARCH"]);
  });

  test("returns empty for unknown skill", () => {
    expect(getStepsForSkill("unknown-skill")).toEqual([]);
  });
});

describe("loadPatterns", () => {
  test("loads valid patterns.json", () => {
    const file = join(TEST_DIR, "patterns.json");
    const data: PatternsFile = {
      step_patterns: {
        SCOPE: {
          patterns: [
            { description: "Missing ACs", count: 5, last_seen: "2026-07-01" },
          ],
        },
      },
    };
    writeFileSync(file, JSON.stringify(data));

    const result = loadPatterns(file);
    expect(result).not.toBeNull();
    expect(result!.step_patterns!["SCOPE"].patterns).toHaveLength(1);
  });

  test("returns null for missing file", () => {
    expect(loadPatterns("/tmp/nonexistent-" + Date.now())).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    const file = join(TEST_DIR, "bad.json");
    writeFileSync(file, "not json");
    expect(loadPatterns(file)).toBeNull();
  });
});

describe("getFailurePatterns", () => {
  function writePatterns(data: PatternsFile): string {
    const file = join(TEST_DIR, "patterns.json");
    writeFileSync(file, JSON.stringify(data));
    return file;
  }

  test("extracts top 3 patterns per step sorted by count", () => {
    const file = writePatterns({
      step_patterns: {
        SCOPE: {
          patterns: [
            { description: "Pattern A", count: 2, last_seen: "2026-07-01" },
            { description: "Pattern B", count: 10, last_seen: "2026-07-01" },
            { description: "Pattern C", count: 5, last_seen: "2026-07-01" },
            { description: "Pattern D", count: 1, last_seen: "2026-07-01" },
          ],
        },
      },
    });

    const result = getFailurePatterns("ship", file);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].step).toBe("SCOPE");
    expect(result.sections[0].top).toHaveLength(3);
    expect(result.sections[0].top[0].description).toBe("Pattern B");
    expect(result.sections[0].top[1].description).toBe("Pattern C");
    expect(result.sections[0].top[2].description).toBe("Pattern A");
    expect(result.sections[0].totalFailures).toBe(18);
  });

  test("returns multiple sections for multi-step skills", () => {
    const file = writePatterns({
      step_patterns: {
        SCOPE: {
          patterns: [{ description: "Scope issue", count: 3, last_seen: "2026-07-01" }],
        },
        EXECUTION: {
          patterns: [{ description: "Exec issue", count: 7, last_seen: "2026-07-01" }],
        },
        VERIFICATION: {
          patterns: [{ description: "Verify issue", count: 2, last_seen: "2026-07-01" }],
        },
      },
    });

    const result = getFailurePatterns("ship", file);
    expect(result.sections).toHaveLength(3);
    expect(result.sections.map((s) => s.step)).toEqual(["SCOPE", "EXECUTION", "VERIFICATION"]);
  });

  test("skips steps with no patterns", () => {
    const file = writePatterns({
      step_patterns: {
        SCOPE: { patterns: [] },
        EXECUTION: {
          patterns: [{ description: "Exec issue", count: 3, last_seen: "2026-07-01" }],
        },
      },
    });

    const result = getFailurePatterns("ship", file);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].step).toBe("EXECUTION");
  });

  test("returns empty for unknown skill", () => {
    const file = writePatterns({
      step_patterns: {
        SCOPE: {
          patterns: [{ description: "Issue", count: 3, last_seen: "2026-07-01" }],
        },
      },
    });

    const result = getFailurePatterns("unknown", file);
    expect(result.sections).toHaveLength(0);
    expect(result.text).toBe("");
  });

  test("returns empty for missing file", () => {
    const result = getFailurePatterns("ship", "/tmp/nonexistent-" + Date.now());
    expect(result.sections).toHaveLength(0);
  });

  test("returns empty when no step_patterns key", () => {
    const file = writePatterns({});
    const result = getFailurePatterns("ship", file);
    expect(result.sections).toHaveLength(0);
  });

  test("includes count info in text output", () => {
    const file = writePatterns({
      step_patterns: {
        GOAL: {
          patterns: [{ description: "Bad goals", count: 5, last_seen: "2026-07-01" }],
        },
      },
    });

    const result = getFailurePatterns("goal", file);
    expect(result.text).toContain("GOAL (5 prior failures)");
    expect(result.text).toContain("#1: Bad goals -- 5x");
    expect(result.text).toContain("Check each pattern before reporting done.");
  });
});

describe("formatAsReminder", () => {
  test("wraps in system-reminder tags", () => {
    const result = {
      sections: [
        {
          step: "SCOPE",
          totalFailures: 5,
          top: [{ description: "Test", count: 5, last_seen: "2026-07-01" }],
        },
      ],
      text: "HARNESS FAILURE PATTERNS:\n\nSCOPE (5 prior failures):\n  #1: Test -- 5x\n\nCheck each pattern before reporting done.",
    };

    const reminder = formatAsReminder(result);
    expect(reminder).toContain("<system-reminder>");
    expect(reminder).toContain("</system-reminder>");
    expect(reminder).toContain("HARNESS FAILURE PATTERNS");
  });

  test("returns empty string for no sections", () => {
    expect(formatAsReminder({ sections: [], text: "" })).toBe("");
  });
});
