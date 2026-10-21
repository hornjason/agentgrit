import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "fs";
import { join } from "path";

const TEMP_DIR = join(import.meta.dir, ".tmp-atomic-write-json");
const REPO_ROOT = join(import.meta.dir, "..", "..");

function siblings(dir: string, infix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.includes(infix));
}

function source(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf-8");
}

beforeEach(() => {
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true });
  mkdirSync(TEMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true });
});

describe("atomicWriteJSON", () => {
  test("writes rule-stats.json and leaves no .tmp sibling", async () => {
    const { atomicWriteJSON } = await import("../../src/adapters/atomic-write");
    const target = join(TEMP_DIR, "rule-stats.json");
    const payload = [{ ruleId: "r1", injectionCount: 3 }];

    atomicWriteJSON(target, payload);

    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual(payload);
    expect(siblings(TEMP_DIR, ".tmp.")).toEqual([]);
    expect(siblings(TEMP_DIR, ".lock")).toEqual([]);
  });

  test("writes recall-eval.json and leaves no .tmp sibling", async () => {
    const { atomicWriteJSON } = await import("../../src/adapters/atomic-write");
    const target = join(TEMP_DIR, "recall-eval.json");

    atomicWriteJSON(target, { sessionsEvaluated: 7, meanRecall5: 0.5 });

    expect(JSON.parse(readFileSync(target, "utf-8")).sessionsEvaluated).toBe(7);
    expect(siblings(TEMP_DIR, ".tmp.")).toEqual([]);
  });

  test("writes recall-scores.json and leaves no .tmp sibling", async () => {
    const { atomicWriteJSON } = await import("../../src/adapters/atomic-write");
    const target = join(TEMP_DIR, "recall-scores.json");

    atomicWriteJSON(target, { injected: { s1: ["r1"] }, entryCount: 1 });

    expect(JSON.parse(readFileSync(target, "utf-8")).entryCount).toBe(1);
    expect(siblings(TEMP_DIR, ".tmp.")).toEqual([]);
  });

  test("writes knowledge-graph.json and leaves no .tmp sibling", async () => {
    const { atomicWriteJSON } = await import("../../src/adapters/atomic-write");
    const target = join(TEMP_DIR, "knowledge-graph.json");

    atomicWriteJSON(target, { version: "1.0", nodeCount: 0, nodes: {}, edges: [] });

    expect(JSON.parse(readFileSync(target, "utf-8")).version).toBe("1.0");
    expect(siblings(TEMP_DIR, ".tmp.")).toEqual([]);
  });

  test("creates the parent directory when it does not exist", async () => {
    const { atomicWriteJSON } = await import("../../src/adapters/atomic-write");
    const nested = join(TEMP_DIR, "state", "deep");
    const target = join(nested, "rule-stats.json");

    atomicWriteJSON(target, { ok: true });

    expect(existsSync(target)).toBe(true);
  });

  test("overwrites an existing document in place", async () => {
    const { atomicWriteJSON } = await import("../../src/adapters/atomic-write");
    const target = join(TEMP_DIR, "knowledge-graph.json");
    writeFileSync(target, JSON.stringify({ nodeCount: 99 }), "utf-8");

    atomicWriteJSON(target, { nodeCount: 1 });

    expect(JSON.parse(readFileSync(target, "utf-8")).nodeCount).toBe(1);
    expect(siblings(TEMP_DIR, ".tmp.")).toEqual([]);
  });

  test("leaves no temp residue and no partial file when serialisation throws", async () => {
    const { atomicWriteJSON } = await import("../../src/adapters/atomic-write");
    const target = join(TEMP_DIR, "rule-stats.json");
    const unserialisable = { n: 1n } as unknown;

    expect(() => atomicWriteJSON(target, unserialisable)).toThrow();
    expect(existsSync(target)).toBe(false);
    expect(siblings(TEMP_DIR, ".tmp.")).toEqual([]);
    expect(siblings(TEMP_DIR, ".lock")).toEqual([]);
  });

  test("two writes from one process do not collide on the same temp name", async () => {
    const { atomicWriteJSON } = await import("../../src/adapters/atomic-write");
    const a = join(TEMP_DIR, "rule-stats.json");
    const b = join(TEMP_DIR, "recall-scores.json");

    atomicWriteJSON(a, { which: "a" });
    atomicWriteJSON(b, { which: "b" });

    expect(JSON.parse(readFileSync(a, "utf-8")).which).toBe("a");
    expect(JSON.parse(readFileSync(b, "utf-8")).which).toBe("b");
    expect(siblings(TEMP_DIR, ".tmp.")).toEqual([]);
  });

  test("proceeds and still writes when a fresh lock is held by someone else", async () => {
    const { atomicWriteJSON } = await import("../../src/adapters/atomic-write");
    const target = join(TEMP_DIR, "knowledge-graph.json");
    writeFileSync(target + ".lock", "", "utf-8");

    atomicWriteJSON(target, { nodeCount: 2 });

    expect(JSON.parse(readFileSync(target, "utf-8")).nodeCount).toBe(2);
    expect(siblings(TEMP_DIR, ".tmp.")).toEqual([]);
    // Somebody else's lock is left alone — only its owner removes it.
    expect(existsSync(target + ".lock")).toBe(true);
  });
});

