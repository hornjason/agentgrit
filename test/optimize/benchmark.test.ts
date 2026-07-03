import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { buildBenchmark, loadBenchmark, saveBenchmark, verifyBenchmark } from "../../src/optimize/benchmark";
import type { Benchmark } from "../../src/optimize/benchmark";

const TMP_DIR = join(import.meta.dir, ".tmp-benchmark-test");

function writeJsonl(filePath: string, entries: unknown[]): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(filePath, content, "utf8");
}

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

describe("buildBenchmark", () => {
  test("builds from high-rated reflections", async () => {
    writeJsonl(join(TMP_DIR, "algorithm-reflections.jsonl"), [
      {
        timestamp: "2026-01-01T00:00:00Z",
        effort_level: "high",
        task_description: "Fix the authentication bug",
        implied_sentiment: 8,
        reflection_q1: "TDD caught the edge case",
        reflection_q2: "Could have read docs first",
        criteria_count: 5,
        criteria_passed: 4,
        criteria_failed: 1,
        prd_id: "prd-1",
        within_budget: true,
      },
      {
        timestamp: "2026-01-01T01:00:00Z",
        effort_level: "low",
        task_description: "Bad session",
        implied_sentiment: 3,
        reflection_q1: "nothing worked",
        reflection_q2: "everything",
        criteria_count: 5,
        criteria_passed: 1,
        criteria_failed: 4,
        prd_id: "prd-2",
        within_budget: false,
      },
      {
        timestamp: "2026-01-01T02:00:00Z",
        effort_level: "medium",
        task_description: "Implement dashboard feature",
        implied_sentiment: 9,
        reflection_q1: "Clean architecture",
        reflection_q2: "N/A",
        criteria_count: 3,
        criteria_passed: 3,
        criteria_failed: 0,
        prd_id: "prd-3",
        within_budget: true,
      },
    ]);

    const benchmark = await buildBenchmark(TMP_DIR);

    expect(benchmark.tasks).toHaveLength(2);
    expect(benchmark.tasks[0].task).toBe("Fix the authentication bug");
    expect(benchmark.tasks[0].rating).toBe(8);
    expect(benchmark.tasks[0].gold_q1).toBe("TDD caught the edge case");
    expect(benchmark.tasks[1].task).toBe("Implement dashboard feature");
    expect(benchmark.content_hash).toBeDefined();
    expect(benchmark.content_hash.length).toBe(64);
  });

  test("filters by skill keywords", async () => {
    writeJsonl(join(TMP_DIR, "algorithm-reflections.jsonl"), [
      {
        timestamp: "2026-01-01T00:00:00Z",
        effort_level: "high",
        task_description: "Fix the broken auth",
        implied_sentiment: 8,
        reflection_q1: "debugging saved the day",
        reflection_q2: "N/A",
        criteria_count: 3,
        criteria_passed: 3,
        criteria_failed: 0,
        prd_id: "prd-1",
        within_budget: true,
      },
      {
        timestamp: "2026-01-01T01:00:00Z",
        effort_level: "high",
        task_description: "Build a new dashboard",
        implied_sentiment: 9,
        reflection_q1: "Clean implementation",
        reflection_q2: "N/A",
        criteria_count: 3,
        criteria_passed: 3,
        criteria_failed: 0,
        prd_id: "prd-2",
        within_budget: true,
      },
    ]);

    const benchmark = await buildBenchmark(TMP_DIR, { skillKeywords: ["fix", "debug", "broken"] });

    expect(benchmark.tasks).toHaveLength(1);
    expect(benchmark.tasks[0].task).toBe("Fix the broken auth");
  });

  test("empty reflections file produces empty benchmark", async () => {
    const benchmark = await buildBenchmark(TMP_DIR);
    expect(benchmark.tasks).toHaveLength(0);
    expect(benchmark.content_hash).toBeDefined();
  });

  test("task IDs are deterministic SHA256 hashes", async () => {
    writeJsonl(join(TMP_DIR, "algorithm-reflections.jsonl"), [
      {
        timestamp: "2026-01-01T00:00:00Z",
        effort_level: "high",
        task_description: "Deterministic task",
        implied_sentiment: 8,
        reflection_q1: "q1",
        reflection_q2: "q2",
        criteria_count: 1,
        criteria_passed: 1,
        criteria_failed: 0,
        prd_id: "prd-1",
        within_budget: true,
      },
    ]);

    const b1 = await buildBenchmark(TMP_DIR);
    const b2 = await buildBenchmark(TMP_DIR);

    expect(b1.tasks[0].id).toBe(b2.tasks[0].id);
    expect(b1.tasks[0].id.length).toBe(16);
  });
});

