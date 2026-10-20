/**
 * #288 — doctor reported two populations as one.
 *
 * The graph is built from `memoryDir`: every `buildGraph()` call in src/ and
 * bin/ passes `resolveMemoryDir()`, and promotion writes new rules there.
 * `rulesDir` is a legacy store — read as an eviction candidate pool and as a
 * filename fallback, never indexed. Doctor unioned the two and reported the
 * union against the graph, which on a real install read "597 rule files not
 * yet in graph" while every file the graph is actually built from was indexed.
 *
 * Each test below has a control that fails against correct code, because a
 * population check that can only ever report "in sync" is the defect it is
 * meant to catch.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  checkCrossReferences,
  checkScoring,
  checkWiring,
  type CheckResult,
} from "../../src/daemon/doctor";
import type { AgentGritConfig } from "../../src/adapters/types";

let base: string;

function rule(dir: string, id: string): void {
  writeFileSync(join(dir, `${id}.md`), `---\nname: ${id}\n---\n\nbody of ${id}\n`);
}

function writeGraph(stateDir: string, ids: string[]): void {
  const nodes: Record<string, unknown> = {};
  for (const id of ids) nodes[id] = { id, file: `${id}.md`, domains: [] };
  writeFileSync(
    join(stateDir, "knowledge-graph.json"),
    JSON.stringify({ version: "1.0", nodeCount: ids.length, nodes, edges: [] }),
  );
}

function configFor(memoryDir?: string): AgentGritConfig {
  return {
    signalDir: join(base, "signals"),
    memoryDir,
    adapter: "local",
    rubrics: [],
    rules: { globalBudget: 25, projectBudget: 25, autoPromote: false },
    daemon: { interval: "daily", weeklyDay: "sunday" },
  } as AgentGritConfig;
}

const find = (checks: CheckResult[], name: string): CheckResult | undefined =>
  checks.find((c) => c.name === name);

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "agentgrit-doctor-"));
  for (const d of ["signals", "rules", "state", "memory"]) mkdirSync(join(base, d));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("doctor separates the graph corpus from the legacy rules store", () => {
  test("a fully indexed corpus is reported in sync even with an unindexed legacy store", () => {
    const memoryDir = join(base, "memory");
    rule(memoryDir, "feedback_a");
    rule(memoryDir, "feedback_b");
    for (const id of ["legacy_one", "legacy_two", "legacy_three"]) rule(join(base, "rules"), id);
    writeGraph(join(base, "state"), ["feedback_a", "feedback_b"]);

    const section = checkCrossReferences(configFor(memoryDir));

    const corpus = find(section.checks, "unindexed-corpus");
    expect(corpus?.status).toBe("ok");
    expect(corpus?.message).toContain("All 2 memoryDir rules");

    // The legacy store is reported, but as a reading rather than a fault —
    // this is the line that used to make the section warn.
    const legacy = find(section.checks, "legacy-rules-store");
    expect(legacy?.status).toBe("info");
    expect(legacy?.message).toContain("3 of 3");
    expect(section.status).toBe("ok");
  });

  test("CONTROL — an unindexed corpus file still warns", () => {
    const memoryDir = join(base, "memory");
    rule(memoryDir, "feedback_a");
    rule(memoryDir, "feedback_missing");
    writeGraph(join(base, "state"), ["feedback_a"]);

    const section = checkCrossReferences(configFor(memoryDir));

    const corpus = find(section.checks, "unindexed-corpus");
    expect(corpus?.status).toBe("warning");
    expect(corpus?.message).toContain("1 of 2 memoryDir rules not in graph");
    expect(section.status).toBe("warning");
  });

  test("MEMORY.md and README.md are excluded, matching what the builder walks", () => {
    const memoryDir = join(base, "memory");
    rule(memoryDir, "feedback_a");
    writeFileSync(join(memoryDir, "MEMORY.md"), "# index\n");
    writeFileSync(join(memoryDir, "README.md"), "# readme\n");
    writeGraph(join(base, "state"), ["feedback_a"]);

    const corpus = find(checkCrossReferences(configFor(memoryDir)).checks, "unindexed-corpus");
    // 3 .md files on disk, 1 indexable: counting the other two would report a
    // gap that no amount of indexing could ever close.
    expect(corpus?.status).toBe("ok");
    expect(corpus?.message).toContain("All 1 memoryDir rules");
  });

  test("a graph node with no backing file in either directory still warns", () => {
    const memoryDir = join(base, "memory");
    rule(memoryDir, "feedback_a");
    writeGraph(join(base, "state"), ["feedback_a", "feedback_deleted"]);

    const section = checkCrossReferences(configFor(memoryDir));
    expect(find(section.checks, "orphaned-nodes")?.status).toBe("warning");
    expect(section.status).toBe("warning");
  });
});

describe("scoring staleness is a fault only when scoring could have run", () => {
  test("no judge key — the disabled feature and its stale output are both info", () => {
    const section = checkScoring(configFor());

    expect(find(section.checks, "judge-api-key")?.status).toBe("info");
    expect(find(section.checks, "scores")?.status).toBe("info");
    expect(find(section.checks, "scores")?.message).toContain("no judge API key");
    expect(section.status).toBe("ok");
  });

  test("CONTROL — with a judge key configured, missing scores warn", () => {
    const config = configFor();
    config.judge = { provider: "anthropic", model: "claude-opus-5", apiKey: "sk-test" };

    const section = checkScoring(config);

    expect(find(section.checks, "judge-api-key")?.status).toBe("ok");
    expect(find(section.checks, "scores")?.status).toBe("warning");
    expect(section.status).toBe("warning");
  });
});

describe("the orphan-export baseline is a ratchet", () => {
  function fixture(exports: string[], baseline: string[] | null): string {
    const root = join(base, "proj");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "lib.ts"),
      exports.map((n) => `export function ${n}(): void {}`).join("\n") + "\n",
    );
    if (baseline !== null) {
      writeFileSync(
        join(root, "orphan-exports-baseline.json"),
        JSON.stringify({ orphans: baseline }),
      );
    }
    return root;
  }

  test("orphans inside the baseline are info, not warnings", () => {
    const root = fixture(["known_a", "known_b"], ["src/lib.ts:known_a", "src/lib.ts:known_b"]);

    const section = checkWiring(configFor(), root);

    expect(find(section.checks, "orphan-summary")?.status).toBe("info");
    expect(section.status).toBe("ok");
  });

  test("CONTROL — an orphan outside the baseline warns", () => {
    const root = fixture(["known_a", "brand_new"], ["src/lib.ts:known_a"]);

    const section = checkWiring(configFor(), root);

    const summary = find(section.checks, "orphan-summary");
    expect(summary?.status).toBe("warning");
    expect(summary?.message).toContain("1 new orphan export");
    expect(find(section.checks, "orphan:brand_new")?.status).toBe("warning");
    expect(section.status).toBe("warning");
  });

  test("a corrupt baseline fails closed — every orphan becomes new", () => {
    const root = fixture(["known_a"], null);
    writeFileSync(join(root, "orphan-exports-baseline.json"), "{ this is not json");

    // Fail-open here would be a guard bypass: one unparseable byte would
    // silence the whole section while still rendering as a passing check.
    expect(checkWiring(configFor(), root).status).toBe("warning");
  });

  test("a baseline entry that became wired is reported so the number can drop", () => {
    const root = fixture(["known_a"], ["src/lib.ts:known_a", "src/lib.ts:since_deleted"]);

    const summary = find(checkWiring(configFor(), root).checks, "orphan-summary");
    expect(summary?.status).toBe("info");
    expect(summary?.message).toContain("lower the baseline to 1");
  });
});
