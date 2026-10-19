import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import {
  canonicalRuleId,
  ruleIdFromFilename,
  ruleFileName,
  ruleIdsMatch,
  isSafeRuleId,
} from "../../src/graph/rule-id";
import { buildGraph, resetClassifyPatterns } from "../../src/graph/builder";
import { buildIndex } from "../../src/graph/bm25";
import { writeRuleFile, updateRuleDomains } from "../../src/promote/sync";
import { resolveGraphNode } from "../../src/graph/rule-text";
import type { Graph } from "../../src/graph/types";
import type { GraphNode, Rule } from "../../src/adapters/types";
import { Tier, SCHEMA_VERSION } from "../../src/adapters/types";

const TMP_DIR = join(import.meta.dir, ".tmp-rule-id-test");
const RULES_DIR = join(TMP_DIR, "rules");
const STATE_DIR = join(TMP_DIR, "state");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(RULES_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
  resetClassifyPatterns();
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = process.env.AGENTGRIT_TEST_BASE ?? "";
});

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

function makeNode(id: string, description: string): GraphNode {
  return {
    id,
    file: `${id}.md`,
    type: "feedback",
    name: id,
    description,
    domains: ["testing"],
    severity: 3,
    occurrence_count: 0,
    last_updated: new Date().toISOString(),
    content_hash: "abc",
    memoryType: "behavioral-rule",
  };
}

function makeGraph(nodes: GraphNode[]): Graph {
  const nodeMap: Record<string, GraphNode> = {};
  for (const n of nodes) nodeMap[n.id] = n;
  return {
    version: "1.0",
    builtAt: new Date().toISOString(),
    nodeCount: nodes.length,
    edgeCount: 0,
    nodes: nodeMap,
    edges: [],
  };
}

describe("canonicalRuleId", () => {
  test("collapses the spellings the four derivations disagree on", () => {
    const expected = "feedback_smoke_test_insufficient";
    expect(canonicalRuleId("feedback_smoke-test-insufficient")).toBe(expected);
    expect(canonicalRuleId("feedback_smoke_test_insufficient")).toBe(expected);
    expect(canonicalRuleId("Feedback_Smoke-Test-Insufficient")).toBe(expected);
    expect(canonicalRuleId("feedback_smoke-test-insufficient.md")).toBe(expected);
    expect(canonicalRuleId("feedback smoke test insufficient")).toBe(expected);
  });

  test("is idempotent", () => {
    const once = canonicalRuleId("Brief and dashboard must render consistently (2026-06-11)");
    expect(canonicalRuleId(once)).toBe(once);
  });

  test("keeps genuinely different ids apart", () => {
    expect(canonicalRuleId("feedback_every_issue_through_ship")).not.toBe(
      canonicalRuleId("feedback_every_issue_goes_through_ship"),
    );
    expect(ruleIdsMatch("feedback_every_issue_through_ship", "feedback_every_issue_goes_through_ship")).toBe(false);
  });

  test("ruleIdFromFilename and ruleFileName round-trip", () => {
    expect(ruleIdFromFilename("feedback_server_restart.md")).toBe("feedback_server_restart");
    expect(ruleIdFromFilename("/a/b/feedback_server_restart.md")).toBe("feedback_server_restart");
    expect(ruleFileName("feedback_server_restart")).toBe("feedback_server_restart.md");
    expect(ruleIdFromFilename(ruleFileName("some-rule"))).toBe("some-rule");
  });
});

