import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const TMP_DIR = join(import.meta.dir, ".tmp-atomic-write-json");
const STATE_DIR = join(TMP_DIR, "state");
const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * Anything the write path left behind that is not the document itself.
 *
 * `.tmp.` catches the scratch file a temp-write-and-rename uses; `.lock` catches
 * the mutex. Both are invisible to a reader of the final JSON, which is exactly
 * why they accumulated unnoticed until 36 of them were found by hand.
 */
function residue(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.includes(".tmp.") || f.endsWith(".lock")).sort();
}

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = process.env.AGENTGRIT_TEST_BASE ?? "";
});

describe("atomicWriteJSON", () => {
  test("writes a parseable document and leaves no residue", async () => {
    const { atomicWriteJSON } = await import("../../src/adapters/atomic-write");
    const target = join(STATE_DIR, "thing.json");

    atomicWriteJSON(target, { a: 1, b: ["x"] });

    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ a: 1, b: ["x"] });
    expect(residue(STATE_DIR)).toEqual([]);
  });

  test("creates the parent directory when it does not exist", async () => {
    const { atomicWriteJSON } = await import("../../src/adapters/atomic-write");
    const target = join(TMP_DIR, "nested", "deeper", "thing.json");

    atomicWriteJSON(target, { ok: true });

    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ ok: true });
  });

  test("replaces existing content without leaving the previous document", async () => {
    const { atomicWriteJSON } = await import("../../src/adapters/atomic-write");
    const target = join(STATE_DIR, "thing.json");
    writeFileSync(target, JSON.stringify({ generation: 1 }), "utf-8");

    atomicWriteJSON(target, { generation: 2 });

    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ generation: 2 });
    expect(residue(STATE_DIR)).toEqual([]);
  });

  test("releases the lock so a second write can take it", async () => {
    const { atomicWriteJSON } = await import("../../src/adapters/atomic-write");
    const target = join(STATE_DIR, "thing.json");

    atomicWriteJSON(target, { n: 1 });
    expect(existsSync(target + ".lock")).toBe(false);
    atomicWriteJSON(target, { n: 2 });

    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ n: 2 });
    expect(residue(STATE_DIR)).toEqual([]);
  });

  test("removes a temp file left by an interrupted write", async () => {
    const { cleanupTmpFiles } = await import("../../src/adapters/atomic-write");
    writeFileSync(join(STATE_DIR, "thing.json.tmp.9999"), "{partial", "utf-8");
    writeFileSync(join(STATE_DIR, "thing.json"), "{}", "utf-8");

    cleanupTmpFiles(STATE_DIR, "thing.json");

    expect(residue(STATE_DIR)).toEqual([]);
    expect(existsSync(join(STATE_DIR, "thing.json"))).toBe(true);
  });

  test("does not delete a temp file belonging to a different document", async () => {
    const { cleanupTmpFiles } = await import("../../src/adapters/atomic-write");
    const other = join(STATE_DIR, "other.json.tmp.1");
    writeFileSync(other, "{}", "utf-8");

    cleanupTmpFiles(STATE_DIR, "thing.json");

    expect(existsSync(other)).toBe(true);
  });
});