describe("cleanupOrphanedTmpFiles", () => {
  test("removes orphaned temp siblings of rule-stats.json only", async () => {
    const { cleanupOrphanedTmpFiles } = await import("../../src/adapters/atomic-write");
    writeFileSync(join(TEMP_DIR, "rule-stats.json.tmp.111"), "{}", "utf-8");
    writeFileSync(join(TEMP_DIR, "rule-stats.json.tmp.222"), "{}", "utf-8");
    writeFileSync(join(TEMP_DIR, "knowledge-graph.json.tmp.333"), "{}", "utf-8");
    writeFileSync(join(TEMP_DIR, "rule-stats.json"), "[]", "utf-8");

    cleanupOrphanedTmpFiles(TEMP_DIR, "rule-stats.json");

    expect(existsSync(join(TEMP_DIR, "rule-stats.json.tmp.111"))).toBe(false);
    expect(existsSync(join(TEMP_DIR, "rule-stats.json.tmp.222"))).toBe(false);
    expect(existsSync(join(TEMP_DIR, "knowledge-graph.json.tmp.333"))).toBe(true);
    expect(existsSync(join(TEMP_DIR, "rule-stats.json"))).toBe(true);
  });

  test("tolerates a missing directory", async () => {
    const { cleanupOrphanedTmpFiles } = await import("../../src/adapters/atomic-write");
    expect(() => cleanupOrphanedTmpFiles(join(TEMP_DIR, "nope"), "rule-stats.json")).not.toThrow();
  });
});

describe("state writers persist through the shared helper", () => {
  test("exactly one atomicWriteJSON helper is exported across src and bin", () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) {
          if (readFileSync(full, "utf-8").includes("export function atomicWriteJSON")) {
            hits.push(full.slice(REPO_ROOT.length + 1));
          }
        }
      }
    };
    walk(join(REPO_ROOT, "src"));
    walk(join(REPO_ROOT, "bin"));
    expect(hits).toEqual(["src/adapters/atomic-write.ts"]);
  });

  test("rule-stats.json writer in rules.ts routes through atomicWriteJSON", () => {
    const src = source("src/promote/rules.ts");
    expect(src).toContain("atomicWriteJSON");
    expect(src).not.toContain("writeFileSync(");
  });

  test("knowledge-graph.json writer in builder.ts routes through atomicWriteJSON", () => {
    const src = source("src/graph/builder.ts");
    expect(src).toContain("atomicWriteJSON");
    expect(src).not.toContain("writeFileSync(");
  });

  test("knowledge-graph.json writer in attribution.ts routes through atomicWriteJSON", () => {
    const src = source("src/graph/attribution.ts");
    expect(src).toContain("atomicWriteJSON");
    expect(src).not.toContain("writeFileSync(");
  });

  test("recall-scores.json and recall-eval.json writers in eval.ts route through atomicWriteJSON", () => {
    const lines = source("bin/commands/eval.ts").split("\n");

    // The write for each file is the first write statement after the line that
    // names it. Checking the whole file would be satisfied by eval.ts's other,
    // out-of-scope writers; checking the window cannot be.
    const writeWindows = (needle: string): string[] =>
      lines
        .map((l, i) => (l.includes(`"state", "${needle}"`) ? lines.slice(i, i + 6).join("\n") : null))
        .filter((w): w is string => w !== null)
        .filter((w) => w.includes("writeFileSync(") || w.includes("atomicWriteJSON("));

    for (const file of ["recall-scores.json", "recall-eval.json"]) {
      const windows = writeWindows(file);
      expect(windows.length).toBeGreaterThan(0);
      for (const window of windows) {
        expect(window).toContain("atomicWriteJSON(");
        expect(window).not.toContain("writeFileSync(");
      }
    }
  });

  test("rule-lifecycle.json writer in lifecycle.ts carries no inline temp naming", () => {
    const src = source("src/promote/lifecycle.ts");
    expect(src).toContain("atomicWriteJSON");
    expect(src.includes(".tmp.")).toBe(false);
  });

  test("persistRuleStats writes rule-stats.json with no temp residue", async () => {
    const { persistRuleStats } = await import("../../src/promote/rules");
    const dir = join(TEMP_DIR, "state");
    persistRuleStats(
      [
        {
          ruleId: "r1",
          injectionCount: 2,
          avgCorrelatedRating: 7,
          sessionRatings: [7, 7],
          highRatingActivations: 2,
          lowRatingActivations: 0,
          lastSeen: "2026-01-01T00:00:00.000Z",
        },
      ],
      dir,
    );

    const target = join(dir, "rule-stats.json");
    expect(JSON.parse(readFileSync(target, "utf-8"))[0].ruleId).toBe("r1");
    expect(siblings(dir, ".tmp.")).toEqual([]);
    expect(siblings(dir, ".lock")).toEqual([]);
  });

  test("writeGraphFile writes knowledge-graph.json with no temp residue", async () => {
    const stateRoot = join(TEMP_DIR, "base");
    mkdirSync(join(stateRoot, "state"), { recursive: true });
    const prevDir = process.env.AGENTGRIT_DIR;
    process.env.AGENTGRIT_DIR = stateRoot;
    try {
      const { writeGraphFile } = await import("../../src/graph/builder");
      writeGraphFile({
        version: "1.0",
        builtAt: new Date().toISOString(),
        nodeCount: 0,
        edgeCount: 0,
        nodes: {},
        edges: [],
      });
      const dir = join(stateRoot, "state");
      const target = join(dir, "knowledge-graph.json");
      expect(existsSync(target)).toBe(true);
      expect(JSON.parse(readFileSync(target, "utf-8")).version).toBe("1.0");
      expect(siblings(dir, ".tmp.")).toEqual([]);
      expect(siblings(dir, ".lock")).toEqual([]);
    } finally {
      if (prevDir === undefined) delete process.env.AGENTGRIT_DIR;
      else process.env.AGENTGRIT_DIR = prevDir;
    }
  });
});
