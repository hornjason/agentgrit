import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { promoteRule, removeRule } from "../../src/promote/bridge";
import { Tier, SCHEMA_VERSION, type Rule } from "../../src/adapters/types";

const TMP_DIR = join(import.meta.dir, ".tmp-bridge-test");
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

describe("promoteRule", () => {
  test("inserts rule after existing rules in section", async () => {
    await promoteRule(makeRule("new-rule", "A new behavioral rule"), CLAUDE_MD);
    const content = readFileSync(CLAUDE_MD, "utf-8");
    expect(content).toContain("- **new-rule:** A new behavioral rule");
    expect(content).toContain("- **existing-rule:");
    expect(content.indexOf("existing-rule")).toBeLessThan(
      content.indexOf("new-rule"),
    );
  });

  test("preserves content before and after rules section", async () => {
    await promoteRule(makeRule("r1", "Test rule"), CLAUDE_MD);
    const content = readFileSync(CLAUDE_MD, "utf-8");
    expect(content).toContain("Some preamble text.");
    expect(content).toContain("## Other Section");
    expect(content).toContain("More content here.");
  });

  test("uses atomic write (temp file then rename)", async () => {
    await promoteRule(makeRule("r1", "Test"), CLAUDE_MD);
    const tmpFiles = readFileSync(CLAUDE_MD, "utf-8");
    expect(tmpFiles).not.toContain(".tmp.");
    expect(existsSync(CLAUDE_MD)).toBe(true);
  });

  test("throws when CLAUDE.md does not exist", async () => {
    const badPath = join(TMP_DIR, "nonexistent", "CLAUDE.md");
    expect(
      promoteRule(makeRule("r1", "Test"), badPath),
    ).rejects.toThrow("not found");
  });

  test("throws when rules section marker is missing", async () => {
    await Bun.write(CLAUDE_MD, "# No rules section here\n\nJust text.");
    expect(
      promoteRule(makeRule("r1", "Test"), CLAUDE_MD),
    ).rejects.toThrow("rules section");
  });

  test("handles ## Rules fallback marker", async () => {
    await Bun.write(
      CLAUDE_MD,
      "# Config\n\n## Rules\n\n- **old:** Old rule\n\n## End\n",
    );
    await promoteRule(makeRule("new", "New rule"), CLAUDE_MD);
    const content = readFileSync(CLAUDE_MD, "utf-8");
    expect(content).toContain("- **new:** New rule");
  });
});

describe("removeRule", () => {
  test("removes rule line from CLAUDE.md", async () => {
    await removeRule("existing-rule", CLAUDE_MD);
    const content = readFileSync(CLAUDE_MD, "utf-8");
    expect(content).not.toContain("existing-rule");
  });

  test("preserves other content when removing", async () => {
    await promoteRule(makeRule("keep-me", "Kept rule"), CLAUDE_MD);
    await removeRule("existing-rule", CLAUDE_MD);
    const content = readFileSync(CLAUDE_MD, "utf-8");
    expect(content).toContain("keep-me");
    expect(content).not.toContain("existing-rule");
  });

  test("throws when rule ID not found", async () => {
    expect(
      removeRule("nonexistent-rule", CLAUDE_MD),
    ).rejects.toThrow("not found");
  });

  test("throws when CLAUDE.md does not exist", async () => {
    const badPath = join(TMP_DIR, "missing.md");
    expect(
      removeRule("any-rule", badPath),
    ).rejects.toThrow("not found");
  });
});
