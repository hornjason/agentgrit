/**
 * Corpus-collapse guard.
 *
 * Issue #290: the live `~/.agentgrit/state/knowledge-graph.json` was found
 * holding exactly the 47 ids in `~/.agentgrit/rules` where a rebuild from the
 * configured `memoryDir` produces 600. A 47-node graph still answers every
 * query and still writes GRAPH-CONTEXT.md, so the collapse is silent.
 *
 * These tests pin two things:
 *   1. a graph records the corpus directory it was built from, so a
 *      wrong-directory build is self-identifying after the fact;
 *   2. a build that collapses the node count against the graph already on
 *      disk is refused, unless the corpus directory is the same one and has
 *      genuinely shrunk to match.
 *
 * Note on write sites: `buildGraph()` only reaches `writeGraphFile()` when
 * `stateOutputDir` is undefined, and every live caller passes `stateDir()`.
 * A guard living only in `writeGraphFile()` would be green forever while
 * protecting nothing. The tests below exercise both paths deliberately.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join, resolve } from "path";
import {
  buildGraph,
  writeGraphFile,
  detectCorpusCollapse,
  resetClassifyPatterns,
} from "../../src/graph/builder";
import type { Graph } from "../../src/graph/types";
import type { GraphNode } from "../../src/adapters/types";

const TMP_DIR = join(import.meta.dir, ".tmp-collapse-guard-test");
const MEMORY_DIR = join(TMP_DIR, "memory");
const RULES_DIR = join(TMP_DIR, "rules");
const STATE_DIR = join(TMP_DIR, "state");
const GRAPH_PATH = join(STATE_DIR, "knowledge-graph.json");
const RD_PATH = join(TMP_DIR, "rule-domains.json");

const PRIOR_NODES = 600;
const FIXTURE_RULES = 47;

function node(id: string): GraphNode {
  return {
    id,
    file: `${id}.md`,
    type: "rule",
    name: id,
    description: `Description for ${id}`,
    domains: ["testing"],
    severity: 3,
    occurrence_count: 0,
    last_updated: new Date().toISOString(),
    content_hash: `hash-${id}`,
    memoryType: "behavioral-rule",
  };
}

/** A stand-in for the live 600-node graph. `builtFrom` is optional because the
 *  graph found in the incident had no provenance field at all. */
function writePriorGraph(count: number, builtFrom?: { dir: string; fileCount: number }): void {
  const nodes: Record<string, GraphNode> = {};
  for (let i = 0; i < count; i++) {
    const id = `memory-rule-${String(i).padStart(4, "0")}`;
    nodes[id] = node(id);
  }
  const graph: Graph = {
    version: "1.0",
    builtAt: "2026-10-19T22:25:00.000Z",
    nodeCount: count,
    edgeCount: 0,
    nodes,
    edges: [],
    ...(builtFrom ? { builtFrom } : {}),
  };
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(GRAPH_PATH, JSON.stringify(graph, null, 2), "utf-8");
}

function writeRuleFixture(dir: string, count: number, prefix: string): void {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const id = `${prefix}-${String(i).padStart(4, "0")}`;
    writeFileSync(
      join(dir, `${id}.md`),
      `---\nname: ${id}\ndescription: Legacy rule ${i}\n---\n\nAlways run the test suite before reporting done.\n`,
      "utf-8",
    );
  }
}

function readGraphFile(): Graph {
  return JSON.parse(readFileSync(GRAPH_PATH, "utf-8")) as Graph;
}

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
  delete process.env.AGENTGRIT_ALLOW_GRAPH_COLLAPSE;
  resetClassifyPatterns();
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = process.env.AGENTGRIT_TEST_BASE ?? "";
  delete process.env.AGENTGRIT_ALLOW_GRAPH_COLLAPSE;
});

describe("corpus provenance", () => {
  test("a built graph records the directory it walked and how many rule files it held", async () => {
    writeRuleFixture(MEMORY_DIR, 25, "memory-rule");

    const graph = await buildGraph(MEMORY_DIR, STATE_DIR, RD_PATH);

    expect(graph.builtFrom).toBeDefined();
    expect(graph.builtFrom!.dir).toBe(resolve(MEMORY_DIR));
    expect(graph.builtFrom!.fileCount).toBe(25);
    expect(readGraphFile().builtFrom!.dir).toBe(resolve(MEMORY_DIR));
  });
});

