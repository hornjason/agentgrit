/**
 * Regression tests for #256 — test-cache ran `bun test` in a nonexistent cwd
 * ($HOME/agentgrit instead of the real checkout) and wrote {"pass":0,"fail":0}
 * as though it were a measurement. It never reached the daemon errors list, so
 * there was no signal at all.
 *
 * The thing under test is therefore not "does it count tests" — it is "can this
 * check go red". Each test below breaks the measurement a different way and
 * asserts the result is UNMEASURED, never a zero that reads like success.
 *
 * None of these spawn `bun test`. Every path asserted here is rejected before
 * the spawn, which is the point: the failure is detected without paying for a
 * suite run.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AgentGritConfig } from "../../src/adapters/types";

const REPO_ROOT_ENV = "AGENTGRIT_REPO_ROOT";
const RUN_ENV = "AGENTGRIT_TEST_CACHE";

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "ag256-"));
  scratchDirs.push(dir);
  return dir;
}

/** A directory dressed up to look like the repo, to the depth the arg says. */
function plantedRepo(opts: { pkgName?: string; withDaemon?: boolean }): string {
  const dir = scratch();
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: opts.pkgName ?? "totally-legit",
      scripts: { preinstall: "touch /tmp/ag256-pwned" },
    }),
    "utf-8",
  );
  if (opts.withDaemon) {
    mkdirSync(join(dir, "src", "daemon"), { recursive: true });
    writeFileSync(join(dir, "src", "daemon", "daemon.ts"), "// planted\n", "utf-8");
  }
  return dir;
}

const CHILD_ENV = "AGENTGRIT_TEST_CACHE_CHILD";

let savedRepoRootEnv: string | undefined;
let savedRunEnv: string | undefined;
let savedChildEnv: string | undefined;

beforeEach(() => {
  savedRepoRootEnv = process.env[REPO_ROOT_ENV];
  savedRunEnv = process.env[RUN_ENV];
  savedChildEnv = process.env[CHILD_ENV];
  // This suite can be run *by* the test cache it tests, which sets the
  // recursion guard in the child environment. Clear it so each test starts
  // from the same place whichever way the suite was invoked.
  delete process.env[CHILD_ENV];
});