describe("state file writers route through the shared helper", () => {
  test("rule-stats.json: persistRuleStats leaves no .tmp sibling", async () => {
    const { persistRuleStats, loadRuleStats } = await import("../../src/promote/rules");

    persistRuleStats(
      [
        {
          ruleId: "r1",
          injectionCount: 3,
          avgCorrelatedRating: 7.5,
          sessionRatings: [7, 8],
          highRatingActivations: 1,
          lowRatingActivations: 0,
          lastSeen: "2026-01-01T00:00:00.000Z",
        },
      ],
      STATE_DIR,
    );

    expect(residue(STATE_DIR)).toEqual([]);
    const loaded = loadRuleStats(STATE_DIR);
    expect(loaded.get("r1")?.injectionCount).toBe(3);
  });

  test("rule-stats.json: bootstrapDifferentialStats leaves no .tmp sibling", async () => {
    const { bootstrapDifferentialStats } = await import("../../src/promote/rules");
    const statsPath = join(STATE_DIR, "rule-stats.json");
    const ratingsPath = join(STATE_DIR, "ratings.jsonl");
    writeFileSync(
      statsPath,
      JSON.stringify([
        {
          ruleId: "r1",
          injectionCount: 2,
          avgCorrelatedRating: 8,
          sessionRatings: [8, 8],
          highRatingActivations: 2,
          lowRatingActivations: 0,
          lastSeen: "2026-01-01T00:00:00.000Z",
        },
      ]),
      "utf-8",
    );
    writeFileSync(ratingsPath, `${JSON.stringify({ rating: 6 })}\n${JSON.stringify({ rating: 4 })}\n`, "utf-8");

    const result = bootstrapDifferentialStats(statsPath, ratingsPath);

    expect(result.rulesProcessed).toBe(1);
    expect(residue(STATE_DIR)).toEqual([]);
    const written = JSON.parse(readFileSync(statsPath, "utf-8"));
    expect(written[0].differentialLift).toBe(3);
  });

  test("knowledge-graph.json: writeGraphFile leaves no .tmp sibling", async () => {
    const { writeGraphFile } = await import("../../src/graph/builder");

    writeGraphFile({
      version: "1.0",
      builtAt: new Date().toISOString(),
      nodeCount: 0,
      edgeCount: 0,
      nodes: {
        r1: {
          id: "r1",
          file: "r1.md",
          type: "rule",
          name: "Rule 1",
          description: "test",
          domains: ["testing"],
          severity: 3,
          occurrence_count: 1,
          last_updated: new Date().toISOString(),
          content_hash: "a",
          memoryType: "behavioral-rule",
        },
      },
      edges: [],
    });

    const target = join(STATE_DIR, "knowledge-graph.json");
    expect(existsSync(target)).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf-8")).nodeCount).toBe(1);
    expect(residue(STATE_DIR)).toEqual([]);
  });

  test("knowledge-graph.json: attribution's edge-weight write leaves no .tmp sibling", async () => {
    const { updateEdgeWeightsFromRating } = await import("../../src/graph/attribution");
    const target = join(STATE_DIR, "knowledge-graph.json");
    writeFileSync(
      target,
      JSON.stringify({
        version: "1.0",
        builtAt: new Date().toISOString(),
        nodeCount: 2,
        edgeCount: 1,
        nodes: {},
        edges: [{ from: "r1", to: "r2", relationship: "co_occurred", strength: 0.5 }],
      }),
      "utf-8",
    );

    updateEdgeWeightsFromRating(
      {
        ruleIds: ["r1", "r2"],
        domains: ["testing"],
        domain_source: "keyword",
        timestamp: new Date().toISOString(),
        ttl: 86400000,
        rulesInjectedCount: 2,
        rulesInjectedKB: 1,
      },
      9,
      target,
    );

    expect(JSON.parse(readFileSync(target, "utf-8")).edges[0].strength).toBeCloseTo(0.575, 3);
    expect(residue(STATE_DIR)).toEqual([]);
  });

  test("recall-scores.json: the eval bootstrap write goes through atomicWriteJSON", async () => {
    const { atomicWriteJSON } = await import("../../src/adapters/atomic-write");
    const src = readFileSync(join(REPO_ROOT, "bin", "commands", "eval.ts"), "utf-8");

    expect(src).toContain("atomicWriteJSON(scoresPath,");
    expect(src).not.toContain("writeFileSync(scoresPath,");

    const target = join(STATE_DIR, "recall-scores.json");
    atomicWriteJSON(target, { injected: { s1: ["r1"] }, entryCount: 1 });
    expect(JSON.parse(readFileSync(target, "utf-8")).entryCount).toBe(1);
    expect(residue(STATE_DIR)).toEqual([]);
  });

  test("recall-eval.json: the eval summary write goes through atomicWriteJSON", async () => {
    const { atomicWriteJSON } = await import("../../src/adapters/atomic-write");
    const src = readFileSync(join(REPO_ROOT, "bin", "commands", "eval.ts"), "utf-8");

    expect(src).toContain("atomicWriteJSON(recallEvalPath,");
    expect(src).not.toContain("writeFileSync(recallEvalPath,");

    const target = join(STATE_DIR, "recall-eval.json");
    atomicWriteJSON(target, { sessionsEvaluated: 3, meanRecall5: 0.4 });
    expect(JSON.parse(readFileSync(target, "utf-8")).sessionsEvaluated).toBe(3);
    expect(residue(STATE_DIR)).toEqual([]);
  });

  test("rule-lifecycle.json: saveLifecycle no longer carries its own temp naming", async () => {
    const { transitionRule, loadLifecycle } = await import("../../src/promote/lifecycle");
    const lifecycleSrc = readFileSync(join(REPO_ROOT, "src", "promote", "lifecycle.ts"), "utf-8");

    expect(lifecycleSrc).not.toContain(".tmp.");

    transitionRule("r1", "evicted", "low correlation", "test", STATE_DIR);

    expect(loadLifecycle(STATE_DIR).rules["r1"].state).toBe("evicted");
    expect(residue(STATE_DIR)).toEqual([]);
  });
});
