import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { checkEvalRegression } from "../../src/evaluate/regression";
import type { Graph } from "../../src/graph/types";
import type { GraphNode } from "../../src/adapters/types";
import { buildIndex } from "../../src/graph/bm25";

function makeNode(id: string, domains: string[], desc: string): GraphNode {
  return {
    id,
    file: `${id}.md`,
    type: "rule",
    name: `Rule ${id}`,
    description: desc,
    domains,
    severity: 5,
    occurrence_count: 1,
    last_updated: new Date().toISOString(),
    content_hash: "abc",
    memoryType: "rule",
  };
}

function makeGraph(nodes: Record<string, GraphNode>): Graph {
  return {
    version: "1.0",
    builtAt: new Date().toISOString(),
    nodeCount: Object.keys(nodes).length,
    edgeCount: 0,
    nodes,
    edges: [],
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `regression-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
});

function writeRuleFile(id: string, content: string): string {
  const path = join(tmpDir, `${id}.md`);
  writeFileSync(path, content, "utf-8");
  return path;
}

describe("checkEvalRegression", () => {
  test("passes on first run when no watermark exists", async () => {
    const nodes: Record<string, GraphNode> = {
      r1: makeNode("r1", ["deployment"], "deploy container rebuild makefile"),
      r2: makeNode("r2", ["verification"], "verify before answering check source"),
    };
    const graph = makeGraph(nodes);

    const f1 = writeRuleFile("r1", "deploy container rebuild makefile deployment");
    const f2 = writeRuleFile("r2", "verify before answering check source verification");
    const index = buildIndex([f1, f2]);

    const goldPath = join(tmpDir, "gold.json");
    const wmPath = join(tmpDir, "watermark.json");

    writeFileSync(goldPath, JSON.stringify({
      labeled: {
        s1: {
          sessionId: "s1",
          description: "deploy the container",
          task_context: "deploy container rebuild",
          domains: ["deployment"],
          relevantRules: ["r1"],
        },
      },
      totalLabeled: 1,
      updated: new Date().toISOString(),
    }));

    const result = await checkEvalRegression(goldPath, wmPath, graph, index);
    expect(result.pass).toBe(true);
    expect(result.previousPrecision).toBeNull();
    expect(result.precision).toBeGreaterThanOrEqual(0);
    expect(existsSync(wmPath)).toBe(true);
  });

  test("passes when precision stays stable", async () => {
    const nodes: Record<string, GraphNode> = {
      r1: makeNode("r1", ["deployment"], "deploy container rebuild makefile"),
      r2: makeNode("r2", ["verification"], "verify before answering check"),
    };
    const graph = makeGraph(nodes);

    const f1 = writeRuleFile("r1", "deploy container rebuild makefile deployment");
    const f2 = writeRuleFile("r2", "verify before answering check verification");
    const index = buildIndex([f1, f2]);

    const goldPath = join(tmpDir, "gold.json");
    const wmPath = join(tmpDir, "watermark.json");

    writeFileSync(goldPath, JSON.stringify({
      labeled: {
        s1: {
          sessionId: "s1",
          description: "deploy container",
          task_context: "deploy container rebuild",
          domains: ["deployment"],
          relevantRules: ["r1"],
        },
      },
      totalLabeled: 1,
      updated: new Date().toISOString(),
    }));

    const first = await checkEvalRegression(goldPath, wmPath, graph, index);
    expect(first.pass).toBe(true);

    const second = await checkEvalRegression(goldPath, wmPath, graph, index);
    expect(second.pass).toBe(true);
    expect(second.previousPrecision).not.toBeNull();
  });

  test("blocks when precision drops >= 0.05", async () => {
    const nodes: Record<string, GraphNode> = {
      r1: makeNode("r1", ["deployment"], "deploy container rebuild"),
      r2: makeNode("r2", ["verification"], "verify before answering"),
    };
    const graph = makeGraph(nodes);

    const f1 = writeRuleFile("r1", "deploy container rebuild");
    const f2 = writeRuleFile("r2", "verify before answering");
    const index = buildIndex([f1, f2]);

    const goldPath = join(tmpDir, "gold.json");
    const wmPath = join(tmpDir, "watermark.json");

    writeFileSync(wmPath, JSON.stringify({
      precision: 0.95,
      timestamp: new Date().toISOString(),
      sessionCount: 1,
    }));

    writeFileSync(goldPath, JSON.stringify({
      labeled: {
        s1: {
          sessionId: "s1",
          description: "totally unrelated topic about cooking recipes",
          task_context: "cooking recipes for dinner something completely different",
          domains: ["deployment"],
          relevantRules: ["r1"],
        },
      },
      totalLabeled: 1,
      updated: new Date().toISOString(),
    }));

    const result = await checkEvalRegression(goldPath, wmPath, graph, index);
    expect(result.pass).toBe(false);
    expect(result.previousPrecision).toBe(0.95);
    expect(result.precision).toBeLessThan(0.90);
  });
});