afterEach(() => {
  if (savedRepoRootEnv === undefined) delete process.env[REPO_ROOT_ENV];
  else process.env[REPO_ROOT_ENV] = savedRepoRootEnv;
  if (savedRunEnv === undefined) delete process.env[RUN_ENV];
  else process.env[RUN_ENV] = savedRunEnv;
  if (savedChildEnv === undefined) delete process.env[CHILD_ENV];
  else process.env[CHILD_ENV] = savedChildEnv;

  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

// ─── AC3: a broken measurement surfaces as an error, not as 0 pass / 0 fail ──

describe("runTestCache — a measurement that cannot run is UNMEASURED", () => {
  test("a nonexistent cwd is reported, not recorded as 0 pass / 0 fail", async () => {
    const { runTestCache } = await import("../../src/daemon/daemon");
    const missing = join(tmpdir(), `ag256-does-not-exist-${process.pid}-${Date.now()}`);
    expect(existsSync(missing)).toBe(false);

    const outcome = await runTestCache({ cwd: missing });

    expect(outcome.status).toBe("UNMEASURED");
    // The whole bug: 0/0 written as if measured. Those keys must not exist.
    expect(outcome).not.toHaveProperty("pass");
    expect(outcome).not.toHaveProperty("fail");
    if (outcome.status === "UNMEASURED") {
      expect(outcome.reason).toContain(missing);
    }
  });

  test("the cached JSON for a failed run carries no pass count to read as success", async () => {
    const { runTestCache } = await import("../../src/daemon/daemon");
    const { statePath } = await import("../../src/adapters/paths");
    const missing = join(tmpdir(), `ag256-does-not-exist-${process.pid}-b`);

    await runTestCache({ cwd: missing });

    const cached = JSON.parse(readFileSync(statePath("test-results.json"), "utf-8"));
    expect(cached.status).toBe("UNMEASURED");
    expect(cached.pass).toBeUndefined();
    expect(cached.fail).toBeUndefined();
    expect(typeof cached.reason).toBe("string");
    // dashboard-export keys off `pass != null`; absent means "no result",
    // which is what an unmeasured run is.
    expect(cached.pass == null).toBe(true);
  });

  test("an unresolvable repo root is UNMEASURED rather than a guessed path", async () => {
    const { runTestCache } = await import("../../src/daemon/daemon");

    const outcome = await runTestCache({ cwd: null });

    expect(outcome.status).toBe("UNMEASURED");
    expect(outcome).not.toHaveProperty("pass");
  });

  test("refuses to recurse when already inside a test-cache child", async () => {
    const { runTestCache, TEST_CACHE_CHILD_ENV } = await import("../../src/daemon/daemon");
    const saved = process.env[TEST_CACHE_CHILD_ENV];
    process.env[TEST_CACHE_CHILD_ENV] = "1";
    try {
      const outcome = await runTestCache({ cwd: process.cwd() });
      expect(outcome.status).toBe("UNMEASURED");
      if (outcome.status === "UNMEASURED") {
        expect(outcome.reason).toMatch(/recurs/i);
      }
    } finally {
      if (saved === undefined) delete process.env[TEST_CACHE_CHILD_ENV];
      else process.env[TEST_CACHE_CHILD_ENV] = saved;
    }
  });
});

// ─── AC2: the parser cannot invent a result from output it did not understand ─

describe("parseBunTestSummary — unparseable output is not zero", () => {
  test("empty output yields no counts", async () => {
    const { parseBunTestSummary } = await import("../../src/daemon/daemon");
    expect(parseBunTestSummary("")).toBeNull();
  });

  test("output with no summary line yields no counts", async () => {
    const { parseBunTestSummary } = await import("../../src/daemon/daemon");
    expect(parseBunTestSummary("bun: command not found\n")).toBeNull();
  });

  test("a real bun summary is parsed", async () => {
    const { parseBunTestSummary } = await import("../../src/daemon/daemon");
    const output = [
      "bun test v1.3.14",
      "",
      "test/daemon/daemon.test.ts:",
      "(pass) daemon cycle > returns result [2.00ms]",
      "",
      " 1838 pass",
      " 3 skip",
      " 0 fail",
      "Ran 1841 tests across 120 files. [40.00s]",
    ].join("\n");

    expect(parseBunTestSummary(output)).toEqual({ pass: 1838, fail: 0 });
  });

  test("a test name containing the word pass does not inflate the count", async () => {
    const { parseBunTestSummary } = await import("../../src/daemon/daemon");
    const output = [
      "(pass) auth > rejects 7 password attempts [1.00ms]",
      "",
      " 12 pass",
      " 0 fail",
    ].join("\n");

    expect(parseBunTestSummary(output)).toEqual({ pass: 12, fail: 0 });
  });
});

// ─── AC1: repo root resolution, and the security regression that must not recur ─

describe("agentgritRepoRoot — marker validation", () => {
  test("resolves the real checkout from the module's own location", async () => {
    const { agentgritRepoRoot } = await import("../../src/adapters/paths");
    delete process.env[REPO_ROOT_ENV];

    const root = agentgritRepoRoot();

    expect(root).not.toBeNull();
    expect(existsSync(join(root as string, "package.json"))).toBe(true);
    expect(existsSync(join(root as string, "src", "daemon", "daemon.ts"))).toBe(true);
  });

  test("never resolves to the hardcoded $HOME/agentgrit of #256", async () => {
    const { agentgritRepoRoot } = await import("../../src/adapters/paths");
    delete process.env[REPO_ROOT_ENV];

    const root = agentgritRepoRoot();

    expect(root).not.toBe(join(process.env.HOME ?? "", "agentgrit"));
  });

  test("rejects an env override with no marker files — RCE guard", async () => {
    const { agentgritRepoRoot } = await import("../../src/adapters/paths");
    const planted = scratch();
    process.env[REPO_ROOT_ENV] = planted;

    // Must not hand an attacker-controlled directory to a `bun test` spawn.
    expect(agentgritRepoRoot()).not.toBe(planted);
  });

  test("rejects an env override carrying only a planted package.json — RCE guard", async () => {
    const { agentgritRepoRoot } = await import("../../src/adapters/paths");
    const planted = plantedRepo({ withDaemon: false });
    process.env[REPO_ROOT_ENV] = planted;

    expect(agentgritRepoRoot()).not.toBe(planted);
  });

  test("rejects an env override whose package.json is not this package", async () => {
    const { agentgritRepoRoot } = await import("../../src/adapters/paths");
    const planted = plantedRepo({ pkgName: "evil-lookalike", withDaemon: true });
    process.env[REPO_ROOT_ENV] = planted;

    expect(agentgritRepoRoot()).not.toBe(planted);
  });

  test("accepts an env override that carries every marker", async () => {
    const { agentgritRepoRoot } = await import("../../src/adapters/paths");
    const legit = plantedRepo({ pkgName: "@agentgrit/core", withDaemon: true });
    process.env[REPO_ROOT_ENV] = legit;

    expect(agentgritRepoRoot()).toBe(legit);
  });
});

describe("isRepoRoot", () => {
  test("rejects a directory with no markers", async () => {
    const { isRepoRoot } = await import("../../src/adapters/paths");
    expect(isRepoRoot(scratch())).toBe(false);
  });

  test("rejects package.json without the daemon marker", async () => {
    const { isRepoRoot } = await import("../../src/adapters/paths");
    expect(isRepoRoot(plantedRepo({ pkgName: "@agentgrit/core", withDaemon: false }))).toBe(false);
  });

  test("rejects a wrong package name even with both markers present", async () => {
    const { isRepoRoot } = await import("../../src/adapters/paths");
    expect(isRepoRoot(plantedRepo({ pkgName: "evil-lookalike", withDaemon: true }))).toBe(false);
  });

  test("rejects unparseable package.json", async () => {
    const { isRepoRoot } = await import("../../src/adapters/paths");
    const dir = scratch();
    writeFileSync(join(dir, "package.json"), "{ not json", "utf-8");
    mkdirSync(join(dir, "src", "daemon"), { recursive: true });
    writeFileSync(join(dir, "src", "daemon", "daemon.ts"), "", "utf-8");
    expect(isRepoRoot(dir)).toBe(false);
  });

  test("rejects an empty string rather than treating it as the filesystem root", async () => {
    const { isRepoRoot } = await import("../../src/adapters/paths");
    expect(isRepoRoot("")).toBe(false);
  });

  test("accepts the real checkout", async () => {
    const { isRepoRoot, agentgritRepoRoot } = await import("../../src/adapters/paths");
    delete process.env[REPO_ROOT_ENV];
    expect(isRepoRoot(agentgritRepoRoot() as string)).toBe(true);
  });
});

// ─── AC2 end-to-end: the daemon no longer swallows an unmeasured test cache ──

describe("runDaemonCycle — an unmeasured test cache reaches the errors list", () => {
  function makeConfig(): AgentGritConfig {
    return {
      signalDir: join(tmpdir(), `ag256-signals-${process.pid}`),
      adapter: "local",
      rubrics: [],
      rules: { globalBudget: 25, projectBudget: 25, autoPromote: false },
      daemon: { interval: "30m", weeklyDay: "sunday" },
    } as AgentGritConfig;
  }

  test("a forced run that cannot be parsed surfaces an error", async () => {
    const { runDaemonCycle } = await import("../../src/daemon/daemon");

    // A checkout-shaped directory with no test/ in it. It passes marker
    // validation, so the spawn happens for real, but bun finds nothing and
    // prints no summary — the "output the regexes cannot parse" case.
    // It returns in ~15ms, so this exercises the whole chain without forking
    // the actual suite.
    process.env[RUN_ENV] = "force";
    process.env[REPO_ROOT_ENV] = plantedRepo({ pkgName: "@agentgrit/core", withDaemon: true });

    const result = await runDaemonCycle(makeConfig());

    const testCacheErrors = result.errors.filter((e) => e.startsWith("test-cache:"));
    expect(testCacheErrors.length).toBe(1);
    expect(testCacheErrors[0]).toContain("UNMEASURED");
    expect(testCacheErrors[0]).toContain("no parseable summary");
  }, 30_000);

  test("the cached file from that run records no pass count", async () => {
    const { runTestCache } = await import("../../src/daemon/daemon");
    const { statePath } = await import("../../src/adapters/paths");
    process.env[REPO_ROOT_ENV] = plantedRepo({ pkgName: "@agentgrit/core", withDaemon: true });

    const outcome = await runTestCache();

    expect(outcome.status).toBe("UNMEASURED");
    const cached = JSON.parse(readFileSync(statePath("test-results.json"), "utf-8"));
    expect(cached.pass).toBeUndefined();
    expect(cached.status).toBe("UNMEASURED");
  }, 30_000);

  test("the cycle does not spawn a suite while running inside a test process", async () => {
    const { shouldRunTestCache } = await import("../../src/daemon/daemon");
    delete process.env[RUN_ENV];
    expect(process.env.NODE_ENV).toBe("test");
    // Guards the machine: six runDaemonCycle calls in daemon.test.ts would
    // otherwise each fork a full 600s suite, recursively.
    expect(shouldRunTestCache()).toBe(false);

    process.env[RUN_ENV] = "force";
    expect(shouldRunTestCache()).toBe(true);
  });
});
