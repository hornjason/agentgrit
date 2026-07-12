import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  writeSessionContext,
  readSessionContext,
  getContextRules,
  type SessionContext,
} from "../../src/graph/context";
import { buildIndex } from "../../src/graph/bm25";
import type { Graph } from "../../src/graph/types";
import type { GraphNode } from "../../src/adapters/types";

const TMP_DIR = join(import.meta.dir, ".tmp-session-context-test");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

function makeNode(id: string, domains: string[]): GraphNode {
  return {
    id,
    file: `${id}.md`,
    type: "rule",
    name: `Rule: ${id}`,
    description: `Text for ${id}`,
    domains,
    severity: 3,
    occurrence_count: 0,
    last_updated: new Date().toISOString(),
    content_hash: id.slice(0, 8),
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

describe("writeSessionContext", () => {
  test("writes session-context.json with ruleIds, domains, timestamp", () => {
    const graph = makeGraph([
      makeNode("rule-a", ["deployment"]),
      makeNode("rule-b", ["verification"]),
    ]);
    const f1 = join(TMP_DIR, "rule-a.md");
    const f2 = join(TMP_DIR, "rule-b.md");
    writeFileSync(f1, "deployment containers rebuild deployment", "utf-8");
    writeFileSync(f2, "verification verify before verification", "utf-8");
    const index = buildIndex([f1, f2]);
    const rules = getContextRules(graph, index, ["deployment", "verification"]);

    writeSessionContext(rules, ["deployment", "verification"]);

    const filePath = join(TMP_DIR, "state", "session-context.json");
    expect(existsSync(filePath)).toBe(true);

    const data = JSON.parse(readFileSync(filePath, "utf-8")) as SessionContext;
    expect(data.ruleIds).toContain("rule-a");
    expect(data.ruleIds).toContain("rule-b");
    expect(data.domains).toEqual(["deployment", "verification"]);
    expect(new Date(data.timestamp).getTime()).toBeGreaterThan(0);
    expect(data.ttl).toBe(24 * 60 * 60 * 1000);
  });

  test("creates state directory if it does not exist", () => {
    const stateDir = join(TMP_DIR, "state");
    expect(existsSync(stateDir)).toBe(false);
    writeSessionContext([], []);
    expect(existsSync(stateDir)).toBe(true);
    expect(existsSync(join(stateDir, "session-context.json"))).toBe(true);
  });

  test("overwrites previous session context", () => {
    writeSessionContext(
      [{ id: "old-rule", text: "old", tier: "graph" as any, tags: [], created: "", correlationScore: 0, sourceSignals: [], schemaVersion: 1 }],
      ["scope"],
    );
    writeSessionContext(
      [{ id: "new-rule", text: "new", tier: "graph" as any, tags: [], created: "", correlationScore: 0, sourceSignals: [], schemaVersion: 1 }],
      ["deployment"],
    );
    const data = JSON.parse(
      readFileSync(join(TMP_DIR, "state", "session-context.json"), "utf-8"),
    ) as SessionContext;
    expect(data.ruleIds).toEqual(["new-rule"]);
    expect(data.domains).toEqual(["deployment"]);
  });
});

describe("writeSessionContext rotation", () => {
  test("caps history file at 1000 lines after exceeding limit", () => {
    const stateDir = join(TMP_DIR, "state");
    mkdirSync(stateDir, { recursive: true });
    const historyPath = join(stateDir, "session-context-history.jsonl");

    // Pre-fill with 1000 entries
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      lines.push(JSON.stringify({
        ruleIds: [`pre-${i}`],
        domains: ["test"],
        domain_source: "keyword",
        timestamp: new Date().toISOString(),
        ttl: 86400000,
        rulesInjectedCount: 1,
        rulesInjectedKB: 0.1,
      }));
    }
    writeFileSync(historyPath, lines.join("\n") + "\n", "utf-8");

    // Write one more entry — should trigger rotation
    writeSessionContext(
      [{ id: "rule-1001", text: "latest", tier: "graph" as any, tags: [], created: "", correlationScore: 0, sourceSignals: [], schemaVersion: 1 }],
      ["scope"],
    );

    const result = readFileSync(historyPath, "utf-8").trimEnd().split("\n");
    expect(result.length).toBe(1000);
    // Oldest entry (pre-0) should be gone, newest (rule-1001) should be present
    const lastEntry = JSON.parse(result[result.length - 1]);
    expect(lastEntry.ruleIds).toContain("rule-1001");
    const firstEntry = JSON.parse(result[0]);
    expect(firstEntry.ruleIds[0]).toBe("pre-1");
  });

  test("does not rotate when at or below 1000 lines", () => {
    const stateDir = join(TMP_DIR, "state");
    mkdirSync(stateDir, { recursive: true });
    const historyPath = join(stateDir, "session-context-history.jsonl");

    // Pre-fill with 999 entries
    const lines: string[] = [];
    for (let i = 0; i < 999; i++) {
      lines.push(JSON.stringify({
        ruleIds: [`pre-${i}`],
        domains: ["test"],
        domain_source: "keyword",
        timestamp: new Date().toISOString(),
        ttl: 86400000,
        rulesInjectedCount: 1,
        rulesInjectedKB: 0.1,
      }));
    }
    writeFileSync(historyPath, lines.join("\n") + "\n", "utf-8");

    // Write one more → total 1000, should NOT rotate
    writeSessionContext(
      [{ id: "rule-1000", text: "new", tier: "graph" as any, tags: [], created: "", correlationScore: 0, sourceSignals: [], schemaVersion: 1 }],
      ["scope"],
    );

    const result = readFileSync(historyPath, "utf-8").trimEnd().split("\n");
    expect(result.length).toBe(1000);
    const firstEntry = JSON.parse(result[0]);
    expect(firstEntry.ruleIds[0]).toBe("pre-0");
  });
});

describe("readSessionContext", () => {
  test("returns null when file does not exist", () => {
    expect(readSessionContext()).toBeNull();
  });

  test("reads valid session context", () => {
    const stateDir = join(TMP_DIR, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "session-context.json"), JSON.stringify({
      ruleIds: ["rule-x", "rule-y"],
      domains: ["deployment"],
      timestamp: new Date().toISOString(),
      ttl: 24 * 60 * 60 * 1000,
    }));
    const result = readSessionContext();
    expect(result).not.toBeNull();
    expect(result!.ruleIds).toEqual(["rule-x", "rule-y"]);
    expect(result!.domains).toEqual(["deployment"]);
  });

  test("returns null for expired context (TTL exceeded)", () => {
    const stateDir = join(TMP_DIR, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "session-context.json"), JSON.stringify({
      ruleIds: ["rule-expired"],
      domains: ["scope"],
      timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      ttl: 24 * 60 * 60 * 1000,
    }));
    expect(readSessionContext()).toBeNull();
  });

  test("returns context within TTL window", () => {
    const stateDir = join(TMP_DIR, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "session-context.json"), JSON.stringify({
      ruleIds: ["rule-fresh"],
      domains: ["verification"],
      timestamp: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
      ttl: 24 * 60 * 60 * 1000,
    }));
    const result = readSessionContext();
    expect(result).not.toBeNull();
    expect(result!.ruleIds).toEqual(["rule-fresh"]);
  });

  test("returns null for malformed JSON", () => {
    const stateDir = join(TMP_DIR, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "session-context.json"), "not json{{{");
    expect(readSessionContext()).toBeNull();
  });
});
