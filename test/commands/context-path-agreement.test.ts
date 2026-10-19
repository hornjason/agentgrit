import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { isAbsolute, join, relative } from "path";
import { graphContextFile } from "../../src/adapters/paths";

/**
 * One file, one resolver (#258).
 *
 * `context refresh` wrote `~/.agentgrit/context/GRAPH-CONTEXT.md` while the
 * session-side reader looked in `~/.claude/MEMORY/STATE/GRAPH-CONTEXT.md`.
 * Both paths existed, both held a plausible-looking document, and the one the
 * session read had been frozen since 2026-10-05 — so refreshing context was a
 * no-op nobody could see. The agreement is what these tests pin down.
 */

const TMP_DIR = join(import.meta.dir, ".tmp-context-path-test");
const BIN = join(import.meta.dir, "../../bin/agentgrit.ts");
const REPO_ROOT = join(import.meta.dir, "../..");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(join(TMP_DIR, "state"), { recursive: true });
  mkdirSync(join(TMP_DIR, "signals"), { recursive: true });
  mkdirSync(join(TMP_DIR, "memory"), { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
  seed();
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = process.env.AGENTGRIT_TEST_BASE ?? "";
});

function seed(): void {
  const now = new Date().toISOString();
  const entries: Array<[string, string[], string]> = [
    ["feedback_verify_before_answering", ["testing"], "Read the source before asserting what it does"],
    ["feedback_rebuild_containers", ["deployment"], "Rebuild the container image before promoting a release"],
    ["feedback_commit_working_change", ["delivery"], "Commit after every working change"],
    ["feedback_rebuild_before_readback", ["memory"], "Rebuild the knowledge store before reading it back"],
    ["feedback_minimal_scope", ["scope"], "Add nothing beyond what the request asked for"],
    ["feedback_never_swallow_errors", ["security"], "Never swallow an error inside a catch block"],
  ];

  const nodes: Record<string, unknown> = {};
  for (const [id, domains, description] of entries) {
    nodes[id] = {
      id,
      file: `${id}.md`,
      type: "feedback",
      name: id,
      description,
      domains,
      severity: 4,
      occurrence_count: 1,
      last_updated: now,
      content_hash: id.slice(0, 8),
      memoryType: "behavioral-rule",
    };
    writeFileSync(
      join(TMP_DIR, "memory", `${id}.md`),
      `---\nname: ${id}\ndescription: ${description}\ntype: feedback\n---\n\n${description}\n`,
    );
  }

  writeFileSync(
    join(TMP_DIR, "state", "knowledge-graph.json"),
    JSON.stringify({ version: "1.0", builtAt: now, nodeCount: entries.length, edgeCount: 0, nodes, edges: [] }, null, 2),
  );
  writeFileSync(
    join(TMP_DIR, "config.json"),
    JSON.stringify({ signalDir: join(TMP_DIR, "signals"), memoryDir: join(TMP_DIR, "memory") }),
  );
}

async function runRefresh(): Promise<string> {
  const proc = Bun.spawn(["bun", BIN, "context", "refresh", "--text", "verify deployment before shipping"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AGENTGRIT_DIR: TMP_DIR },
  });
  await proc.exited;
  return await new Response(proc.stdout).text();
}

/** Every .ts file under src/, bin/ and test/. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (entry.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

describe("graph context path agreement (#258)", () => {
  test("the command writes exactly the path the resolver reports", async () => {
    const stdout = await runRefresh();

    const reported = stdout.match(/^\s*Output:\s*(.+)$/m)?.[1]?.trim();
    expect(reported).toBeDefined();

    const resolved = graphContextFile();
    expect(isAbsolute(resolved)).toBe(true);
    expect(reported).toBe(resolved);
    expect(existsSync(resolved)).toBe(true);
    expect(readFileSync(resolved, "utf-8")).toContain("# Graph Context");
  });

  test("the written file moves with the base dir, so a relocated install still agrees", async () => {
    await runRefresh();

    const resolved = graphContextFile();
    const rel = relative(TMP_DIR, resolved);
    expect(rel.startsWith("..")).toBe(false);
    expect(isAbsolute(rel)).toBe(false);
    // Nothing outside the configured base dir was written to.
    expect(resolved).toBe(join(TMP_DIR, "context", "GRAPH-CONTEXT.md"));
  });

  test("no module builds its own GRAPH-CONTEXT.md path", () => {
    // The original defect in source form: a second path literal, assembled by
    // hand, that drifts from the resolver the writer uses. Reintroducing one
    // — `join(homedir(), ".claude", "MEMORY", "STATE", "GRAPH-CONTEXT.md")`,
    // which is what test/commands/context.test.ts held before #258 — turns
    // this red.
    const PATH_BUILD = /(?:join|resolve)\s*\([^;]*GRAPH-CONTEXT\.md/;
    // The resolver is allowed to build the path — that is its job. This file
    // is allowed because it quotes the pattern in order to detect it; run the
    // scan without this exemption and it flags lines 119 and 125 below, which
    // is how the detector was shown to fire at all.
    const EXEMPT = new Set([
      join(REPO_ROOT, "src/adapters/paths.ts"),
      join(REPO_ROOT, "test/commands/context-path-agreement.test.ts"),
    ]);

    const offenders: string[] = [];
    for (const dir of ["src", "bin", "test"]) {
      for (const file of sourceFiles(join(REPO_ROOT, dir))) {
        if (EXEMPT.has(file)) continue;
        for (const [i, line] of readFileSync(file, "utf-8").split("\n").entries()) {
          if (PATH_BUILD.test(line)) offenders.push(`${relative(REPO_ROOT, file)}:${i + 1}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
