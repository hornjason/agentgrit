import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  captureSkillInvocation,
  classifyOutcome,
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
});
