import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  captureSkillInvocation,
  classifyOutcome,
  extractWorkflow,
  captureSkillSequence,
  buildCoOccurrencePairs,
  analyzeSkillSequence,
} from "../../src/capture/skills";

const TMP_DIR = join(import.meta.dir, ".tmp-skills-test");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

describe("classifyOutcome", () => {
  test("hit when trigger contains /skillname", () => {
    expect(classifyOutcome("ship", "/ship fix the bug")).toBe("hit");
  });

  test("hit when trigger contains skill name", () => {
    expect(classifyOutcome("Research", "I need to research this")).toBe("hit");
  });

  test("unknown for unrelated trigger", () => {
    expect(classifyOutcome("ship", "fix the build")).toBe("unknown");
  });

  test("unknown for empty inputs", () => {
    expect(classifyOutcome("", "")).toBe("unknown");
    expect(classifyOutcome("ship", "")).toBe("unknown");
  });
});

describe("extractWorkflow", () => {
  test("extracts workflow: prefix", () => {
    expect(extractWorkflow("workflow: deep-research")).toBe("deep-research");
  });

  test("extracts first word from short args", () => {
    expect(extractWorkflow("deep")).toBe("deep");
  });

  test("returns null for undefined", () => {
    expect(extractWorkflow(undefined)).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(extractWorkflow("")).toBeNull();
  });

  test("returns first word for args with leading word then space", () => {
    // extractWorkflow matches the first word from "word rest..."
    expect(extractWorkflow("deep investigation of API")).toBe("deep");
  });

  test("extracts first word even from long multi-word args", () => {
    // When args have a leading word + space, the first word is extracted
    const longArgs = "deep investigate the full API surface for patterns";
    expect(extractWorkflow(longArgs)).toBe("deep");
  });
});

describe("captureSkillInvocation", () => {
  test("writes signal with correct fields", async () => {
    const signal = await captureSkillInvocation(
      "ship",
      "/ship fix auth bug",
      "test-session",
    );

    expect(signal.type).toBe("skill-invocation");
    expect(signal.skill).toBe("ship");
    expect(signal.session_id).toBe("test-session");

    const filePath = join(TMP_DIR, "signals", "skill-invocations.jsonl");
    expect(existsSync(filePath)).toBe(true);
    const line = readFileSync(filePath, "utf-8").trim();
    const parsed = JSON.parse(line);
    expect(parsed.skill).toBe("ship");
  });

  test("supports optional workflow field", async () => {
    const signal = await captureSkillInvocation(
      "Research",
      "/research deep",
      "test-session",
      "deep-research",
    );
    expect(signal.workflow).toBe("deep-research");
  });

  test("auto-extracts workflow from trigger when not provided", async () => {
    const signal = await captureSkillInvocation(
      "Research",
      "deep",
      "test-session",
    );
    // "deep" is short enough to be treated as workflow
    expect(signal.workflow).toBe("deep");
  });
});

describe("captureSkillSequence", () => {
  test("writes sequence entries for multiple skills", async () => {
    const calls = [
      { skill: "Research", args: "investigate API" },
      { skill: "ship", args: "fix the bug" },
      { skill: "tdd", args: "red-green-refactor" },
    ];

    const entries = await captureSkillSequence(calls, "test-session", 8);
    expect(entries).toHaveLength(3);
    expect(entries[0].skill_name).toBe("Research");
    expect(entries[0].rating).toBe(8);
    expect(entries[2].skill_name).toBe("tdd");

    const filePath = join(TMP_DIR, "signals", "skill-sequences.jsonl");
    expect(existsSync(filePath)).toBe(true);
    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);
  });

  test("handles null rating", async () => {
    const entries = await captureSkillSequence(
      [{ skill: "ship" }],
      "test-session",
      null,
    );
    expect(entries[0].rating).toBeNull();
  });
});

describe("buildCoOccurrencePairs", () => {
  test("builds pairs from unique skills", () => {
    const pairs = buildCoOccurrencePairs(["Research", "ship", "tdd"]);
    expect(pairs).toHaveLength(3);
    // Pairs are alphabetically sorted
    expect(pairs).toContainEqual(["Research", "ship"]);
    expect(pairs).toContainEqual(["Research", "tdd"]);
    expect(pairs).toContainEqual(["ship", "tdd"]);
  });

  test("deduplicates skills before pairing", () => {
    const pairs = buildCoOccurrencePairs(["ship", "ship", "tdd"]);
    expect(pairs).toHaveLength(1);
    expect(pairs).toContainEqual(["ship", "tdd"]);
  });

  test("returns empty for single skill", () => {
    expect(buildCoOccurrencePairs(["ship"])).toHaveLength(0);
  });

  test("returns empty for empty array", () => {
    expect(buildCoOccurrencePairs([])).toHaveLength(0);
  });
});

describe("analyzeSkillSequence", () => {
  test("returns full analysis with skills and pairs", () => {
    const result = analyzeSkillSequence(
      [
        { skill: "Research" },
        { skill: "ship" },
        { skill: "tdd" },
      ],
      "test-session",
      9,
    );

    expect(result.sessionId).toBe("test-session");
    expect(result.skills).toEqual(["Research", "ship", "tdd"]);
    expect(result.pairs.length).toBe(3);
    expect(result.rating).toBe(9);
  });
});
