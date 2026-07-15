import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { writeRuleFile, updateRuleDomains, appendToLearnedMd } from "../../src/promote/sync";
import { Tier, SCHEMA_VERSION, type Rule } from "../../src/adapters/types";
import { parseFrontmatter, buildGraph } from "../../src/graph/builder";

const TMP_DIR = join(import.meta.dir, ".tmp-sync-test-" + process.pid);
const RULES_DIR = join(TMP_DIR, "rules");
const STATE_DIR = join(TMP_DIR, "state");
const RULE_DOMAINS_PATH = join(STATE_DIR, "rule-domains.json");
const LEARNED_PATH = join(TMP_DIR, "CLAUDE-LEARNED.md");

function makeRule(id: string, text: string): Rule {
  return {
    id,
    text,
    tier: Tier.Global,
    tags: ["test"],
    created: new Date().toISOString(),
    correlationScore: 0,
    sourceSignals: [],
    schemaVersion: SCHEMA_VERSION,
  };
}

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

// AC-1: rule .md file write
describe("writeRuleFile", () => {
  test("creates rule .md file with correct frontmatter", () => {
    const rule = makeRule("agentgrit-verify-output", "Always verify output before reporting done");
    const filePath = writeRuleFile(rule, RULES_DIR);

    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, "utf-8");
    const fm = parseFrontmatter(content);
    expect(fm.name).toBe("agentgrit-verify-output");
    expect(fm.description).toBe("Always verify output before reporting done");
    expect(fm.type).toBe("learned");
  });

  test("writes rule text as body content", () => {
    const rule = makeRule("agentgrit-test-rule", "Test before shipping code");
    writeRuleFile(rule, RULES_DIR);

    const content = readFileSync(join(RULES_DIR, "agentgrit-test-rule.md"), "utf-8");
    const body = content.replace(/^---[\s\S]*?---\n/, "").trim();
    expect(body).toBe("Test before shipping code");
  });

  test("creates rules directory if it does not exist", () => {
    const newDir = join(TMP_DIR, "nested", "rules");
    expect(existsSync(newDir)).toBe(false);

    writeRuleFile(makeRule("r1", "text"), newDir);
    expect(existsSync(newDir)).toBe(true);
  });

  test("overwrites existing rule file", () => {
    const rule = makeRule("r1", "original text");
    writeRuleFile(rule, RULES_DIR);

    const updated = makeRule("r1", "updated text");
    writeRuleFile(updated, RULES_DIR);

    const content = readFileSync(join(RULES_DIR, "r1.md"), "utf-8");
    expect(content).toContain("updated text");
    expect(content).not.toContain("original text");
  });
});

// AC-2: rule-domains.json update
describe("updateRuleDomains", () => {
  test("creates rule-domains.json if it does not exist", () => {
    const rule = makeRule("agentgrit-verify-output", "Always verify output before reporting done");
    const domains = updateRuleDomains(rule, RULE_DOMAINS_PATH);

    expect(existsSync(RULE_DOMAINS_PATH)).toBe(true);
    expect(Array.isArray(domains)).toBe(true);
    expect(domains.length).toBeGreaterThan(0);
  });

  test("adds entry to existing rule-domains.json", () => {
    mkdirSync(STATE_DIR, { recursive: true });
    const existing = {
      version: 1,
      reviewed: false,
      rules: {
        "existing-rule": { domains: ["verification"], source: "manual" },
      },
    };
    writeFileSync(RULE_DOMAINS_PATH, JSON.stringify(existing));

    const rule = makeRule("new-rule", "Always check scope before starting");
    updateRuleDomains(rule, RULE_DOMAINS_PATH);

    const updated = JSON.parse(readFileSync(RULE_DOMAINS_PATH, "utf-8"));
    expect(updated.rules["existing-rule"]).toBeDefined();
    expect(updated.rules["new-rule"]).toBeDefined();
    expect(updated.rules["new-rule"].source).toBe("auto");
    expect(Array.isArray(updated.rules["new-rule"].domains)).toBe(true);
  });

  test("preserves version and reviewed fields", () => {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(RULE_DOMAINS_PATH, JSON.stringify({
      version: 1,
      reviewed: false,
      rules: {},
    }));

    updateRuleDomains(makeRule("r1", "text"), RULE_DOMAINS_PATH);

    const updated = JSON.parse(readFileSync(RULE_DOMAINS_PATH, "utf-8"));
    expect(updated.version).toBe(1);
    expect(updated.reviewed).toBe(false);
  });

  test("defaults to ['verification'] when keywordClassify returns null", () => {
    const rule = makeRule("agentgrit-xyzzy-nonsense", "xyzzy nonsense gibberish");
    const domains = updateRuleDomains(rule, RULE_DOMAINS_PATH);

    expect(domains).toEqual(["verification"]);
    const file = JSON.parse(readFileSync(RULE_DOMAINS_PATH, "utf-8"));
    expect(file.rules["agentgrit-xyzzy-nonsense"].domains).toEqual(["verification"]);
  });
});

