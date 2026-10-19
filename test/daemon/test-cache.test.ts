/**
 * Regression tests for the daemon's test-cache step (issue #256).
 *
 * The step used to resolve the repo as `$HOME/agentgrit`, which does not exist
 * on this machine. spawnSync failed, stdout/stderr coalesced to "", the
 * pass/fail regexes matched nothing, and `{"pass":0,"fail":0}` was written as
 * though it were a measurement — the exact shape described in
 * .claude/rules/checks-must-be-able-to-fail.md: a check that passed because of
 * what it never looked at.
 *
 * Every case below drives the real code path. The only thing injected is the
 * command to run, so "spawn failed" and "output does not parse" are produced by
 * a real spawnSync rather than by a mock that could agree with a broken branch.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

const TMP = "/tmp/agentgrit-test-cache-" + process.pid;
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

function outPath(name: string): string {
  mkdirSync(TMP, { recursive: true });
  return join(TMP, name);
}

afterAll(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
});

describe("agentgritRepoRoot", () => {
  test("resolves to the checkout the code is running from", async () => {
    const { agentgritRepoRoot } = await import("../../src/adapters/paths");

    const root = agentgritRepoRoot();

    expect(realpathSync(root)).toBe(realpathSync(REPO_ROOT));
    expect(existsSync(join(root, "src", "daemon", "daemon.ts"))).toBe(true);
  });

  test("does not resolve to a literal directory name under the home directory", async () => {
    const { agentgritRepoRoot } = await import("../../src/adapters/paths");

    // The old bug: join(process.env.HOME, "agentgrit"). That path does not
    // exist here, and the resolver must never produce it from this checkout.
    expect(realpathSync(agentgritRepoRoot())).not.toBe(join(homedir(), "agentgrit"));
  });

  test("honours AGENTGRIT_REPO_ROOT and rejects an override that is not a checkout", async () => {
    const { agentgritRepoRoot } = await import("../../src/adapters/paths");
    const original = process.env.AGENTGRIT_REPO_ROOT;
    try {
      process.env.AGENTGRIT_REPO_ROOT = REPO_ROOT;
      expect(realpathSync(agentgritRepoRoot())).toBe(realpathSync(REPO_ROOT));

      process.env.AGENTGRIT_REPO_ROOT = outPath("not-a-checkout");
      mkdirSync(process.env.AGENTGRIT_REPO_ROOT, { recursive: true });
      expect(() => agentgritRepoRoot()).toThrow(/AGENTGRIT_REPO_ROOT/);
    } finally {
      if (original === undefined) delete process.env.AGENTGRIT_REPO_ROOT;
      else process.env.AGENTGRIT_REPO_ROOT = original;
    }
  });
});

describe("runTestCache", () => {
  test("UNMEASURED when the runner cannot be spawned", async () => {
    const { runTestCache } = await import("../../src/daemon/daemon");
    const file = outPath("spawn-failure.json");

    const result = await runTestCache({
      command: ["agentgrit-no-such-test-runner-256"],
      outputPath: file,
    });

    expect(result.status).toBe("UNMEASURED");
    if (result.status !== "UNMEASURED") throw new Error("unreachable");
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result).not.toHaveProperty("pass");

    const written = JSON.parse(readFileSync(file, "utf-8"));
    expect(written.status).toBe("UNMEASURED");
    expect(written.pass).toBeUndefined();
    expect(typeof written.reason).toBe("string");
  });

  test("UNMEASURED when the runner exits non-zero with no reported failures", async () => {
    const { runTestCache } = await import("../../src/daemon/daemon");
    const file = outPath("nonzero-exit.json");

    const result = await runTestCache({
      command: ["bash", "-c", "echo 'error: could not resolve module' >&2; exit 2"],
      outputPath: file,
    });

    expect(result.status).toBe("UNMEASURED");
    if (result.status !== "UNMEASURED") throw new Error("unreachable");
    expect(result.reason).toMatch(/2/);
    expect(JSON.parse(readFileSync(file, "utf-8")).pass).toBeUndefined();
  });

  test("UNMEASURED when the output cannot be parsed into pass/fail counts", async () => {
    const { runTestCache } = await import("../../src/daemon/daemon");
    const file = outPath("unparseable.json");

    const result = await runTestCache({
      command: ["bash", "-c", "echo 'ran some tests, everything is fine'"],
      outputPath: file,
    });

    expect(result.status).toBe("UNMEASURED");
    if (result.status !== "UNMEASURED") throw new Error("unreachable");
    expect(result.reason.length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(file, "utf-8")).pass).toBeUndefined();
  });

  test("a parseable run is MEASURED, not UNMEASURED, and records the real counts", async () => {
    const { runTestCache } = await import("../../src/daemon/daemon");
    const file = outPath("measured.json");

    const result = await runTestCache({
      command: ["bash", "-c", "echo ' 1234 pass'; echo ' 8 fail'; exit 1"],
      outputPath: file,
    });

    expect(result.status).toBe("MEASURED");
    if (result.status !== "MEASURED") throw new Error("unreachable");
    expect(result.pass).toBe(1234);
    expect(result.fail).toBe(8);

    const written = JSON.parse(readFileSync(file, "utf-8"));
    expect(written.pass).toBe(1234);
    expect(written.fail).toBe(8);
  });

  test("a green run reporting zero failures is still MEASURED", async () => {
    const { runTestCache } = await import("../../src/daemon/daemon");
    const file = outPath("green.json");

    const result = await runTestCache({
      command: ["bash", "-c", "echo ' 42 pass'; echo ' 0 fail'"],
      outputPath: file,
    });

    expect(result.status).toBe("MEASURED");
    if (result.status !== "MEASURED") throw new Error("unreachable");
    expect(result.pass).toBe(42);
    expect(result.fail).toBe(0);
  });

  test("a nonexistent cwd surfaces an error to the caller", async () => {
    const { runTestCache } = await import("../../src/daemon/daemon");
    const missing = join(TMP, "no-such-checkout");
    if (existsSync(missing)) rmSync(missing, { recursive: true, force: true });

    await expect(
      runTestCache({ cwd: missing, outputPath: outPath("never-written.json") }),
    ).rejects.toThrow(new RegExp(missing));
  });

  test("a nonexistent cwd writes no zero result over the previous measurement", async () => {
    const { runTestCache } = await import("../../src/daemon/daemon");
    const file = outPath("previous-measurement.json");
    const previous = { status: "MEASURED", pass: 1500, fail: 8, timestamp: "2026-10-17T00:00:00.000Z" };
    writeFileSync(file, JSON.stringify(previous), "utf-8");

    const missing = join(TMP, "also-no-such-checkout");
    if (existsSync(missing)) rmSync(missing, { recursive: true, force: true });

    let message = "";
    try {
      await runTestCache({ cwd: missing, outputPath: file });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    // Assert on the message, not merely that something threw: a TypeError from
    // a missing export would satisfy "it threw" without the guard existing.
    expect(message).toMatch(new RegExp(missing));
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual(previous);
  });

  test("a nonexistent cwd is rejected before the runner is ever spawned", async () => {
    const { runTestCache } = await import("../../src/daemon/daemon");
    const file = outPath("sentinel.json");
    if (existsSync(file)) rmSync(file, { force: true });
    const missing = join(TMP, "third-no-such-checkout");

    let message = "";
    try {
      // A command that would succeed and parse cleanly anywhere it could run:
      // if the cwd check were missing, this would write a MEASURED result.
      await runTestCache({
        cwd: missing,
        command: ["bash", "-c", "echo ' 9 pass'; echo ' 0 fail'"],
        outputPath: file,
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toMatch(new RegExp(missing));
    expect(existsSync(file)).toBe(false);
  });
});
