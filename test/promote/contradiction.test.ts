import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { Tier, SCHEMA_VERSION, type Rule } from "../../src/adapters/types";
import { checkContradiction, extractExistingRules, type InferenceFn } from "../../src/promote/contradiction";
import type { InferenceResult } from "../../src/adapters/inference";

const TMP_DIR = join(import.meta.dir, ".tmp-contradiction-test");
const CLAUDE_MD = join(TMP_DIR, "CLAUDE.md");

function makeRule(id: string, text: string): Rule {
  return {
    id,
    text,
    tier: Tier.Global,
    tags: [],
    created: new Date().toISOString(),
    correlationScore: 0,
    sourceSignals: [],
    schemaVersion: SCHEMA_VERSION,
  };
}

const BASE_CLAUDE_MD = `# Config

Some preamble text.

### Rules

- **existing-rule:** This rule already exists
- **no-mocks:** Never mock the database in tests

---

## Other Section

More content here.
`;

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
  Bun.write(CLAUDE_MD, BASE_CLAUDE_MD);
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

function mockInference(output: string, success = true): InferenceFn {
  return async () => ({
    success,
    output,
    latencyMs: 10,
    level: "fast" as const,
    provider: "claude" as const,
  });
}

function throwingInference(): InferenceFn {
  return async () => { throw new Error("CLI not found"); };
}

describe("extractExistingRules", () => {
  test("extracts rule text from CLAUDE.md format", () => {
    const rules = extractExistingRules(BASE_CLAUDE_MD);
    expect(rules).toEqual([
      "This rule already exists",
      "Never mock the database in tests",
    ]);
  });

  test("returns empty array when no rules exist", () => {
    const rules = extractExistingRules("# No rules\n\nJust text.");
    expect(rules).toEqual([]);
  });
});

describe("checkContradiction", () => {
  test("returns no conflict when no existing rules", async () => {
    const result = await checkContradiction("Some new rule", []);
    expect(result.hasConflict).toBe(false);
  });

  test("detects conflict when inference returns CONFLICT", async () => {
    const result = await checkContradiction(
      "Always mock databases",
      ["Never mock the database in tests"],
      mockInference("CONFLICT: Never mock the database in tests"),
    );
    expect(result.hasConflict).toBe(true);
    expect(result.conflictingRule).toBe("Never mock the database in tests");
    expect(result.details).toContain("Always mock databases");
    expect(result.details).toContain("Never mock the database in tests");
  });

  test("returns no conflict when inference returns NO_CONFLICT", async () => {
    const result = await checkContradiction(
      "Use descriptive variable names",
      ["Never mock the database in tests"],
      mockInference("NO_CONFLICT"),
    );
    expect(result.hasConflict).toBe(false);
  });

  test("falls back gracefully when inference fails", async () => {
    const result = await checkContradiction(
      "Some rule",
      ["Existing rule"],
      mockInference("Connection refused", false),
    );
    expect(result.hasConflict).toBe(false);
  });

  test("falls back gracefully when inference throws", async () => {
    const result = await checkContradiction(
      "Some rule",
      ["Existing rule"],
      throwingInference(),
    );
    expect(result.hasConflict).toBe(false);
  });

  test("passes candidate and existing rules in prompt", async () => {
    let capturedPrompt = "";
    const capturingInference: InferenceFn = async (opts) => {
      capturedPrompt = opts.userPrompt;
      return { success: true, output: "NO_CONFLICT", latencyMs: 10, level: "fast", provider: "claude" };
    };

    await checkContradiction(
      "New rule text",
      ["Rule A", "Rule B"],
      capturingInference,
    );

    expect(capturedPrompt).toContain("New rule text");
    expect(capturedPrompt).toContain("1. Rule A");
    expect(capturedPrompt).toContain("2. Rule B");
  });

  test("uses fast inference level", async () => {
    let capturedLevel = "";
    const capturingInference: InferenceFn = async (opts) => {
      capturedLevel = opts.level || "";
      return { success: true, output: "NO_CONFLICT", latencyMs: 10, level: "fast", provider: "claude" };
    };

    await checkContradiction("Rule", ["Existing"], capturingInference);
    expect(capturedLevel).toBe("fast");
  });
});