describe("verifyBenchmark", () => {
  test("valid benchmark passes verification", async () => {
    writeJsonl(join(TMP_DIR, "algorithm-reflections.jsonl"), [
      {
        timestamp: "2026-01-01T00:00:00Z",
        effort_level: "high",
        task_description: "Task A",
        implied_sentiment: 8,
        reflection_q1: "q1",
        reflection_q2: "q2",
        criteria_count: 1,
        criteria_passed: 1,
        criteria_failed: 0,
        prd_id: "prd-1",
        within_budget: true,
      },
    ]);

    const benchmark = await buildBenchmark(TMP_DIR);
    expect(verifyBenchmark(benchmark)).toBe(true);
  });

  test("tampered benchmark fails verification", async () => {
    writeJsonl(join(TMP_DIR, "algorithm-reflections.jsonl"), [
      {
        timestamp: "2026-01-01T00:00:00Z",
        effort_level: "high",
        task_description: "Task A",
        implied_sentiment: 8,
        reflection_q1: "q1",
        reflection_q2: "q2",
        criteria_count: 1,
        criteria_passed: 1,
        criteria_failed: 0,
        prd_id: "prd-1",
        within_budget: true,
      },
    ]);

    const benchmark = await buildBenchmark(TMP_DIR);
    benchmark.tasks[0].task = "Tampered task description";
    expect(verifyBenchmark(benchmark)).toBe(false);
  });
});

describe("saveBenchmark / loadBenchmark", () => {
  test("round-trip save and load preserves data", async () => {
    writeJsonl(join(TMP_DIR, "algorithm-reflections.jsonl"), [
      {
        timestamp: "2026-01-01T00:00:00Z",
        effort_level: "high",
        task_description: "Round trip test",
        implied_sentiment: 9,
        reflection_q1: "worked great",
        reflection_q2: "N/A",
        criteria_count: 1,
        criteria_passed: 1,
        criteria_failed: 0,
        prd_id: "prd-1",
        within_budget: true,
      },
    ]);

    const original = await buildBenchmark(TMP_DIR);
    const savePath = join(TMP_DIR, "benchmark.json");
    await saveBenchmark(original, savePath);

    expect(existsSync(savePath)).toBe(true);

    const loaded = loadBenchmark(savePath);
    expect(loaded.tasks).toHaveLength(1);
    expect(loaded.tasks[0].task).toBe("Round trip test");
    expect(loaded.content_hash).toBe(original.content_hash);
  });

  test("loadBenchmark throws on missing file", () => {
    expect(() => loadBenchmark(join(TMP_DIR, "nonexistent.json"))).toThrow("not found");
  });

  test("loadBenchmark throws on tampered file", async () => {
    const savePath = join(TMP_DIR, "tampered.json");
    const tampered: Benchmark = {
      generated: new Date().toISOString(),
      content_hash: "wrong-hash",
      tasks: [{ id: "abc", task: "test", rating: 8, gold_q1: "", gold_q2: "", domain: "" }],
    };
    await Bun.write(savePath, JSON.stringify(tampered));

    expect(() => loadBenchmark(savePath)).toThrow("tampered");
  });
});
