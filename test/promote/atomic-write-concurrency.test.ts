import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

const TMP_DIR = join(import.meta.dir, ".tmp-atomic-write-concurrency");
const STATE_DIR = join(TMP_DIR, "state");
const HELPER = join(import.meta.dir, "..", "..", "src", "adapters", "atomic-write.ts");

/**
 * The four JSON state files this issue is about. Each is written by the daemon
 * and by ad-hoc CLI invocations, so two writers landing on one file is the
 * normal case, not the pathological one.
 */
const STATE_FILES = ["rule-stats.json", "recall-eval.json", "recall-scores.json", "knowledge-graph.json"];

const WRITERS = 20;
const WRITES_PER_WRITER = 15;
const READERS = 8;
const PAYLOAD_BYTES = 40_000;

/**
 * Scratch and lock files are the evidence of a half-finished write. A reader of
 * the final document cannot see them, which is why this lists the directory
 * instead of parsing the JSON.
 */
function residue(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.includes(".tmp.") || f.endsWith(".lock")).sort();
}

/**
 * Real OS processes, not promises. Inside one process every `atomicWriteJSON`
 * call is synchronous and therefore serialised by the event loop, so an
 * in-process "concurrency" test passes no matter what the helper does.
 *
 * Each writer loops: the run has to outlast the helper's lock-wait window, or
 * the lock serialises everything and the temp-naming half of the write path is
 * never exercised at all.
 */
function spawnWriter(target: string, index: number) {
  const code = `
    const { atomicWriteJSON } = await import(${JSON.stringify(HELPER)});
    for (let i = 0; i < ${WRITES_PER_WRITER}; i++) {
      atomicWriteJSON(${JSON.stringify(target)}, {
        writer: ${index},
        round: i,
        filler: "x".repeat(${PAYLOAD_BYTES}),
      });
    }
  `;
  return Bun.spawn([process.execPath, "-e", code], { cwd: TMP_DIR, stdout: "pipe", stderr: "pipe" });
}

/**
 * A reader hammering the same file while the writers run. This is the half of
 * the test that can actually fail: a writer that truncates the real file in
 * place leaves a window where the document on disk is empty or partial, and
 * only a concurrent reader is positioned to see it. Without these processes the
 * test passes against a bare `writeFileSync` — verified by doing exactly that.
 */
function spawnReader(target: string, durationMs: number) {
  const code = `
    const { readFileSync, existsSync } = await import("fs");
    const target = ${JSON.stringify(target)};
    const deadline = Date.now() + ${durationMs};
    let reads = 0;
    while (Date.now() < deadline) {
      if (!existsSync(target)) continue;
      let raw;
      try { raw = readFileSync(target, "utf-8"); } catch (err) {
        if (err && err.code === "ENOENT") continue;
        throw err;
      }
      try {
        const doc = JSON.parse(raw);
        if (typeof doc.filler !== "string" || doc.filler.length !== ${PAYLOAD_BYTES}) {
          console.error("torn document: filler length " + (doc.filler && doc.filler.length));
          process.exit(1);
        }
      } catch (err) {
        console.error("unparseable document after " + reads + " good reads, " + raw.length + " bytes: " + err.message);
        process.exit(1);
      }
      reads++;
    }
  `;
  return Bun.spawn([process.execPath, "-e", code], { cwd: TMP_DIR, stdout: "pipe", stderr: "pipe" });
}

async function collect(procs: ReturnType<typeof Bun.spawn>[]) {
  return Promise.all(
    procs.map(async (p) => ({ code: await p.exited, stderr: await new Response(p.stderr).text() })),
  );
}

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

describe("concurrent writers", () => {
  for (const name of STATE_FILES) {
    test(
      `${WRITERS} concurrent writers to ${name} leave no orphaned temp files and a parseable document`,
      async () => {
        const target = join(STATE_DIR, name);
        const procs = [
          ...Array.from({ length: WRITERS }, (_, i) => spawnWriter(target, i)),
          ...Array.from({ length: READERS }, () => spawnReader(target, 1500)),
        ];

        const results = await collect(procs);
        const failed = results.filter((r) => r.code !== 0);
        expect(failed.map((f) => f.stderr.trim()).join("\n---\n")).toBe("");
        expect(failed.length).toBe(0);

        expect(residue(STATE_DIR)).toEqual([]);

        const parsed = JSON.parse(readFileSync(target, "utf-8")) as { writer: number; filler: string };
        expect(typeof parsed.writer).toBe("number");
        expect(parsed.writer).toBeGreaterThanOrEqual(0);
        expect(parsed.writer).toBeLessThan(WRITERS);
        expect(parsed.filler.length).toBe(PAYLOAD_BYTES);
      },
      180_000,
    );
  }

  /**
   * The lock fails open rather than throwing, so there is a real window in
   * which several writers hold no lock and overlap. Everything above runs with
   * the lock available, which hides that window — with the lock in play a
   * single shared temp name passes every test in this file.
   *
   * Planting a lock nobody will release forces every writer through the
   * fail-open path at the same moment, which is the only place the temp name's
   * uniqueness is load-bearing. Verified by replacing the per-writer name with
   * a constant: this test goes red and the others stay green.
   */
  test(
    "writers that time out on a held lock still do not collide",
    async () => {
      const target = join(STATE_DIR, "rule-stats.json");
      const lockPath = target + ".lock";
      writeFileSync(lockPath, "", "utf-8");

      const procs = [
        ...Array.from({ length: 8 }, (_, i) => spawnWriter(target, i)),
        ...Array.from({ length: 4 }, () => spawnReader(target, 2500)),
      ];

      const results = await collect(procs);
      const failed = results.filter((r) => r.code !== 0);
      expect(failed.map((f) => f.stderr.trim()).join("\n---\n")).toBe("");

      // The planted lock is nobody's to release, so it is expected residue.
      unlinkSync(lockPath);
      expect(residue(STATE_DIR)).toEqual([]);
      expect((JSON.parse(readFileSync(target, "utf-8")) as { filler: string }).filler.length).toBe(PAYLOAD_BYTES);
    },
    180_000,
  );

  test(
    "writers against all four state files at once leave no residue in the shared directory",
    async () => {
      const procs = STATE_FILES.flatMap((name) => [
        ...Array.from({ length: 5 }, (_, i) => spawnWriter(join(STATE_DIR, name), i)),
        spawnReader(join(STATE_DIR, name), 1200),
      ]);

      const results = await collect(procs);
      const failed = results.filter((r) => r.code !== 0);
      expect(failed.map((f) => f.stderr.trim()).join("\n---\n")).toBe("");

      expect(residue(STATE_DIR)).toEqual([]);
      for (const name of STATE_FILES) {
        const parsed = JSON.parse(readFileSync(join(STATE_DIR, name), "utf-8")) as { filler: string };
        expect(parsed.filler.length).toBe(PAYLOAD_BYTES);
      }
    },
    180_000,
  );
});
