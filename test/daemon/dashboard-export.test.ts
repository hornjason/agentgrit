/**
 * Regression test for #255 — the daemon's dashboard-export block called
 * `writeFileSync(join(getState(), "dashboard-results.json"), ...)` while
 * `writeFileSync`, `join` and `getState` were `const`-declared inside the
 * *test-cache* `try` block above it. `const` is block-scoped, so every cycle
 * threw `ReferenceError: writeFileSync is not defined`, the catch turned it
 * into a `dashboard-export:` entry in `result.errors`, and the control plane
 * went on reading a `dashboard-results.json` nobody had rewritten.
 *
 * The failure mode is therefore two-sided, and this test asserts both sides:
 *
 *   1. the cycle reports no `dashboard-export:` error, and
 *   2. `dashboard-results.json` actually exists on disk with a `scannedAt`
 *      from *this* run.
 *
 * Asserting only (1) would pass under the cheapest wrong fix — deleting the
 * `result.errors.push` from the catch, which silences the symptom and leaves
 * the file stale forever. Asserting only (2) would pass against a pre-seeded
 * file. Together they pin the behaviour the issue is actually about.
 *
 * The cycle runs against a temp `AGENTGRIT_DIR`, never the developer's real
 * `~/.agentgrit`.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AgentGritConfig } from "../../src/adapters/types";

const BASE_DIR_ENV = "AGENTGRIT_DIR";
const TEST_CACHE_ENV = "AGENTGRIT_TEST_CACHE";

let savedBaseDir: string | undefined;
let savedTestCache: string | undefined;
let base: string;

function makeConfig(): AgentGritConfig {
  return {
    signalDir: join(base, "signals"),
    adapter: "local",
    rubrics: [],
    rules: { globalBudget: 25, projectBudget: 25, autoPromote: false },
    daemon: { interval: "30m", weeklyDay: "sunday" },
  } as AgentGritConfig;
}

beforeEach(() => {
  savedBaseDir = process.env[BASE_DIR_ENV];
  savedTestCache = process.env[TEST_CACHE_ENV];
  // Never let this test fork a real `bun test`; the cycle's test-cache step
  // is unrelated to what is under test here.
  delete process.env[TEST_CACHE_ENV];

  base = mkdtempSync(join(tmpdir(), "ag255-"));
  // A real install has these; the daemon writes into state/, it does not
  // create it. Creating them here keeps the test about the ReferenceError
  // rather than about a missing directory.
  mkdirSync(join(base, "state"), { recursive: true });
  mkdirSync(join(base, "signals"), { recursive: true });
  process.env[BASE_DIR_ENV] = base;
});

afterEach(() => {
  if (savedBaseDir === undefined) delete process.env[BASE_DIR_ENV];
  else process.env[BASE_DIR_ENV] = savedBaseDir;
  if (savedTestCache === undefined) delete process.env[TEST_CACHE_ENV];
  else process.env[TEST_CACHE_ENV] = savedTestCache;

  if (existsSync(base)) rmSync(base, { recursive: true, force: true });
});

describe("runDaemonCycle — dashboard export writes a fresh file (#255)", () => {
  test("a cycle writes dashboard-results.json with a scannedAt from this run", async () => {
    const { runDaemonCycle } = await import("../../src/daemon/daemon");
    const outPath = join(base, "state", "dashboard-results.json");
    expect(existsSync(outPath)).toBe(false);

    const startedAt = Date.now();
    await runDaemonCycle(makeConfig());

    expect(existsSync(outPath)).toBe(true);
    const written = JSON.parse(readFileSync(outPath, "utf-8"));
    expect(typeof written.scannedAt).toBe("string");
    const scanned = new Date(written.scannedAt).getTime();
    expect(Number.isNaN(scanned)).toBe(false);
    // 1s of slack below for clock granularity; the real bug left this field
    // seven weeks behind, so the window does not need to be tight to bite.
    expect(scanned).toBeGreaterThanOrEqual(startedAt - 1000);
  }, 60_000);

  test("the cycle reports no dashboard-export error", async () => {
    const { runDaemonCycle } = await import("../../src/daemon/daemon");

    const result = await runDaemonCycle(makeConfig());

    const dashErrors = result.errors.filter((e) => e.startsWith("dashboard-export:"));
    // Print the real message rather than just a count — "writeFileSync is not
    // defined" is the whole diagnosis, and a bare 0-vs-1 hides it.
    expect(dashErrors).toEqual([]);
  }, 60_000);

  test("a stale file from a previous run is overwritten, not left in place", async () => {
    const { runDaemonCycle } = await import("../../src/daemon/daemon");
    const outPath = join(base, "state", "dashboard-results.json");
    // The exact shape of the bug's symptom: a real-looking file whose
    // scannedAt is weeks old because no cycle has managed to rewrite it.
    const stale = "2026-09-02T00:00:00.000Z";
    writeFileSync(outPath, JSON.stringify({ scannedAt: stale }), "utf-8");

    await runDaemonCycle(makeConfig());

    const written = JSON.parse(readFileSync(outPath, "utf-8"));
    expect(written.scannedAt).not.toBe(stale);
    expect(new Date(written.scannedAt).getTime()).toBeGreaterThan(new Date(stale).getTime());
  }, 60_000);
});
