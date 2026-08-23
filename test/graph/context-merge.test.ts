import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

const TEMP_DIR = join(import.meta.dir, ".tmp-context-merge");

beforeEach(() => {
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true });
  mkdirSync(TEMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true });
});

describe("mergeGraphContextMarkdown", () => {
  test("merges new rules with existing, deduplicating by ID", async () => {
    const { mergeGraphContextMarkdown } = await import("../../src/graph/context");

    const existing = [
      "# Graph Context — testing, delivery",
      "*Generated: 2026-08-22T00:00:00Z | 3 context rules from [testing, delivery]*",
      "",
      "## Context Rules (correlation-ranked)",
      "",
      "- **feedback_rule_a** [testing] (score: 0.85)",
      "  Rule A text here",
      "",
      "- **feedback_rule_b** [delivery] (score: 0.72)",
      "  Rule B text here",
      "",
      "- **feedback_rule_c** [scope] (score: 0.60)",
      "  Rule C text here",
      "",
    ].join("\n");

    const incoming = [
      "# Graph Context — testing",
      "*Generated: 2026-08-22T01:00:00Z | 2 context rules from [testing]*",
      "",
      "## Context Rules (correlation-ranked)",
      "",
      "- **feedback_rule_a** [testing] (score: 0.90)",
      "  Rule A updated text",
      "",
      "- **feedback_rule_d** [config] (score: 0.65)",
      "  Rule D new text",
      "",
    ].join("\n");

    const merged = mergeGraphContextMarkdown(existing, incoming, 15);
    expect(merged).toContain("feedback_rule_a");
    expect(merged).toContain("feedback_rule_b");
    expect(merged).toContain("feedback_rule_c");
    expect(merged).toContain("feedback_rule_d");
    // Incoming version of rule_a should win (newer)
    expect(merged).toContain("Rule A updated text");
    expect(merged).not.toContain("Rule A text here");
  });

  test("skips overwrite when incoming has fewer rules than existing", async () => {
    const { mergeGraphContextMarkdown } = await import("../../src/graph/context");

    const existing = [
      "# Graph Context — testing",
      "*Generated: 2026-08-22T00:00:00Z | 5 context rules from [testing]*",
      "",
      "## Context Rules (correlation-ranked)",
      "",
      "- **rule_1** [t] (score: 0.9)",
      "  text 1",
      "",
      "- **rule_2** [t] (score: 0.8)",
      "  text 2",
      "",
      "- **rule_3** [t] (score: 0.7)",
      "  text 3",
      "",
      "- **rule_4** [t] (score: 0.6)",
      "  text 4",
      "",
      "- **rule_5** [t] (score: 0.5)",
      "  text 5",
      "",
    ].join("\n");

    const incoming = [
      "# Graph Context — testing",
      "*Generated: 2026-08-22T01:00:00Z | 1 context rules from [testing]*",
      "",
      "## Context Rules (correlation-ranked)",
      "",
      "- **rule_1** [t] (score: 0.9)",
      "  text 1",
      "",
    ].join("\n");

    const merged = mergeGraphContextMarkdown(existing, incoming, 15);
    // All 5 existing rules should be preserved
    expect(merged).toContain("rule_1");
    expect(merged).toContain("rule_2");
    expect(merged).toContain("rule_3");
    expect(merged).toContain("rule_4");
    expect(merged).toContain("rule_5");
  });

  test("respects budget cap", async () => {
    const { mergeGraphContextMarkdown } = await import("../../src/graph/context");

    const lines: string[] = [
      "# Graph Context — testing",
      "*Generated: 2026-08-22T00:00:00Z | 3 context rules*",
      "",
      "## Context Rules (correlation-ranked)",
      "",
    ];
    for (let i = 1; i <= 14; i++) {
      lines.push(`- **rule_existing_${i}** [t] (score: ${(0.9 - i * 0.01).toFixed(2)})`);
      lines.push(`  text ${i}`);
      lines.push("");
    }
    const existing = lines.join("\n");

    const incomingLines: string[] = [
      "# Graph Context — testing",
      "*Generated: 2026-08-22T01:00:00Z | 3 context rules*",
      "",
      "## Context Rules (correlation-ranked)",
      "",
    ];
    for (let i = 1; i <= 3; i++) {
      incomingLines.push(`- **rule_new_${i}** [t] (score: ${(0.95 - i * 0.01).toFixed(2)})`);
      incomingLines.push(`  text new ${i}`);
      incomingLines.push("");
    }
    const incoming = incomingLines.join("\n");

    const merged = mergeGraphContextMarkdown(existing, incoming, 15);
    const ruleMatches = merged.match(/- \*\*[^*]+\*\*/g);
    expect(ruleMatches!.length).toBeLessThanOrEqual(15);
  });

  test("handles empty existing file", async () => {
    const { mergeGraphContextMarkdown } = await import("../../src/graph/context");

    const incoming = [
      "# Graph Context — testing",
      "*Generated: 2026-08-22T01:00:00Z | 2 context rules from [testing]*",
      "",
      "## Context Rules (correlation-ranked)",
      "",
      "- **rule_1** [t] (score: 0.90)",
      "  text 1",
      "",
      "- **rule_2** [t] (score: 0.80)",
      "  text 2",
      "",
    ].join("\n");

    const merged = mergeGraphContextMarkdown("", incoming, 15);
    expect(merged).toContain("rule_1");
    expect(merged).toContain("rule_2");
  });
});
