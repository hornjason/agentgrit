/**
 * One budget, one spawn, and three different sentences for three different
 * ways of having no reading (#311).
 *
 * This module is imported by `test/setup/isolate.ts`, which `bunfig.toml`
 * preloads into every bun test process, so it must NOT import `bun:test` —
 * the per-test and per-hook wrappers live in `test/setup/fallow-test.ts`
 * instead, and both get the budget from here. One declaration, two clocks.
 *
 * ## Why a budget at all
 *
 * `lib/conformity.ts` spawns fallow with `timeout: 30_000` and this repo's
 * own spawns used 180_000 and 120_000 — all three generous, and none of them
 * the clock that fired. bun kills a `test` or `beforeAll` body at 5000ms
 * unless the registration passes a timeout, and no registration did. On
 * PR #310 that killed `FALLOW-1` at 5010ms and a `beforeAll` at 5105ms on a
 * commit that changed two markdown files.
 *
 * ## Why a warm-up
 *
 * fallow builds `.fallow/cache.bin` on its first run in a tree and reuses it
 * afterwards. Measured here 2026-10-21: 1479ms cold, 455ms warm. Whichever
 * check runs first pays the difference, and it is always FALLOW-1 — so
 * FALLOW-1 fails on CI for a cost the other three never see, on commits that
 * touched nothing. `warmFallow` pays it once per process, from the preload,
 * where it is not a graded check.
 */
import { existsSync } from "fs";
import { join } from "path";

/**
 * The one budget. Spawn timeout AND per-test timeout, everywhere in this repo.
 *
 * 180s rather than 30s: the number this has to clear is not fallow's typical
 * run but its worst, on a cold CI runner with a cold `.fallow` cache, and a
 * budget that is occasionally exceeded reintroduces exactly the flake #311 is
 * about. The thing being bounded is a hang, not slowness.
 */
export const FALLOW_BUDGET_MS = 180_000;

/** What a spawn has to tell the classifier. A seam, so a case can force one. */
export interface FallowSpawnReading {
  stdout: string;
  stderr: string;
  exitedDueToTimeout: boolean;
}

export interface FallowRunOptions {
  /** Defaults to `FALLOW_BUDGET_MS`. A case forces a small one to drive the timeout arm. */
  budgetMs?: number;
  /** Test seam. Defaults to the real `npx fallow` spawn. */
  spawn?: (argv: string[], budgetMs: number) => FallowSpawnReading;
}

export type FallowOutcome =
  | { kind: "ok"; stdout: string; elapsedMs: number }
  | { kind: "not-installed"; message: string; elapsedMs: number }
  | { kind: "timed-out"; message: string; budgetMs: number; elapsedMs: number }
  | { kind: "empty-output"; message: string; elapsedMs: number; stderr: string };

/**
 * The binary `npx fallow` resolves to when it resolves locally.
 *
 * Module-local on purpose: an export nothing imports is an unused export, and
 * `test/fallow-baseline.test.ts` reconciles this tree against
 * `fallow-baseline.json` in both directions, so a convenience export here
 * silently raises a banked count somebody else has to interpret.
 */
function fallowLocalBin(root: string): string {
  return join(root, "node_modules", ".bin", "fallow");
}

/**
 * This repo's reading of "can fallow run here", deliberately NARROWER than
 * rungate's `fallowAvailable`, which also accepts any `fallow` on PATH.
 *
 * A machine-wide install answers true on a laptop and false on CI, so a local
 * binary is the only reading that means the same thing in both places. The two
 * are asserted to agree on this tree in `test/fallow-timeout.test.ts`; they are
 * allowed to disagree on a machine that never ran `bun install`.
 */
export function fallowInstalledLocally(root: string): boolean {
  return existsSync(fallowLocalBin(root));
}

/**
 * Three sentences, and the only rule about them is that they are three.
 *
 * `lib/conformity.ts` has one for all of these — "fallow is not installed (not
 * a declared dependency)" — and printed it when the run was killed by a clock.
 * A reader acting on that goes and declares a dependency that is already
 * declared, pinned and installed. So the timeout sentence is forbidden every
 * content word the not-installed sentence owns, and that is asserted rather
 * than left to care.
 */
function notInstalledMessage(root: string): string {
  return (
    `fallow is not installed in this tree: no binary at ${fallowLocalBin(root)} — ` +
    `so no run was attempted, no registry fetch was made, and nothing was measured. ` +
    `fallow is an exactly-pinned declared dependency of this project (#261), so \`bun install\` ` +
    `is the fix; a fallow on PATH also satisfies rungate, at the cost of a reading CI cannot reproduce.`
  );
}