describe("corpus collapse guard", () => {
  test("refuses a 47-file build from a different directory over a 600-node graph", async () => {
    writePriorGraph(PRIOR_NODES);
    writeRuleFixture(RULES_DIR, FIXTURE_RULES, "legacy-rule");

    await expect(buildGraph(RULES_DIR, STATE_DIR, RD_PATH)).rejects.toThrow(/collapse/i);

    // The 600-node graph on disk must be untouched.
    const onDisk = readGraphFile();
    expect(onDisk.nodeCount).toBe(PRIOR_NODES);
    expect(Object.keys(onDisk.nodes).length).toBe(PRIOR_NODES);
  });

  test("names the two directories and both counts so the wrong-directory build is diagnosable", async () => {
    writePriorGraph(PRIOR_NODES, { dir: resolve(MEMORY_DIR), fileCount: PRIOR_NODES });
    writeRuleFixture(RULES_DIR, FIXTURE_RULES, "legacy-rule");

    let message = "";
    try {
      await buildGraph(RULES_DIR, STATE_DIR, RD_PATH);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain(resolve(RULES_DIR));
    expect(message).toContain(resolve(MEMORY_DIR));
    expect(message).toContain(String(PRIOR_NODES));
    expect(message).toContain(String(FIXTURE_RULES));
  });

  test("refuses before pruning rule-domains.json, so a refused build has no side effects", async () => {
    writePriorGraph(PRIOR_NODES);
    writeRuleFixture(RULES_DIR, FIXTURE_RULES, "legacy-rule");

    const ruleDomains = {
      version: 1,
      reviewed: true,
      rules: {
        "memory-rule-0000": { domains: ["testing"], source: "human" },
        "memory-rule-0001": { domains: ["security"], source: "human" },
      },
    };
    writeFileSync(RD_PATH, JSON.stringify(ruleDomains, null, 2), "utf-8");

    await expect(buildGraph(RULES_DIR, STATE_DIR, RD_PATH)).rejects.toThrow(/collapse/i);

    const after = JSON.parse(readFileSync(RD_PATH, "utf-8"));
    expect(Object.keys(after.rules).sort()).toEqual(["memory-rule-0000", "memory-rule-0001"]);
  });

  test("allows a genuine shrink: same corpus directory, and it really does hold 47 files now", async () => {
    writePriorGraph(PRIOR_NODES, { dir: resolve(MEMORY_DIR), fileCount: PRIOR_NODES });
    writeRuleFixture(MEMORY_DIR, FIXTURE_RULES, "memory-rule");

    const graph = await buildGraph(MEMORY_DIR, STATE_DIR, RD_PATH);

    expect(graph.nodeCount).toBe(FIXTURE_RULES);
    expect(readGraphFile().nodeCount).toBe(FIXTURE_RULES);
  });

  test("allows a build that grows the corpus", async () => {
    writePriorGraph(30, { dir: resolve(MEMORY_DIR), fileCount: 30 });
    writeRuleFixture(MEMORY_DIR, 120, "memory-rule");

    const graph = await buildGraph(MEMORY_DIR, STATE_DIR, RD_PATH);

    expect(graph.nodeCount).toBe(120);
  });

  test("refuses when buildGraph writes through writeGraphFile (no stateOutputDir)", async () => {
    writePriorGraph(PRIOR_NODES);
    writeRuleFixture(RULES_DIR, FIXTURE_RULES, "legacy-rule");

    await expect(buildGraph(RULES_DIR, undefined, RD_PATH)).rejects.toThrow(/collapse/i);
    expect(readGraphFile().nodeCount).toBe(PRIOR_NODES);
  });

  test("writeGraphFile refuses a caller-supplied graph that collapses the live one", () => {
    // classify-isolated.ts calls writeGraphFile() on whatever object its caller
    // hands it — it never reads the live graph itself.
    writePriorGraph(PRIOR_NODES, { dir: resolve(MEMORY_DIR), fileCount: PRIOR_NODES });

    const nodes: Record<string, GraphNode> = {};
    for (let i = 0; i < FIXTURE_RULES; i++) {
      const id = `legacy-rule-${String(i).padStart(4, "0")}`;
      nodes[id] = node(id);
    }
    const small: Graph = {
      version: "1.0",
      builtAt: new Date().toISOString(),
      nodeCount: FIXTURE_RULES,
      edgeCount: 0,
      nodes,
      edges: [],
    };

    expect(() => writeGraphFile(small)).toThrow(/collapse/i);
    expect(readGraphFile().nodeCount).toBe(PRIOR_NODES);
  });

  test("writeGraphFile preserves provenance through a read-modify-write", () => {
    writePriorGraph(PRIOR_NODES, { dir: resolve(MEMORY_DIR), fileCount: PRIOR_NODES });

    const live = readGraphFile();
    delete (live as Partial<Graph>).builtFrom; // a caller that dropped the field
    live.nodes["memory-rule-0000"].domains = ["security"];

    writeGraphFile(live);

    expect(readGraphFile().builtFrom!.dir).toBe(resolve(MEMORY_DIR));
  });

  test("AGENTGRIT_ALLOW_GRAPH_COLLAPSE=1 is the documented override", async () => {
    writePriorGraph(PRIOR_NODES);
    writeRuleFixture(RULES_DIR, FIXTURE_RULES, "legacy-rule");
    process.env.AGENTGRIT_ALLOW_GRAPH_COLLAPSE = "1";

    const graph = await buildGraph(RULES_DIR, STATE_DIR, RD_PATH);

    expect(graph.nodeCount).toBe(FIXTURE_RULES);
  });
});

describe("detectCorpusCollapse", () => {
  const prior = (count: number, dir?: string): Graph => ({
    version: "1.0",
    builtAt: "2026-10-19T22:25:00.000Z",
    nodeCount: count,
    edgeCount: 0,
    nodes: {},
    edges: [],
    ...(dir ? { builtFrom: { dir, fileCount: count } } : {}),
  });

  test("returns null when there is no previous graph", () => {
    expect(detectCorpusCollapse(null, { nodeCount: 1, builtFrom: { dir: "/a", fileCount: 1 } })).toBeNull();
  });

  test("ignores small graphs, where a swing of a few nodes is normal", () => {
    expect(detectCorpusCollapse(prior(8, "/a"), { nodeCount: 1, builtFrom: { dir: "/b", fileCount: 1 } })).toBeNull();
  });

  test("flags the same directory when the corpus is still large but the nodes are not", () => {
    // 600 files walked, 47 nodes produced: a builder defect, not a corpus shrink.
    const msg = detectCorpusCollapse(prior(600, "/a"), { nodeCount: 47, builtFrom: { dir: "/a", fileCount: 600 } });
    expect(msg).toBeTruthy();
  });

  test("flags a build with no provenance at all over a large graph", () => {
    expect(detectCorpusCollapse(prior(600, "/a"), { nodeCount: 47 })).toBeTruthy();
  });
});
