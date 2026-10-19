/**
 * #258 — `agentgrit backfill` reported a rebuilt graph while nothing under the
 * base dir changed. Two things have to hold: the rebuilt graph lands on disk
 * (mtime advances past a stamp taken before the run) and it carries the
 * promoted rule files, not just the memory directory.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { backfillCommand } from "../../bin/commands/backfill";
import { resetClassifyPatterns } from "../../src/graph/builder";

const TEST_DIR = "/tmp/agentgrit-backfill-persistence-" + process.pid;
const STATE_DIR = join(TEST_DIR, "state");
const RULES_DIR = join(TEST_DIR, "rules");
const MEMORY_DIR = join(TEST_DIR, "memory");
const GRAPH_PATH = join(STATE_DIR, "knowledge-graph.json");

function writeMd(dir: string, id: string, description: string, body: string): void {
  writeFileSync(
    join(dir, `${id}.md`),
    `---\nname: ${id}\ndescription: ${description}\n---\n${body}\n`,
    "utf-8",
  );
}

/** A graph already on disk, last written ten days ago. */
function writeStaleGraph(): number {
  writeFileSync(
    GRAPH_PATH,
    JSON.stringify({
      version: "1.0",
      builtAt: new Date(0).toISOString(),
      nodeCount: 0,
      edgeCount: 0,
      nodes: {},
      edges: [],
    }),
    "utf-8",
  );
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
  utimesSync(GRAPH_PATH, tenDaysAgo, tenDaysAgo);
  return statSync(GRAPH_PATH).mtimeMs;
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(RULES_DIR, { recursive: true });
  mkdirSync(MEMORY_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TEST_DIR;
  resetClassifyPatterns();
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = process.env.AGENTGRIT_TEST_BASE ?? "";
});

describe("backfill persistence", () => {
  test("rewrites knowledge-graph.json on disk", async () => {
    writeMd(MEMORY_DIR, "feedback_memory_one", "deploy sequence", "Run make rebuild before deploying.");
    writeMd(RULES_DIR, "feedback_promoted_one", "Stay focused", "Keep minimal scope, don't add unrequested features.");
    const staleMtime = writeStaleGraph();

    await backfillCommand([]);

    expect(statSync(GRAPH_PATH).mtimeMs).toBeGreaterThan(staleMtime);
    // The rewrite has to carry the promoted rules, or persistence alone just
    // re-pins the half-empty graph #258 complained about.
    const saved = JSON.parse(readFileSync(GRAPH_PATH, "utf-8"));
    expect(saved.nodeCount).toBe(2);
  });

  test("persisted graph contains rules-directory files", async () => {
    writeMd(MEMORY_DIR, "feedback_memory_one", "deploy sequence", "Run make rebuild before deploying.");
    writeMd(RULES_DIR, "feedback_promoted_one", "Stay focused", "Keep minimal scope, don't add unrequested features.");
    writeStaleGraph();

    await backfillCommand([]);

    const saved = JSON.parse(readFileSync(GRAPH_PATH, "utf-8"));
    expect(Object.keys(saved.nodes)).toContain("feedback_promoted_one");
    expect(Object.keys(saved.nodes)).toContain("feedback_memory_one");
    expect(saved.nodeCount).toBe(2);
  });
});