// AC-3: CLAUDE-LEARNED.md append
describe("appendToLearnedMd", () => {
  const BASE_LEARNED = `# PAI Learned Rules

Rules promoted from debriefs.

### Learned Rules

- **existing-rule:** This rule already exists
- **another-rule:** Another existing rule

---

## Other Section
`;

  test("appends rule after last rule line", () => {
    writeFileSync(LEARNED_PATH, BASE_LEARNED);
    const rule = makeRule("agentgrit-new-rule", "A newly promoted rule");
    appendToLearnedMd(rule, LEARNED_PATH);

    const content = readFileSync(LEARNED_PATH, "utf-8");
    expect(content).toContain("- **agentgrit-new-rule:** A newly promoted rule");
    expect(content.indexOf("another-rule")).toBeLessThan(
      content.indexOf("agentgrit-new-rule"),
    );
  });

  test("preserves existing rules and other sections", () => {
    writeFileSync(LEARNED_PATH, BASE_LEARNED);
    appendToLearnedMd(makeRule("new-r", "new text"), LEARNED_PATH);

    const content = readFileSync(LEARNED_PATH, "utf-8");
    expect(content).toContain("- **existing-rule:**");
    expect(content).toContain("- **another-rule:**");
    expect(content).toContain("## Other Section");
  });

  test("skips if rule already exists (idempotent)", () => {
    writeFileSync(LEARNED_PATH, BASE_LEARNED);
    appendToLearnedMd(makeRule("existing-rule", "This rule already exists"), LEARNED_PATH);

    const content = readFileSync(LEARNED_PATH, "utf-8");
    const matches = content.match(/existing-rule/g);
    expect(matches!.length).toBe(1);
  });

  test("no-op if file does not exist", () => {
    expect(() => {
      appendToLearnedMd(makeRule("r1", "text"), "/tmp/nonexistent-learned.md");
    }).not.toThrow();
  });

  test("handles empty rules section", () => {
    const emptySection = `# PAI Learned Rules

### Learned Rules

---
`;
    writeFileSync(LEARNED_PATH, emptySection);
    appendToLearnedMd(makeRule("first-rule", "First promoted rule"), LEARNED_PATH);

    const content = readFileSync(LEARNED_PATH, "utf-8");
    expect(content).toContain("- **first-rule:** First promoted rule");
  });
});

// AC-4: buildGraph picks up .md file written by writeRuleFile
describe("buildGraph integration", () => {
  test("graph includes rule written by writeRuleFile", async () => {
    mkdirSync(RULES_DIR, { recursive: true });
    const rule = makeRule("agentgrit-test-integration", "Always verify before shipping");
    writeRuleFile(rule, RULES_DIR);

    const graph = await buildGraph(RULES_DIR, STATE_DIR);
    expect(graph.nodes["agentgrit-test-integration"]).toBeDefined();
    expect(graph.nodes["agentgrit-test-integration"].name).toBe("agentgrit-test-integration");
    expect(graph.nodes["agentgrit-test-integration"].type).toBe("learned");
  });

  test("graph node has correct description from frontmatter", async () => {
    const rule = makeRule("agentgrit-desc-test", "Check output before declaring done");
    writeRuleFile(rule, RULES_DIR);

    const graph = await buildGraph(RULES_DIR, STATE_DIR);
    const node = graph.nodes["agentgrit-desc-test"];
    expect(node).toBeDefined();
    expect(node.description).toContain("Check output before declaring done");
  });
});
