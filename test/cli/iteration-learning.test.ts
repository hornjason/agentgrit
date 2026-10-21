/**
 * #253 — the LEARN step calls this from wherever the loop happens to be, which
 * is never this repository. So the case that matters is the one run with a cwd
 * outside the checkout: a module that resolves anything relative to `.` works
 * perfectly in `bun test` and fails for the only caller there is.
 *
 * WHAT WAS BROKEN to make it go red: resolving the learning directory from
 * `process.cwd()` instead of the path authority writes the artifact into the
 * temp dir the spawn was launched from, and the assertion on the base dir
 * fails. Dropping the `iteration-learn` entry from `HANDLERS` exits 1 with
 * "Unknown command", which the exit-code assertion catches.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = realpathSync(join(import.meta.dir, "..", ".."));
const CLI = join(ROOT, "bin", "agentgrit.ts");

let base: string;
let outside: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "agentgrit-iter-base-"));
  outside = mkdtempSync(join(tmpdir(), "agentgrit-iter-cwd-"));
});

afterEach(() => {
  for (const dir of [base, outside]) {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", CLI, ...args], {
    cwd: outside,
    env: {
      ...process.env,
      AGENTGRIT_DIR: base,
      AGENTGRIT_HOST_DIR: join(base, "host"),
    },
    timeout: 120_000,
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("agentgrit iteration-learn (#253)", () => {
  test("runs from a working directory outside the repository and prints the routed tier", () => {
    // The premise. A cwd inside the checkout would make this the same case as
    // every other CLI test, and the failure mode it exists for invisible.
    expect(realpathSync(outside).startsWith(ROOT)).toBe(false);

    const result = run([
      "iteration-learn",
      "--gap",
      "the LEARN step never called the router",
      "--root-cause",
      "two systems that should be connected were not",
      "--mechanical-fix",
      "verify the router ran before reporting the learning captured",
      "--artifact-type",
      "workflow",
      "--session",
      "cli-outside",
    ]);

    expect({ code: result.code, stderr: result.stderr.trim().slice(0, 400) }).toEqual({
      code: 0,
      stderr: "",
    });
    expect(result.stdout).toContain("Tier:");
    // Single project history → Project tier, and the word has to be on stdout
    // because printing it is what the caller consumes.
    expect(result.stdout).toContain("project");

    // …and the artifact landed under the configured base dir, not the cwd.
    const learningDir = join(base, "learning");
    expect(existsSync(learningDir)).toBe(true);
    const categories = readdirSync(learningDir);
    expect(categories.length).toBeGreaterThan(0);
    const written = categories.flatMap((c) => readdirSync(join(learningDir, c)));
    expect(written.length).toBe(1);
    expect(readdirSync(outside)).toEqual([]);
  });

  test("refuses with a non-zero exit when a required field is missing", () => {
    const result = run(["iteration-learn", "--gap", "only half the inputs"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--root-cause");
  });
});
