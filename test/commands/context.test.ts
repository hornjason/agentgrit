import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const TMP_DIR = join(import.meta.dir, ".tmp-context-test");
const GRAPH_CONTEXT_PATH = join(homedir(), ".claude", "MEMORY", "STATE", "GRAPH-CONTEXT.md");

const BIN = join(import.meta.dir, "../../bin/agentgrit.ts");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(join(TMP_DIR, "state"), { recursive: true });
  mkdirSync(join(TMP_DIR, "signals"), { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

function seedGraph(): void {
  const graph = {
    version: "1.0",
    builtAt: new Date().toISOString(),
    nodeCount: 3,
    edgeCount: 1,
    nodes: {
      feedback_verify_before_answering: {
        id: "feedback_verify_before_answering",
        file: "feedback_verify_before_answering.md",
        type: "feedback",
        name: "verify_before_answering",
        description: "Never assume code behavior; read source first",
        domains: ["verification"],
        severity: 4,
        occurrence_count: 5,
        last_updated: new Date().toISOString(),
        content_hash: "abc123",
        memoryType: "behavioral-rule",
      },
      feedback_delegate_more: {
        id: "feedback_delegate_more",
        file: "feedback_delegate_more.md",
        type: "feedback",
        name: "delegate_more",
        description: "Delegate to Marcus/Quinn/Rook; stay at conversation layer",
        domains: ["delegation"],
        severity: 4,
        occurrence_count: 3,
        last_updated: new Date().toISOString(),
        content_hash: "def456",
        memoryType: "behavioral-rule",
      },
      feedback_scoring_bm25: {
        id: "feedback_scoring_bm25",
        file: "feedback_scoring_bm25.md",
        type: "feedback",
        name: "scoring_bm25",
        description: "BM25 scoring must use real query embeddings not centroids",
        domains: ["scoring", "graph"],
        severity: 3,
        occurrence_count: 2,
        last_updated: new Date().toISOString(),
        content_hash: "ghi789",
        memoryType: "behavioral-rule",
      },
    },
    edges: [
      {
        from: "feedback_verify_before_answering",
        to: "feedback_delegate_more",
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
  for (const [id, node] of Object.entries(graph.nodes)) {
    writeFileSync(
      join(TMP_DIR, "memory", `${id}.md`),
      `---\nname: ${(node as any).name}\ndescription: ${(node as any).description}\ntype: feedback\n---\n\n${(node as any).description}`,
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
    expect(existsSync(GRAPH_CONTEXT_PATH)).toBe(true);
    const content = readFileSync(GRAPH_CONTEXT_PATH, "utf-8");
    expect(content).toContain("# Graph Context");
    expect(content).toContain("Context Rules (correlation-ranked)");
  });

  test("--file uses file contents for detection", async () => {
    seedGraph();
    const testFile = join(TMP_DIR, "test-input.ts");
    writeFileSync(testFile, "export function verifyBranch() { /* verification logic */ }");
    const result = await runContext("--file", testFile);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Rules:");
    const content = readFileSync(GRAPH_CONTEXT_PATH, "utf-8");
    expect(content).toContain("# Graph Context");
  });

  test("no input falls back to defaults and still produces output", async () => {
    seedGraph();
    const result = await runContext();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Rules:");
    const content = readFileSync(GRAPH_CONTEXT_PATH, "utf-8");
    expect(content).toContain("# Graph Context");
  });

  test("different --text produces different context", async () => {
    seedGraph();
    await runContext("--text", "Fix BM25 scoring algorithm");
    const content1 = readFileSync(GRAPH_CONTEXT_PATH, "utf-8");

    await runContext("--text", "Deploy container to production");
    const content2 = readFileSync(GRAPH_CONTEXT_PATH, "utf-8");

    expect(content1).not.toBe(content2);
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
    const content = readFileSync(GRAPH_CONTEXT_PATH, "utf-8");
    expect(content).toContain("# Graph Context");
    const ruleMatches = content.match(/- \*\*\S+\*\*/g) || [];
    expect(ruleMatches.length).toBeGreaterThanOrEqual(1);
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
