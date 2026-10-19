/**
 * The writer (`agentgrit context refresh`) and the reader (a fresh session
 * resolving `graphContextFile()`) must land on the same absolute file.
 *
 * These checks can fail: reverting the lazy path resolution in
 * bin/commands/context.ts — i.e. hoisting `graphContextFile()` back to a
 * module-level const — turns the "base dir changes after import" test red,
 * because the refresh then writes to the base dir that happened to be active
 * when the module loaded. Pinning the writer to a hardcoded path turns the
 * config-override test red for the same reason.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readdirSync, statSync } from "fs";
import { isAbsolute, join } from "path";

const TMP_ROOT = join(import.meta.dir, ".tmp-context-path-test");
const BIN = join(import.meta.dir, "../../bin/agentgrit.ts");
const PATHS_MODULE = join(import.meta.dir, "../../src/adapters/paths.ts");

const ORIGINAL_DIR = process.env.AGENTGRIT_DIR;

beforeEach(() => {
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true });
  mkdirSync(TMP_ROOT, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true });
  if (ORIGINAL_DIR === undefined) delete process.env.AGENTGRIT_DIR;
  else process.env.AGENTGRIT_DIR = ORIGINAL_DIR;
});

/** A base dir with a graph, memory files and a config — enough for a refresh. */
function seedBase(base: string, extraConfig: Record<string, unknown> = {}): string {
  mkdirSync(join(base, "state"), { recursive: true });
  mkdirSync(join(base, "signals"), { recursive: true });
  mkdirSync(join(base, "memory"), { recursive: true });

  const now = new Date().toISOString();
  const nodes = {
    feedback_verify_before_answering: {
      id: "feedback_verify_before_answering",
      file: "feedback_verify_before_answering.md",
      type: "feedback",
      name: "verify_before_answering",
      description: "Never assume code behavior; read source first",
      domains: ["testing"],
      severity: 4,
      occurrence_count: 5,
      last_updated: now,
      content_hash: "abc123",
      memoryType: "behavioral-rule",
    },
    feedback_scoring_bm25: {
      id: "feedback_scoring_bm25",
      file: "feedback_scoring_bm25.md",
      type: "feedback",
      name: "scoring_bm25",
      description: "BM25 scoring must use real query embeddings not centroids",
      domains: ["algorithm", "graph"],
      severity: 3,
      occurrence_count: 2,
      last_updated: now,
      content_hash: "ghi789",
      memoryType: "behavioral-rule",
    },
  };

  writeFileSync(
    join(base, "state", "knowledge-graph.json"),
    JSON.stringify({ version: "1.0", builtAt: now, nodeCount: 2, edgeCount: 0, nodes, edges: [] }, null, 2),
  );

  for (const [id, node] of Object.entries(nodes)) {
    writeFileSync(
      join(base, "memory", `${id}.md`),
      `---\nname: ${node.name}\ndescription: ${node.description}\ntype: feedback\n---\n\n${node.description}`,
    );
  }

  writeFileSync(
    join(base, "config.json"),
    JSON.stringify({
      signalDir: join(base, "signals"),
      memoryDir: join(base, "memory"),
      ...extraConfig,
    }),
  );

  return base;
}

/** Every GRAPH-CONTEXT.md anywhere under `dir`, as absolute paths. */
function findContextFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === "GRAPH-CONTEXT.md") found.push(full);
    }
  };
  walk(dir);
  return found.sort();
}

async function runRefresh(base: string, ...extraArgs: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", BIN, "context", "refresh", ...extraArgs], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AGENTGRIT_DIR: base },
  });
  const exitCode = await proc.exited;
  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

/** What a fresh session (a brand-new process) resolves as the graph context path. */
async function readerPath(base: string): Promise<string> {
  const proc = Bun.spawn(
    ["bun", "-e", `const p = await import(${JSON.stringify(PATHS_MODULE)}); console.log(p.graphContextFile());`],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, AGENTGRIT_DIR: base } },
  );
  await proc.exited;
  return (await new Response(proc.stdout).text()).trim();
}

describe("context refresh path agreement", () => {
  test("the file refresh writes is the file a fresh session resolves", async () => {
    const base = seedBase(join(TMP_ROOT, "default"));

    const result = await runRefresh(base, "--text", "Fix BM25 scoring");
    expect(result.exitCode).toBe(0);

    const written = findContextFiles(base);
    expect(written).toHaveLength(1);

    const reader = await readerPath(base);
    expect(isAbsolute(reader)).toBe(true);
    expect(written[0]).toBe(reader);

    // The path the command reports is the path it wrote.
    const reported = result.stdout.match(/Output: (.+)/)?.[1]?.trim();
    expect(reported).toBe(reader);
  });

  test("a configured graphContextFile moves writer and reader together", async () => {
    const base = join(TMP_ROOT, "configured");
    const custom = join(base, "host-visible", "GRAPH-CONTEXT.md");
    seedBase(base, { paths: { graphContextFile: custom } });

    const result = await runRefresh(base, "--text", "Fix BM25 scoring");
    expect(result.exitCode).toBe(0);

    const written = findContextFiles(base);
    expect(written).toEqual([custom]);
    expect(await readerPath(base)).toBe(custom);
  });

  test("refresh writes under the base dir active at call time, not at import time", async () => {
    const importTime = seedBase(join(TMP_ROOT, "import-time"));
    const callTime = seedBase(join(TMP_ROOT, "call-time"));

    process.env.AGENTGRIT_DIR = importTime;
    const { contextCommand } = await import("../../bin/commands/context");

    process.env.AGENTGRIT_DIR = callTime;
    await contextCommand(["refresh", "--text", "Fix BM25 scoring"]);

    expect(findContextFiles(callTime)).toEqual([join(callTime, "context", "GRAPH-CONTEXT.md")]);
    expect(findContextFiles(importTime)).toEqual([]);
  });
});
