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

  /**
   * The file is headed "Context Rules (correlation-ranked)", and until #258 it
   * was ranked by nothing of the sort: existing entries were inserted first and
   * the budget was sliced off the end, so whatever landed in the file on its
   * first write held the top slots for good. The live
   * ~/.agentgrit/context/GRAPH-CONTEXT.md had carried the same five entries
   * since 2026-10-05 while every freshly-retrieved rule queued up behind them,
   * past the cap. Carry-over is for continuity, not seniority.
   */
  test("this session's ranking leads; carried-over rules fill what is left", async () => {
    const { mergeGraphContextMarkdown } = await import("../../src/graph/context");

    const header = (n: number) => [
      "# Graph Context — testing",
      `*Generated: 2026-08-22T00:00:00Z | ${n} context rules from [testing]*`,
      "",
      "## Context Rules (correlation-ranked)",
      "",
    ];

    const existingLines = header(6);
    for (let i = 1; i <= 6; i++) {
      existingLines.push(`- **rule_stale_${i}** [t] (score: 0.10)`);
      existingLines.push(`  stale text ${i}`);
      existingLines.push("");
    }

    const incomingLines = header(3);
    for (let i = 1; i <= 3; i++) {
      incomingLines.push(`- **rule_fresh_${i}** [t] (score: 0.90)`);
      incomingLines.push(`  fresh text ${i}`);
      incomingLines.push("");
    }

    const merged = mergeGraphContextMarkdown(existingLines.join("\n"), incomingLines.join("\n"), 15);
    const order = [...merged.matchAll(/^- \*\*([^*]+)\*\*/gm)].map(m => m[1]);

    expect(order.slice(0, 3)).toEqual(["rule_fresh_1", "rule_fresh_2", "rule_fresh_3"]);
    // Continuity is kept, just behind this session's own ranking.
    expect(order).toContain("rule_stale_1");
    expect(order.length).toBe(9);
  });

  test("a full file cannot lock new rules out — the cap cuts the oldest", async () => {
    const { mergeGraphContextMarkdown } = await import("../../src/graph/context");

    const lines: string[] = [
      "# Graph Context — testing",
      "*Generated: 2026-08-22T00:00:00Z | 15 context rules*",
      "",
      "## Context Rules (correlation-ranked)",
      "",
    ];
    for (let i = 1; i <= 15; i++) {
      lines.push(`- **rule_existing_${i}** [t] (score: 0.10)`);
      lines.push(`  text ${i}`);
      lines.push("");
    }

    const incoming = [
      "# Graph Context — testing",
      "*Generated: 2026-08-22T01:00:00Z | 2 context rules*",
      "",
      "## Context Rules (correlation-ranked)",
      "",
      "- **rule_fresh_1** [t] (score: 0.95)",
      "  fresh text 1",
      "",
      "- **rule_fresh_2** [t] (score: 0.94)",
      "  fresh text 2",
      "",
    ].join("\n");

    const merged = mergeGraphContextMarkdown(lines.join("\n"), incoming, 15);
    const order = [...merged.matchAll(/^- \*\*([^*]+)\*\*/gm)].map(m => m[1]);

    expect(order.length).toBe(15);
    expect(order.slice(0, 2)).toEqual(["rule_fresh_1", "rule_fresh_2"]);
    expect(order).not.toContain("rule_existing_15");
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