function timedOutMessage(budgetMs: number, elapsedMs: number, argv: string[]): string {
  return (
    `fallow was killed by its budget after ${elapsedMs}ms of an allowed ${budgetMs}ms ` +
    `(\`${argv.join(" ")}\`). The binary resolved and the run started, so this is a ` +
    `budget reading and nothing was measured about the tree. Either the run is genuinely ` +
    `hung, or FALLOW_BUDGET_MS in test/setup/fallow-run.ts is too small for this machine.`
  );
}

function emptyOutputMessage(elapsedMs: number, argv: string[], stderr: string): string {
  return (
    `fallow finished in ${elapsedMs}ms and wrote nothing to stdout (\`${argv.join(" ")}\`). ` +
    `An empty reading is not an empty tree, so this is UNMEASURED rather than clean. ` +
    `stderr: ${stderr.trim().slice(0, 400) || "(nothing)"}`
  );
}

let spawnCount = 0;

/** How many times this process has actually spawned fallow. The warm-up's witness. */
export function fallowSpawnCount(): number {
  return spawnCount;
}

/**
 * The exact spawn `runFallowCommand` in `rungate/lib/conformity.ts` makes.
 *
 * `npx` rather than the resolved binary, deliberately: the conformity checks
 * this repo cannot edit spawn `npx fallow`, and a warm-up that warmed a
 * different command would warm the wrong thing.
 *
 * Module-local, for the same reason `fallowLocalBin` is.
 */
function fallowArgv(args: string[]): string[] {
  return ["npx", "fallow", ...args];
}

function realSpawn(args: string[], budgetMs: number, root: string): FallowSpawnReading {
  spawnCount++;
  const proc = Bun.spawnSync(fallowArgv(args), {
    cwd: root,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    timeout: budgetMs,
  });
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitedDueToTimeout: proc.exitedDueToTimeout === true,
  };
}

/**
 * Run fallow under the shared budget and classify what came back.
 *
 * The order of the arms is load-bearing. A run killed by the clock produces
 * empty stdout, so "timed out" has to be read before "wrote nothing" or every
 * timeout is reported as an empty reading — which is the 5105ms line in #310,
 * reported as `fallow produced no output` with empty stderr.
 */
export function runFallowBudgeted(
  root: string,
  args: string[],
  opts: FallowRunOptions = {},
): FallowOutcome {
  const budgetMs = opts.budgetMs ?? FALLOW_BUDGET_MS;
  const argv = fallowArgv(args);

  if (!fallowInstalledLocally(root)) {
    return { kind: "not-installed", message: notInstalledMessage(root), elapsedMs: 0 };
  }

  const started = Date.now();
  const reading = opts.spawn ? opts.spawn(argv, budgetMs) : realSpawn(args, budgetMs, root);
  const elapsedMs = Date.now() - started;

  if (reading.exitedDueToTimeout) {
    return {
      kind: "timed-out",
      message: timedOutMessage(budgetMs, elapsedMs, argv),
      budgetMs,
      elapsedMs,
    };
  }

  const stdout = reading.stdout.trim();
  if (!stdout) {
    return {
      kind: "empty-output",
      message: emptyOutputMessage(elapsedMs, argv, reading.stderr),
      elapsedMs,
      stderr: reading.stderr,
    };
  }

  return { kind: "ok", stdout, elapsedMs };
}

export interface FallowWarmup {
  pid: number;
  elapsedMs: number;
  outcome: FallowOutcome["kind"];
  /** The runner's own sentence when the warm-up did not get a reading. */
  detail: string | null;
}

let warmup: FallowWarmup | null = null;

/** The warm-up this process performed, or `null` if the preload never ran one. */
export function fallowWarmup(): FallowWarmup | null {
  return warmup;
}

/**
 * Pay fallow's cold cost once per process, before any test body runs.
 *
 * Deliberately silent on failure. This is not a check — it is a cost being
 * moved off whichever graded check happened to be first — and a warm-up that
 * can fail a run would be a new way for an unrelated commit to go red, which
 * is the thing #311 is removing. What it did is RECORDED instead, and
 * `test/fallow-timeout.test.ts` is where that record is judged.
 */
export function warmFallow(root: string): FallowWarmup {
  if (warmup !== null) return warmup;
  const started = Date.now();
  const outcome = runFallowBudgeted(root, ["dead-code"]);
  warmup = {
    pid: process.pid,
    elapsedMs: Date.now() - started,
    outcome: outcome.kind,
    detail: outcome.kind === "ok" ? null : outcome.message,
  };
  return warmup;
}
