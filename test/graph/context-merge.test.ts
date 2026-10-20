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

/** Ids of the bullets a merged file actually carries, in file order. */
function ruleIds(markdown: string): string[] {
  return markdown
    .split("\n")
    .map(l => l.match(/^- \*\*([^*]+)\*\*/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map(m => m[1]);
}

/** The body lines that follow a bullet, up to the next bullet. */
function bodyOf(markdown: string, id: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex(l => l.startsWith(`- **${id}**`));
  if (start === -1) return "";
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^- \*\*/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join("\n").trim();
}

function graphWith(nodes: Record<string, string>) {
  return {
    version: "1",
    builtAt: "2026-10-20T00:00:00Z",
    nodeCount: Object.keys(nodes).length,
    edgeCount: 0,
    edges: [],
    nodes: Object.fromEntries(
      Object.entries(nodes).map(([id, description]) => [
        id,
        {
          id,
          file: `${id}.md`,
          type: "feedback",
          name: id,
          description,
          domains: ["testing"],
          severity: 1,
          occurrence_count: 1,
          last_updated: "2026-10-20T00:00:00Z",
          content_hash: id,
          memoryType: "feedback",
        },
      ]),
    ),
  } as any;
}

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

  test("carries existing rules forward when the merged set fits the budget", async () => {
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
      "- **rule_5** [t] (score: 0.5)",
      "  text 5",
      "",
    ].join("\n");

    const merged = mergeGraphContextMarkdown(existing, incoming, 15);
    // 5 unique ids under a cap of 15: nothing is displaced, so all survive.
    expect(merged).toContain("rule_1");
    expect(merged).toContain("rule_2");
    expect(merged).toContain("rule_3");
    expect(merged).toContain("rule_4");
    expect(merged).toContain("rule_5");
    // Carrying existing forward is not the same as ignoring the incoming file:
    // the freshly retrieved rule leads the budget.
    expect(ruleIds(merged)[0]).toBe("rule_5");
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

  test("drops a carried-over entry whose body is its own id", async () => {
    const { mergeGraphContextMarkdown } = await import("../../src/graph/context");

    const existing = [
      "# Graph Context — testing",
      "*Generated: 2026-10-20T00:05:50Z | 3 context rules from [testing]*",
      "",
      "## Context Rules (correlation-ranked)",
      "",
      "- **merge291_slug_rule** [general] (score: 0.04)",
      "  merge291_slug_rule",
      "",
      "- **merge291_blank_rule** [general] (score: 0.03)",
      "  ",
      "",
      "- **merge291_real_rule** [testing] (score: 0.50)",
      "  A rule with actual body text",
      "",
    ].join("\n");

    const incoming = [
      "# Graph Context — testing",
      "*Generated: 2026-10-20T00:10:24Z | 1 context rules from [testing]*",
      "",
      "## Context Rules (correlation-ranked)",
      "",
      "- **merge291_fresh_rule** [testing] (score: 0.80)",
      "  Freshly retrieved body text",
      "",
    ].join("\n");

    const merged = mergeGraphContextMarkdown(existing, incoming, 15);
    const ids = ruleIds(merged);
    expect(ids).not.toContain("merge291_slug_rule");
    expect(ids).not.toContain("merge291_blank_rule");
    expect(ids).toContain("merge291_real_rule");
    expect(ids).toContain("merge291_fresh_rule");
    // The header count is a measurement of what the file carries.
    expect(merged).toContain(`| ${ids.length} context rules`);
  });

  test("admits fresh rules when the existing file already fills the budget", async () => {
    const { mergeGraphContextMarkdown } = await import("../../src/graph/context");

    const existingLines: string[] = [
      "# Graph Context — testing",
      "*Generated: 2026-10-20T00:05:50Z | 15 context rules from [testing]*",
      "",
      "## Context Rules (correlation-ranked)",
      "",
    ];
    for (let i = 1; i <= 15; i++) {
      existingLines.push(`- **merge291_old_${i}** [t] (score: ${(0.5 - i * 0.01).toFixed(2)})`);
      existingLines.push(`  old body text ${i}`);
      existingLines.push("");
    }

    const incomingLines: string[] = [
      "# Graph Context — testing",
      "*Generated: 2026-10-20T00:10:24Z | 2 context rules from [testing]*",
      "",
      "## Context Rules (correlation-ranked)",
      "",
    ];
    for (let i = 1; i <= 2; i++) {
      incomingLines.push(`- **merge291_fresh_${i}** [t] (score: 0.9${i})`);
      incomingLines.push(`  fresh body text ${i}`);
      incomingLines.push("");
    }

    const merged = mergeGraphContextMarkdown(
      existingLines.join("\n"),
      incomingLines.join("\n"),
      15,
    );
    const ids = ruleIds(merged);
    expect(ids.length).toBe(15);
    // Every freshly retrieved rule is admitted; the budget costs the oldest
    // carried-over entries, not the new ones.
    expect(ids).toContain("merge291_fresh_1");
    expect(ids).toContain("merge291_fresh_2");
    expect(ids.slice(0, 2)).toEqual(["merge291_fresh_1", "merge291_fresh_2"]);
    expect(ids).not.toContain("merge291_old_15");
  });

  test("re-resolves a carried-over entry's text from the graph", async () => {
    const { mergeGraphContextMarkdown } = await import("../../src/graph/context");

    const existing = [
      "# Graph Context — testing",
      "*Generated: 2026-10-20T00:05:50Z | 1 context rules from [testing]*",
      "",
      "## Context Rules (correlation-ranked)",
      "",
      "- **merge291_stale_rule** [general] (score: 0.04)",
      "  merge291_stale_rule",
      "",
    ].join("\n");

    const incoming = [
      "# Graph Context — testing",
      "*Generated: 2026-10-20T00:10:24Z | 1 context rules from [testing]*",
      "",
      "## Context Rules (correlation-ranked)",
      "",
      "- **merge291_fresh_rule** [testing] (score: 0.80)",
      "  Freshly retrieved body text",
      "",
    ].join("\n");

    const graph = graphWith({
      merge291_stale_rule: "The real body the graph holds for this rule",
    });

    const merged = mergeGraphContextMarkdown(existing, incoming, 15, graph);
    expect(ruleIds(merged)).toContain("merge291_stale_rule");
    expect(bodyOf(merged, "merge291_stale_rule")).toBe(
      "The real body the graph holds for this rule",
    );
    expect(merged).not.toContain("\n  merge291_stale_rule\n");
  });

  test("keeps a multi-line rule body intact across a merge", async () => {
    const { mergeGraphContextMarkdown } = await import("../../src/graph/context");

    const existing = [
      "# Graph Context — testing",
      "*Generated: 2026-10-20T00:05:50Z | 1 context rules from [testing]*",
      "",
      "## Context Rules (correlation-ranked)",
      "",
      "- **merge291_multiline** [t] (score: 0.70)",
      "  First line of the rule body",
      "  Second line that must survive",
      "",
    ].join("\n");

    const incoming = [
      "# Graph Context — testing",
      "*Generated: 2026-10-20T00:10:24Z | 1 context rules from [testing]*",
      "",
      "## Context Rules (correlation-ranked)",
      "",
      "- **merge291_fresh_rule** [t] (score: 0.80)",
      "  Freshly retrieved body text",
      "",
    ].join("\n");

    const merged = mergeGraphContextMarkdown(existing, incoming, 15);
    expect(bodyOf(merged, "merge291_multiline")).toBe(
      "First line of the rule body\n  Second line that must survive",
    );
  });
});
