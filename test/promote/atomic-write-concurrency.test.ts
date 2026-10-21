import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "fs";
import { join } from "path";

/**
 * Real concurrency, not simulated. `atomicWriteJSON` is synchronous, so twenty
 * calls on one event loop cannot interleave and would prove nothing — the
 * orphaned .tmp files this issue is about came from separate processes.
 * Each writer here is its own `bun` process contending for the same file.
 */

const TEMP_DIR = join(import.meta.dir, ".tmp-atomic-write-concurrency");
const HELPER = join(import.meta.dir, "..", "..", "src", "adapters", "atomic-write.ts");
const WRITERS = 20;
const STATE_FILES = ["rule-stats.json", "recall-eval.json", "recall-scores.json", "knowledge-graph.json"];

const WORKER_SOURCE = `
const [target, idx] = process.argv.slice(2);
const { atomicWriteJSON } = await import(${JSON.stringify(HELPER)});
// A payload big enough that the write is not a single instantaneous syscall,
// so a non-atomic implementation has a window to be caught in.
atomicWriteJSON(target, { writer: Number(idx), filler: "x".repeat(40000) });
`;

function workerPath(): string {
  const p = join(TEMP_DIR, "writer.mjs");
  writeFileSync(p, WORKER_SOURCE, "utf-8");
  return p;
}

function residue(dir: string, infix: string): string[] {
  return readdirSync(dir).filter((f) => f.includes(infix));
}

beforeEach(() => {
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true });
  mkdirSync(TEMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true });
});

describe("concurrent writers against state files", () => {
  test(
    "twenty concurrent processes per state file leave no orphaned temp files and a parseable document",
    async () => {
      const worker = workerPath();
      const stateDir = join(TEMP_DIR, "state");
      mkdirSync(stateDir, { recursive: true });

      const procs: Array<{ file: string; idx: number; exited: Promise<number> }> = [];
      for (const file of STATE_FILES) {
        const target = join(stateDir, file);
        for (let i = 0; i < WRITERS; i++) {
          const child = Bun.spawn(["bun", worker, target, String(i)], {
            stdout: "pipe",
            stderr: "pipe",
          });
          procs.push({ file, idx: i, exited: child.exited });
        }
      }

      const codes = await Promise.all(procs.map((p) => p.exited));
      const failed = procs.filter((_, i) => codes[i] !== 0).map((p) => `${p.file}#${p.idx}`);
      expect(failed).toEqual([]);

      // Zero orphaned temp files across every target.
      expect(residue(stateDir, ".tmp.")).toEqual([]);
      expect(residue(stateDir, ".lock")).toEqual([]);

      // Every final document is whole: parseable, and exactly one writer's
      // payload rather than two spliced together.
      for (const file of STATE_FILES) {
        const raw = readFileSync(join(stateDir, file), "utf-8");
        const parsed = JSON.parse(raw) as { writer: number; filler: string };
        expect(parsed.writer).toBeGreaterThanOrEqual(0);
        expect(parsed.writer).toBeLessThan(WRITERS);
        expect(parsed.filler.length).toBe(40000);
      }
    },
    180_000,
  );

  test("a stale lock left by a dead writer does not block rule-stats.json forever", async () => {
    const { atomicWriteJSON } = await import("../../src/adapters/atomic-write");
    const target = join(TEMP_DIR, "rule-stats.json");
    const lock = target + ".lock";
    writeFileSync(lock, "", "utf-8");
    // Backdate past the stale threshold the helper uses.
    const old = new Date(Date.now() - 10 * 60 * 1000);
    const { utimesSync } = await import("fs");
    utimesSync(lock, old, old);

    atomicWriteJSON(target, { recovered: true });

    expect(JSON.parse(readFileSync(target, "utf-8")).recovered).toBe(true);
    expect(residue(TEMP_DIR, ".tmp.")).toEqual([]);
    expect(existsSync(lock)).toBe(false);
  });

  test("orphaned temp files from a previous crash are swept for knowledge-graph.json", async () => {
    const { cleanupOrphanedTmpFiles, atomicWriteJSON } = await import("../../src/adapters/atomic-write");
    const target = join(TEMP_DIR, "knowledge-graph.json");
    for (const pid of [101, 202, 303]) {
      writeFileSync(`${target}.tmp.${pid}`, "partial", "utf-8");
    }

    atomicWriteJSON(target, { nodeCount: 1 });
    cleanupOrphanedTmpFiles(TEMP_DIR, "knowledge-graph.json");

    expect(residue(TEMP_DIR, ".tmp.")).toEqual([]);
    expect(JSON.parse(readFileSync(target, "utf-8")).nodeCount).toBe(1);
  });
});
