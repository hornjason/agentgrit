/**
 * `agentgrit learn` is callable the way the iteration LEARN step calls it (#253).
 *
 * The LEARN step does not run inside this checkout, so the thing under test is
 * not "does the function work" — `test/capture/iteration-learning.test.ts`
 * answers that — it is "does the CLI start, route and exit zero when the
 * working directory is somewhere else entirely". That is the part a unit test
 * cannot see: a module that resolves anything relative to `process.cwd()`
 * passes in-repo and fails here.
 *
 * The temp cwd is created OUTSIDE the repository on purpose. Running it from
 * `test/.tmp-*` would leave the repo on the path and prove nothing.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CLI = join(REPO_ROOT, "bin", "agentgrit.ts");

let outsideCwd = "";
let baseDir = "";
let hostDir = "";

beforeEach(() => {
  outsideCwd = mkdtempSync(join(tmpdir(), "agentgrit-learn-cwd-"));
  baseDir = mkdtempSync(join(tmpdir(), "agentgrit-learn-base-"));
  hostDir = join(baseDir, "host");
  mkdirSync(join(baseDir, "signals"), { recursive: true });
  mkdirSync(hostDir, { recursive: true });
});

afterEach(() => {
  for (const dir of [outsideCwd, baseDir]) {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function runLearn(args: string[]) {
  const proc = Bun.spawnSync(["bun", CLI, "learn", ...args], {
    cwd: outsideCwd,
    env: {
      ...process.env,
      AGENTGRIT_DIR: baseDir,
      AGENTGRIT_HOST_DIR: hostDir,
    },
    timeout: 120_000,
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("agentgrit learn", () => {
  test("runs from a working directory outside the repository and prints the routed tier", () => {
    const res = runLearn([
      "--gap", "LEARN step produced text nobody routed",
      "--root-cause", "The iteration loop never called the learning router",
      "--mechanical-fix", "Always verify and validate evidence before asserting; read and check first",
      "--artifact-type", "iteration-loop",
      "--project", "proj-a",
      "--project", "proj-b",
    ]);

    // The cwd really is outside the repo — otherwise this test is vacuous.
    expect(outsideCwd.startsWith(REPO_ROOT)).toBe(false);
    expect(`${res.stdout}${res.stderr}`).not.toContain("Unknown command");
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Tier:");
    expect(res.stdout).toContain("global");
    expect(res.stdout.toLowerCase()).toContain("shadow");
  });

  test("exits non-zero and says what is missing when a required field is absent", () => {
    const res = runLearn(["--gap", "something"]);
    expect(res.code).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toContain("--root-cause");
  });
});
