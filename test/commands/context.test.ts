import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { graphContextFile } from "../../src/adapters/paths";

const TMP_DIR = join(import.meta.dir, ".tmp-context-test");

/**
 * Resolved per call, not once at import (#258).
 *
 * This used to be `join(homedir(), ".claude", "MEMORY", "STATE",
 * "GRAPH-CONTEXT.md")` — a path the CLI has never written. Every assertion
 * below was reading a stale file from a previous system, so two different
 * `--text` runs were byte-identical no matter what the command produced.
 * `graphContextFile()` is the same resolver the command writes through.
 */
function graphContextPath(): string {
  return graphContextFile();
}

/** The `- **id** [tag] (score: n)` bullets, in order. */
function ruleIdsIn(markdown: string): string[] {
  return [...markdown.matchAll(/^- \*\*([^*]+)\*\*/gm)].map(m => m[1]);
}

const BIN = join(import.meta.dir, "../../bin/agentgrit.ts");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(join(TMP_DIR, "state"), { recursive: true });
  mkdirSync(join(TMP_DIR, "signals"), { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = process.env.AGENTGRIT_TEST_BASE ?? "";
});

/** id → [domains, description]. Wide enough that two queries can disagree. */
const SEED_NODES: Array<[string, string[], string]> = [
  ["feedback_verify_before_answering", ["testing"], "Never assume code behavior; read source first"],
  ["feedback_failing_test_first", ["testing"], "Write the failing regression test before the implementation"],
  ["feedback_delegate_more", ["delegation"], "Delegate wide multi-file tracks; stay at the conversation layer"],
  ["feedback_scoring_bm25", ["algorithm"], "BM25 scoring must use real query embeddings not centroids"],
  ["feedback_rebuild_containers", ["deployment"], "Rebuild the container image before promoting a release"],
  ["feedback_deploy_gate", ["deployment"], "Deploy only after the gate reports green on the changed files"],
  ["feedback_commit_working_change", ["delivery"], "Commit after every working change; uncommitted work is lost work"],
  ["feedback_look_at_the_page", ["ui"], "Look at the rendered page before calling the change done"],
  ["feedback_never_swallow_errors", ["security"], "Never swallow an error inside a catch block"],
  ["feedback_rebuild_before_readback", ["memory"], "Rebuild the knowledge store before reading it back"],
  ["feedback_pin_tool_versions", ["infra"], "Pin the tool version before relying on a newer flag"],
  ["feedback_minimal_scope", ["scope"], "Add nothing beyond what the request asked for"],
];

function seedGraph(): void {
  const now = new Date().toISOString();
  const nodes: Record<string, unknown> = {};
  for (const [id, domains, description] of SEED_NODES) {
    nodes[id] = {
      id,
      file: `${id}.md`,
      type: "feedback",
      name: id.replace(/^feedback_/, ""),
      description,
      domains,
      severity: 4,
      occurrence_count: 2,
      last_updated: now,
      content_hash: id.slice(0, 8),
      memoryType: "behavioral-rule",
    };
  }

  const graph = {
    version: "1.0",
    builtAt: now,
    nodeCount: SEED_NODES.length,
    edgeCount: 1,
    nodes,
    edges: [
      {
        from: "feedback_verify_before_answering",
        to: "feedback_failing_test_first",
        relationship: "same_domain",
        strength: 0.5,
      },
    ],
  };

  writeFileSync(
    join(TMP_DIR, "state", "knowledge-graph.json"),
    JSON.stringify(graph, null, 2),
  );

  mkdirSync(join(TMP_DIR, "memory"), { recursive: true });
  for (const [id, , description] of SEED_NODES) {
    writeFileSync(
      join(TMP_DIR, "memory", `${id}.md`),
      `---\nname: ${id}\ndescription: ${description}\ntype: feedback\n---\n\n${description}\n`,
    );
  }

  writeFileSync(
    join(TMP_DIR, "config.json"),
    JSON.stringify({ signalDir: join(TMP_DIR, "signals"), memoryDir: join(TMP_DIR, "memory") }),
  );
}

async function runContext(...extraArgs: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", BIN, "context", "refresh", ...extraArgs], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AGENTGRIT_DIR: TMP_DIR },
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

describe("context refresh", () => {
  test("--text produces GRAPH-CONTEXT.md", async () => {
    seedGraph();
    const result = await runContext("--text", "Fix BM25 scoring");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Rules:");
    expect(existsSync(graphContextPath())).toBe(true);
    const content = readFileSync(graphContextPath(), "utf-8");
    expect(content).toContain("# Graph Context");
    expect(content).toContain("Context Rules (correlation-ranked)");
    expect(ruleIdsIn(content).length).toBeGreaterThan(0);
  });

  test("--file uses file contents for detection", async () => {
    seedGraph();
    const testFile = join(TMP_DIR, "test-input.ts");
    writeFileSync(testFile, "export function verifyBranch() { /* verification logic */ }");
    const result = await runContext("--file", testFile);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Rules:");
    const content = readFileSync(graphContextPath(), "utf-8");
    expect(content).toContain("# Graph Context");
  });

  test("no input falls back to defaults and still produces output", async () => {
    seedGraph();
    const result = await runContext();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Rules:");
    const content = readFileSync(graphContextPath(), "utf-8");
    expect(content).toContain("# Graph Context");
  });

  test("different --text produces different context", async () => {
    seedGraph();
    // A tight limit makes ranking decide the contents; at limit 10 over a
    // 12-node graph both queries would return nearly everything and the
    // assertion would hold for no reason worth trusting.
    await runContext("--limit", "4", "--text", "Fix BM25 scoring algorithm");
    const content1 = readFileSync(graphContextPath(), "utf-8");

    await runContext("--limit", "4", "--text", "Deploy container to production");
    const content2 = readFileSync(graphContextPath(), "utf-8");

    expect(content1).not.toBe(content2);
    // Not just the regenerated timestamp — the rules themselves differ.
    expect(ruleIdsIn(content2)).not.toEqual(ruleIdsIn(content1));
  });

  test("writes session-context.json alongside GRAPH-CONTEXT.md", async () => {
    seedGraph();
    await runContext("--text", "verification task");
    const sessionPath = join(TMP_DIR, "state", "session-context.json");
    expect(existsSync(sessionPath)).toBe(true);
    const session = JSON.parse(readFileSync(sessionPath, "utf-8"));
    expect(session.ruleIds).toBeInstanceOf(Array);
    expect(session.domains).toBeInstanceOf(Array);
  });

  test("nonsense input still produces >=5 rules via fallback", async () => {
    seedGraph();
    const result = await runContext("--text", "xyzzy foobar quux blorp");
    expect(result.exitCode).toBe(0);
    const content = readFileSync(graphContextPath(), "utf-8");
    expect(content).toContain("# Graph Context");
    expect(ruleIdsIn(content).length).toBeGreaterThanOrEqual(5);
  });

  test("shows usage without subcommand", async () => {
    seedGraph();
    const proc = Bun.spawn(["bun", BIN, "context"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AGENTGRIT_DIR: TMP_DIR },
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
  });
});
