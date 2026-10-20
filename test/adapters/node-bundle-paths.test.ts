/**
 * #279: `agentgritRepoRoot()` threw for every node consumer of the published
 * bundle, because `import.meta.dir` is a bun extension that
 * `bun build --target=node` leaves verbatim in the output.
 *
 * THE POINT OF THIS FILE IS THAT IT SPAWNS NODE.
 *
 * Every other test in this repo runs under bun, where `import.meta.dir` is
 * defined and the defect is invisible — which is exactly why it shipped and
 * then survived. A unit test asserting `agentgritRepoRoot()` does not throw
 * passes on the broken code. The only instrument that can see this is the
 * node-target bundle, executed by node.
 *
 * That makes these tests slower than their neighbours (a bundle build plus a
 * node spawn). The alternative is a check that cannot fail.
 *
 * And slower by a margin that is not a property of this repo. Measured
 * 2026-10-20: the whole file is 382ms locally and the first case alone took
 * 5032ms on a GitHub-hosted runner — 13x, against bun's 5000ms default, which
 * it missed by 32ms and took PR #294 red with it. A cold runner has no warm
 * bun build cache and no warm node, so the duration is the RUNNER's and the
 * default timeout is the thing that is wrong here, not the work.
 *
 * So every case declares BUNDLE_TIMEOUT_MS. Note what this does NOT weaken:
 * the assertions are unchanged, `runUnderNode` keeps its own 60s cap on the
 * node process, and a genuine throw still prints `THREW:` and fails the case
 * at whatever clock it happens on. A real hang hits the 60s cap and is still
 * a failure. The only thing bought is headroom for honest work.
 *
 * The cheapest wrong fix, named so the next reader can tell it apart: mark
 * these `test.skip` on CI, or wrap them in a retry. Either makes the red go
 * away and leaves the ONLY instrument that can see #279 switched off on the
 * one machine where it matters.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const repoRoot = join(import.meta.dir, "..", "..");

/**
 * Per-case clock budget. 60s matches `runUnderNode`'s own cap on the node
 * process, so the case cannot time out while the subprocess it is waiting on
 * is still inside its allowance — two deadlines where the outer one fires
 * first is a failure that names the wrong thing.
 */
const BUNDLE_TIMEOUT_MS = 60_000;

/** Build the node-target bundle of an arbitrary entry into a temp dir. */
function bundleForNode(entrySource: string, dir: string): string {
  const entry = join(dir, "entry.ts");
  const out = join(dir, "bundle.mjs");
  writeFileSync(entry, entrySource, "utf-8");
  execFileSync(
    "bun",
    ["build", entry, "--outfile", out, "--target=node"],
    { cwd: repoRoot, stdio: "pipe" },
  );
  return out;
}

function runUnderNode(bundle: string): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("node", [bundle], {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 60_000,
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: `${e.stdout ?? ""}${e.stderr ?? ""}`,
      status: e.status ?? 1,
    };
  }
}

const PROBE = `
import { agentgritRepoRoot } from ${JSON.stringify(join(repoRoot, "src", "adapters", "paths.ts"))};
try {
  const root = agentgritRepoRoot();
  console.log("OK:" + (root === null ? "null" : "path"));
} catch (err) {
  console.log("THREW:" + err.message);
}
`;

describe("the node-target bundle runs under node (#279)", () => {
  test("agentgritRepoRoot does not throw when executed by node", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentgrit-node-bundle-"));
    try {
      const bundle = bundleForNode(PROBE, dir);
      const { stdout } = runUnderNode(bundle);

      // Both readings are fine — resolving the root, or honestly reporting it
      // could not be found. Throwing is not, and `resolve(undefined)` is what
      // it threw.
      expect(stdout).toContain("OK:");
      expect(stdout).not.toContain("THREW:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, BUNDLE_TIMEOUT_MS);

  test("no shipped source reaches the bundle carrying a bun-only import.meta.dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentgrit-node-bundle-scan-"));
    try {
      const bundle = bundleForNode(PROBE, dir);
      const text = readFileSync(bundle, "utf-8");
      // `bun build --target=node` does not rewrite this. If it appears, some
      // module on this path will see `undefined` under node.
      expect(text).not.toMatch(/import\.meta\.dir\b/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, BUNDLE_TIMEOUT_MS);

  test("the probe can actually observe a throw", () => {
    // Control. Both assertions above are "absence" assertions, and an absence
    // is also what a probe that never ran produces: a bundle that failed to
    // build, a node that printed nothing, a harness quietly returning "". So
    // the same machinery is pointed at code that definitely throws, and must
    // report it.
    const dir = mkdtempSync(join(tmpdir(), "agentgrit-node-bundle-control-"));
    try {
      const bundle = bundleForNode(
        `
import { resolve } from "path";
try {
  resolve(undefined);
  console.log("OK:path");
} catch (err) {
  console.log("THREW:" + err.message);
}
`,
        dir,
      );
      const { stdout } = runUnderNode(bundle);
      expect(stdout).toContain("THREW:");
      expect(stdout).toContain("must be of type string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, BUNDLE_TIMEOUT_MS);
});