describe("rule ids that climb out of their directory", () => {
  test("ruleFileName refuses an id carrying a path separator or a parent segment", () => {
    expect(ruleFileName("feedback_ok")).toBe("feedback_ok.md");
    expect(() => ruleFileName("../escaped-rule")).toThrow(/rule id/i);
    expect(() => ruleFileName("nested/rule")).toThrow(/rule id/i);
    expect(() => ruleFileName("..")).toThrow(/rule id/i);
    expect(() => ruleFileName("")).toThrow(/rule id/i);
  });

  test("isSafeRuleId accepts the spellings the registry actually holds", () => {
    expect(isSafeRuleId("feedback_every_issue_goes_through_ship")).toBe(true);
    expect(isSafeRuleId("feedback_smoke-test-insufficient")).toBe(true);
    expect(isSafeRuleId("Brief and dashboard must render consistently (2026-06-11)")).toBe(true);
    expect(isSafeRuleId("../escaped-rule")).toBe(false);
    expect(isSafeRuleId("a/b")).toBe(false);
    expect(isSafeRuleId("a\\b")).toBe(false);
    expect(isSafeRuleId("a\0b")).toBe(false);
  });

  test("writeRuleFile does not write outside rulesDir", () => {
    // Pre-fix `join(rulesDir, `${rule.id}.md`)` resolved this to TMP_DIR —
    // one level above RULES_DIR — and wrote there without complaint.
    const escaped = join(TMP_DIR, "escaped-rule.md");
    expect(() => writeRuleFile(makeRule("../escaped-rule", "Escaped"), RULES_DIR)).toThrow(/rule id/i);
    expect(existsSync(escaped)).toBe(false);
  });
});

describe("single derivation across builder, registry writer and context resolver", () => {
  test("graph builder derives node ids with ruleIdFromFilename", async () => {
    writeFileSync(
      join(RULES_DIR, "feedback_Mixed-Case_Rule.md"),
      `---\nname: mixed-case-rule\ndescription: A mixed case rule about deploy containers\n---\nRun make rebuild before deploying.`,
      "utf-8",
    );

    const graph = await buildGraph(RULES_DIR, STATE_DIR);
    const id = ruleIdFromFilename("feedback_Mixed-Case_Rule.md");
    expect(graph.nodes[id]).toBeDefined();
  });

  test("BM25 doc ids use the same filename derivation as the graph builder", () => {
    const file = join(TMP_DIR, "feedback_Mixed-Case_Rule.md");
    writeFileSync(file, "deploy containers make rebuild production", "utf-8");
    const index = buildIndex([file]);
    expect(index.docs[0].id).toBe(ruleIdFromFilename(file));
  });

  test("registry writer names the rule file with ruleFileName", () => {
    const rule = makeRule("agentgrit-verify-output", "Always verify output before reporting done");
    const filePath = writeRuleFile(rule, RULES_DIR);
    expect(filePath).toBe(join(RULES_DIR, ruleFileName(rule.id)));
    expect(existsSync(filePath)).toBe(true);
  });

  test("registry writer collapses an older entry that differs only in spelling", () => {
    const rdPath = join(STATE_DIR, "rule-domains.json");
    writeFileSync(
      rdPath,
      JSON.stringify({
        version: 1,
        reviewed: false,
        rules: { "Verify-Before-Answering": { domains: ["scope"], source: "auto" } },
      }),
      "utf-8",
    );

    updateRuleDomains(makeRule("verify_before_answering", "Always verify before answering"), rdPath);

    const file = JSON.parse(readFileSync(rdPath, "utf-8")) as {
      rules: Record<string, { domains: string[] }>;
    };
    const keys = Object.keys(file.rules);
    expect(keys).toContain("verify_before_answering");
    expect(keys).not.toContain("Verify-Before-Answering");
    expect(keys.length).toBe(1);
  });

  test("context resolver matches a candidate id to a node spelled differently", () => {
    const graph = makeGraph([makeNode("feedback_smoke_test_insufficient", "A smoke test is not enough")]);
    const node = resolveGraphNode("feedback_smoke-test-insufficient", graph);
    expect(node?.id).toBe("feedback_smoke_test_insufficient");
  });

  test("context resolver does not invent a match for a genuinely absent id", () => {
    const graph = makeGraph([makeNode("feedback_every_issue_goes_through_ship", "Ship every issue")]);
    expect(resolveGraphNode("feedback_every_issue_through_ship", graph)).toBeNull();
  });
});
