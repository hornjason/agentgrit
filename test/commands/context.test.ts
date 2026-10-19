import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * The fixture install. Deliberately outside the repo.
 *
 * This used to be `test/commands/.tmp-context-test`, which sits inside the working
 * tree, so `detectDomainsFromGitStatus` (src/graph/context.ts:957) walked up, found
 * the repo's .git, and seeded the fallback domains from whichever files the
 * developer happened to have dirty — [code] on one machine, [ui, infra, security,
 * testing] on another, [] on a clean CI runner. Under tmpdir() there is no .git to
 * find, so `git status` fails identically everywhere (issue #249).
 *
 * Suffixed with the pid so two concurrent `bun test` processes cannot share it.
 */
const TMP_DIR = join(tmpdir(), `agentgrit-context-test-${process.pid}`);

// Must match graphContextFile() in src/adapters/paths.ts, which resolves to
// <AGENTGRIT_DIR>/context/GRAPH-CONTEXT.md. This used to be hardcoded to
// ~/.claude/MEMORY/STATE/GRAPH-CONTEXT.md — a path the command has not written
// to since graphContextFile() was introduced. Every assertion below was reading
// whatever the developer's live install had last left there, so these tests
// passed or failed on host state: green on a machine with a populated file,
// red on CI where the path does not exist at all (issue #249).
const GRAPH_CONTEXT_PATH = join(TMP_DIR, "context", "GRAPH-CONTEXT.md");

const BIN = join(import.meta.dir, "../../bin/agentgrit.ts");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(join(TMP_DIR, "state"), { recursive: true });
  mkdirSync(join(TMP_DIR, "signals"), { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
  process.env.AGENTGRIT_DIR = process.env.AGENTGRIT_TEST_BASE ?? "";
});

function seedGraph(): void {
  const graph = {
    version: "1.0",
    builtAt: new Date().toISOString(),
    nodeCount: 4,
    edgeCount: 1,
    nodes: {
      feedback_verify_before_answering: {
        id: "feedback_verify_before_answering",
        file: "feedback_verify_before_answering.md",
        type: "feedback",
        name: "verify_before_answering",
        description: "Never assume code behavior; read source first",
        domains: ["testing"],
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
        domains: ["algorithm", "graph"],
        severity: 3,
        occurrence_count: 2,
        last_updated: new Date().toISOString(),
        content_hash: "ghi789",
        memoryType: "behavioral-rule",
      },
      // Carries one of doRefresh's last-resort domains (see bin/commands/context.ts:136,
      // ["verification", "delivery", "deployment"]). Without a node in one of those, the
      // fallback chain runs to completion and still retrieves nothing, so a test for the
      // fallback can only ever assert emptiness.
      feedback_verify_deploy: {
        id: "feedback_verify_deploy",
        file: "feedback_verify_deploy.md",
        type: "feedback",
        name: "verify_deploy",
        description: "Verify a deployment reached the target before reporting delivery",
        domains: ["verification", "deployment"],
        severity: 4,
        occurrence_count: 4,
        last_updated: new Date().toISOString(),
        content_hash: "jkl012",
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
    // TMP_DIR is not a git repo, so detectDomainsFromGitStatus (src/graph/context.ts:957)
    // throws and yields []. Inheriting the repo cwd instead made the fallback domains a
    // function of whichever files the developer happened to have dirty — empty on a clean
    // CI checkout, [code]/[ui, infra, security, testing] on a working machine (issue #249).
    cwd: TMP_DIR,
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

  // Named ">=5 rules" but only ever asserted >=1, and read a file the command does
  // not write. Renamed to the guarantee it actually checks: no query matches any
  // term in the corpus, so this passes only if the last-resort domain fallback in
  // doRefresh fires and retrieves on domain alone.
  test("unmatchable input still retrieves rules via the last-resort domain fallback", async () => {
    seedGraph();
    const result = await runContext("--text", "xyzzy foobar quux blorp");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Fallback: last resort defaults");
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
      cwd: TMP_DIR,
      env: { ...process.env, AGENTGRIT_DIR: TMP_DIR },
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
  });
});
