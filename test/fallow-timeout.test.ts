/**
 * The fallow budget, and what a run killed by it is allowed to say (#311).
 *
 * PR #310 commit `eeba163` changed two markdown files and went red on
 * `FALLOW-1` only. The commit before it was green; a re-run with no change was
 * green. In that run `FALLOW-1` took 5010ms and failed while `FALLOW-2/3/4`
 * took 1226ms, 410ms and 408ms and passed, and `test/fallow-baseline.test.ts`
 * reported `fallow produced no output` at 5105ms with EMPTY stderr.
 *
 * Two readings on a 5000ms boundary is not two flakes. bun's per-test timeout
 * is 5000ms and nothing in this repo raised it, so:
 *
 *   - the FIRST fallow invocation in a process pays a cold cost the next three
 *     do not — `.fallow/cache.bin` is built once and reused — and FALLOW-1 is
 *     always the one that pays it; and
 *   - every repo-owned spawn declared a generous SPAWN timeout (180_000,
 *     120_000) while the `test`/`beforeAll` around it inherited 5000ms. The
 *     spawn budget was never reached, because the test wrapper was killed
 *     first. 5105ms is the hook dying, not fallow answering.
 *
 * And what the operator was shown on the way out is the worst part: the only
 * sentence `lib/conformity.ts` has for a missing reading is
 * `SKIP FALLOW-1: fallow is not installed (not a declared dependency)`, which
 * is FALSE — #261 made it an exactly-pinned devDependency and
 * `test/fallow-baseline.test.ts` asserts the local binary. A cause that sends
 * the reader to the wrong fix is worse than no cause.
 *
 * So three things live in `test/setup/fallow-run.ts` and are held here:
 *
 *   1. ONE budget, `FALLOW_BUDGET_MS`, declared once, used as the spawn
 *      timeout AND as the per-test timeout — those are two different clocks
 *      and declaring only the first is what produced the 5105ms reading.
 *   2. A warm-up spawned from the preload, so the cold cost is paid once per
 *      bun test process by something that is not a graded check.
 *   3. Three DIFFERENT sentences for not-installed, timed-out and
 *      empty-output, with the timeout sentence carrying none of the
 *      not-installed wording.
 *
 * WHAT WAS BROKEN TO MAKE THESE GO RED, run and counted rather than asserted.
 * Measured 2026-10-21 on this tree over `test/fallow-timeout.test.ts` +
 * `test/fallow-baseline.test.ts` (21 tests). Predicted before the battery ran,
 * Measured after, and every row names the input on which the mutant and the
 * original differ — a row that cannot name one is the code run twice, not a
 * mutation. The baseline row was read FIRST: an instrument that has stopped
 * reporting takes the baseline down with it, and that is the row nobody
 * mutates anything to produce. Each mutation was applied to the real source,
 * observed, reverted, and all five files confirmed byte-identical by sha256.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | baseline — unmutated | 21 pass, 0 fail | 21 pass, 0 fail | — |
 * | M1 the warm-up call removed from the preload — the genuinely pre-#311 `isolate.ts` | 1 | 1 of 21 | a fresh bun test process: `fallowWarmup()` read at module scope is a record with `outcome: "ok"` and a spawn count of 1 on the original, and `null` with 0 spawns on the mutant |
 * | M2 the once-per-process memo deleted from `warmFallow` | 1 | 1 of 21 | a second `warmFallow(ROOT)` in the same process: the original returns the same object and leaves the count at 1, the mutant spawns again |
 * | M3 `FALLOW_BUDGET_MS` lowered to bun's 5000ms default | 1 | 1 of 21 | a body that sleeps 5400ms: the original runs it to completion, the mutant is killed mid-body |
 * | M4 the per-test timeout dropped from the wrapper — the pre-#311 registration | 1 | 1 of 21 | the same 5400ms body. Every SOURCE assertion stays green under it, which is the whole reason the behavioural half exists |
 * | M5 the timed-out arm read AFTER the empty-stdout arm | 2 | 2 of 21 | `runFallowBudgeted(ROOT, ["dead-code"], { budgetMs: 1 })`: the original classifies `timed-out` and names 1ms, the mutant classifies `empty-output` — which is PR #310's `fallow produced no output` with empty stderr, verbatim |
 * | M6 the timeout sentence replaced by the not-installed sentence — `lib/conformity.ts`'s behaviour | 2 | 2 of 21 | the same 1ms run: the original's sentence carries neither `install` nor `PATH`, the mutant's carries both and sends the reader to `bun install` for a dependency that is pinned, installed and asserted |
 * | M7 the budget and the elapsed dropped from the timeout sentence | 1 | 1 of 21 | the same 1ms run: the original's message contains `1ms`, the mutant's contains no number |
 * | M8 a literal `timeout: 120_000` restored in `test/fallow-baseline.test.ts` | 1 | 1 of 21 | this tree: the original finds zero literal spawn timeouts, the mutant one — which is how 180_000 and 120_000 came to be two budgets in one file |
 *
 * WHAT IS NOT MEASURED HERE, stated rather than implied. The cold-start
 * differential itself. It was read once on this tree, on the first fallow
 * invocation after `bun install`: 1479ms, against 455ms for the next. It does
 * NOT reproduce by deleting `.fallow/` — re-measured 2026-10-21, three
 * consecutive `dead-code --unused-files` runs with no cache present are 568ms,
 * 517ms and 538ms, and the four conformity checks are 493/483/474/490ms with
 * the warm-up and 525/476/480/474ms without it. So the dominant cold cost is
 * `npx` resolution and the OS page cache, not the repo cache, and this machine
 * cannot be put back into the state a fresh CI runner starts in. AC-1's
 * witness is therefore M1 — that the warm-up HAPPENED, once, before any test
 * body — and not a stopwatch. A timing assertion here would be a check that
 * passes on every laptop and means nothing on the runner that produced 5010ms.
 *
 * THE CHEAPEST WRONG FIX, named: add `--timeout 30000` to the project's test
 * command. One flag, both red readings stop, and it is what somebody reaches
 * for at 5pm. **These cases survive it vacuously and do not catch it** — none
 * of them reads the command line, so the verdicts are unchanged either way.
 * Saying so is the point: left unstated it reads as coverage. What that repair
 * leaves behind is the whole of the issue minus the symptom — FALLOW-1 still
 * pays the cold start alone, so the margin is bigger and the race is the same,
 * and a budget kill still prints `fallow is not installed (not a declared
 * dependency)`, which is the sentence that cost #310 its diagnosis.
 */
import { describe, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";
import { fallowAvailable } from "rungate/lib/conformity";
import {
  FALLOW_BUDGET_MS,
  fallowInstalledLocally,
  fallowSpawnCount,
  fallowWarmup,
  runFallowBudgeted,
  warmFallow,
} from "./setup/fallow-run";
import { fallowBeforeAll, fallowTest } from "./setup/fallow-test";

const ROOT = join(import.meta.dir, "..");

/**
 * Read at MODULE SCOPE, before any `test` body in this file can run.
 *
 * That position is the assertion. A warm-up read from inside a test body
 * cannot tell "the preload ran it" from "the first test body ran it", and the
 * whole claim of AC-1 is that no graded check is the one paying the cold cost.
 */
const WARMUP_AT_IMPORT = fallowWarmup();
const SPAWNS_AT_IMPORT = fallowSpawnCount();

/** bun's own per-test default. The number the 5010ms and 5105ms readings are. */
const BUN_DEFAULT_TIMEOUT_MS = 5_000;

/** Repo-owned source the budget census walks. `node_modules` is not ours. */
function repoSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) out.push(full);
    }
  };
  for (const top of ["src", "test", "scripts", "bin"]) {
    const dir = join(ROOT, top);
    if (existsSync(dir)) walk(dir);
  }
  return out;
}

/**
 * The full text of a `Bun.spawnSync(...)` call, cut by matching parentheses.
 *
 * NOT a fixed-character window: the region a claim is about ends where the
 * construct ends, and `at + 400` is a guess that decays in silence the day
 * somebody adds an env var to the call.
 */
function spawnCalls(source: string): string[] {
  const calls: string[] = [];
  const needle = "Bun.spawnSync(";
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at === -1) return calls;
    // A quoted mention is prose, not a call — this file quotes the needle
    // itself, and a balanced cut starting inside a string literal never
    // terminates. Skipping on the preceding quote keeps the refusal below
    // meaning "a real call could not be read" rather than "a comment".
    if (/["'`]/.test(source[at - 1] ?? "")) {
      from = at + needle.length;
      continue;
    }
    let depth = 0;
    let end = -1;
    for (let i = at + needle.length - 1; i < source.length; i++) {
      const ch = source[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end === -1) {
      throw new Error(
        `an unterminated ${needle} at offset ${at} — the cut could not be taken, and a ` +
          `region that could not be read is not a region that was clean`,
      );
    }
    calls.push(source.slice(at, end));
    from = end;
  }
}

describe("the fallow budget is one number on both clocks (#311)", () => {
  fallowTest(
    "AC-1: the preloaded warm-up spawned fallow once, before this file was loaded",
    () => {
      // The preload is the only hook into the process that runs the GENERATED
      // conformity file, which this repo does not own and cannot edit. So the
      // warm-up has to be there or FALLOW-1 keeps paying the cold cost alone.
      if (WARMUP_AT_IMPORT === null) {
        throw new Error(
          `no warm-up record existed when this file was imported. ` +
            `test/setup/isolate.ts is the only entry in bunfig.toml's preload list; ` +
            `if it no longer calls warmFallow(), FALLOW-1 is again the first fallow ` +
            `invocation in the process and pays the cold start alone (#311).`,
        );
      }
      expect(WARMUP_AT_IMPORT.pid).toBe(process.pid);
      // Vacuity: a warm-up that recorded a run it never made would satisfy
      // everything above. It either spawned, or it declined for a stated reason.
      expect(["ok", "timed-out", "empty-output", "not-installed"]).toContain(
        WARMUP_AT_IMPORT.outcome,
      );
      if (fallowInstalledLocally(ROOT)) {
        expect(WARMUP_AT_IMPORT.outcome).toBe("ok");
        expect(WARMUP_AT_IMPORT.elapsedMs).toBeGreaterThan(0);
        expect(SPAWNS_AT_IMPORT).toBe(1);
      }

      // ONCE per process, which is the other half of AC-1: a warm-up that
      // re-spawned per test file would pay the cost it exists to amortise.
      const again = warmFallow(ROOT);
      expect(again).toBe(WARMUP_AT_IMPORT);
      expect(fallowSpawnCount()).toBe(SPAWNS_AT_IMPORT);
    },
  );

  fallowTest(
    "AC-2: every repo-owned fallow spawn shares one declared budget, and it is the per-test timeout too",
    async () => {
      // The BEHAVIOURAL half, and the only one that witnesses the second clock.
      // bun kills a test body at 5000ms unless a timeout was passed, so a body
      // that outlives 5000ms is proof the wrapper passed one. Source scanning
      // alone cannot see this: `fallowTest` could pass the budget to an
      // argument bun ignores and every grep below would still be green.
      const started = Date.now();
      await Bun.sleep(BUN_DEFAULT_TIMEOUT_MS + 400);
      expect(Date.now() - started).toBeGreaterThan(BUN_DEFAULT_TIMEOUT_MS);

      // The DECLARED half.
      expect(FALLOW_BUDGET_MS).toBeGreaterThanOrEqual(30_000);

      const sources = repoSources();
      expect(sources.length).toBeGreaterThan(0);

      // One declaration. Two budgets are two answers to one question, and the
      // day they disagree the run is killed by whichever clock is shorter —
      // which is 5105ms, exactly the reading this issue is about.
      const declarations = sources.filter(f =>
        /(?:const|let|var)\s+FALLOW_BUDGET_MS\b/.test(readFileSync(f, "utf-8")),
      );
      expect(declarations.map(f => relative(ROOT, f))).toEqual(["test/setup/fallow-run.ts"]);

      // Every repo-owned spawn of fallow passes the shared budget, and none
      // passes a number. A literal here is how 180_000 and 120_000 came to be
      // two different budgets in one file.
      const spawnsOfFallow: string[] = [];
      const literalTimeouts: string[] = [];
      const unbudgeted: string[] = [];
      for (const file of sources) {
        for (const call of spawnCalls(readFileSync(file, "utf-8"))) {
          // Any spawn that names fallow at all — the literal argv in
          // `fallowArgv`, and the `npx fallow --version` reading in
          // test/fallow-baseline.test.ts. The git spawns in that same file
          // name no fallow and are correctly not in the population.
          if (!/fallow/i.test(call)) continue;
          spawnsOfFallow.push(`${relative(ROOT, file)}: ${call.slice(0, 60)}`);
          if (/timeout:\s*[0-9]/.test(call)) literalTimeouts.push(relative(ROOT, file));
          if (!/timeout:\s*(?:budgetMs|FALLOW_BUDGET_MS)\b/.test(call)) {
            unbudgeted.push(relative(ROOT, file));
          }
        }
      }
      // Vacuity: zero spawns found is perfect agreement, and it is what a
      // renamed API or a broken cut produces.
      expect(spawnsOfFallow.length).toBeGreaterThanOrEqual(2);
      expect(literalTimeouts).toEqual([]);
      expect(unbudgeted).toEqual([]);

      // …and in those same files nothing registers a case on bun's default
      // clock. `test(` and `beforeAll(` inherit 5000ms; the wrappers do not.
      const bareRegistrations: string[] = [];
      const fallowFiles = sources.filter(
        f => /fallow/i.test(readFileSync(f, "utf-8")) && f.endsWith(".test.ts"),
      );
      expect(fallowFiles.length).toBeGreaterThanOrEqual(2);
      for (const file of fallowFiles) {
        const src = readFileSync(file, "utf-8");
        for (const form of ["test", "it", "beforeAll", "beforeEach"]) {
          // `fallowTest(` is excluded by the `\w` lookbehind, `.test(` by the
          // `.`, and a quoted mention of the form in prose by the quotes —
          // this file and the wrapper module both discuss `test(` by name,
          // and a registration is never preceded by a quote character.
          const bare = new RegExp(`(?<![\\w.$"'\`])${form}\\(`, "g");
          const hits = src.match(bare)?.length ?? 0;
          if (hits > 0) bareRegistrations.push(`${relative(ROOT, file)}: ${form}( x${hits}`);
        }
      }
      expect(bareRegistrations).toEqual([]);
    },
  );

  fallowTest(
    "AC-3: a run killed by its budget names the budget and the elapsed milliseconds",
    () => {
      // A forced one-millisecond budget, driving the REAL runner against the
      // real binary. Nothing is stubbed: this is `npx fallow dead-code` with
      // the clock set to a number it cannot beat.
      const outcome = runFallowBudgeted(ROOT, ["dead-code"], { budgetMs: 1 });
      expect(outcome.kind).toBe("timed-out");
      if (outcome.kind !== "timed-out") throw new Error("unreachable");

      expect(outcome.budgetMs).toBe(1);
      expect(outcome.elapsedMs).toBeGreaterThanOrEqual(0);
      // The two numbers are IN the sentence, not merely on the object. A
      // classification nobody prints is a classification nobody reads.
      expect(outcome.message).toContain(`${outcome.budgetMs}ms`);
      expect(outcome.message).toContain(`${outcome.elapsedMs}ms`);

      // And the budget is the one that was asked for, not a default the runner
      // substituted — a silent default here reads as a tool that is simply slow.
      const unforced = runFallowBudgeted(ROOT, ["dead-code"], { budgetMs: 2 });
      expect(unforced.kind).toBe("timed-out");
      if (unforced.kind !== "timed-out") throw new Error("unreachable");
      expect(unforced.budgetMs).toBe(2);
      expect(unforced.message).toContain("2ms");
    },
  );

  fallowTest(
    "AC-4: not-installed, timed-out and empty-output are three distinct sentences",
    () => {
      const notInstalledRoot = mkdtempSync(join(tmpdir(), "agentgrit-no-fallow-"));
      let notInstalled: string;
      try {
        const outcome = runFallowBudgeted(notInstalledRoot, ["dead-code"]);
        expect(outcome.kind).toBe("not-installed");
        if (outcome.kind !== "not-installed") throw new Error("unreachable");
        notInstalled = outcome.message;
      } finally {
        rmSync(notInstalledRoot, { recursive: true, force: true });
      }

      const timedOutOutcome = runFallowBudgeted(ROOT, ["dead-code"], { budgetMs: 1 });
      expect(timedOutOutcome.kind).toBe("timed-out");
      if (timedOutOutcome.kind !== "timed-out") throw new Error("unreachable");
      const timedOut = timedOutOutcome.message;

      // The empty reading. The spawn is injected rather than the classifier:
      // fallow answers every argv this repo can give it with SOMETHING on
      // stdout, so the only way to reach this branch with the real binary is
      // to kill it — which is the branch above. One seam, and the thing being
      // measured is still the real classifier.
      const emptyOutcome = runFallowBudgeted(ROOT, ["dead-code"], {
        spawn: () => ({ stdout: "   \n", stderr: "", exitedDueToTimeout: false }),
      });
      expect(emptyOutcome.kind).toBe("empty-output");
      if (emptyOutcome.kind !== "empty-output") throw new Error("unreachable");
      const empty = emptyOutcome.message;

      expect(new Set([notInstalled, timedOut, empty]).size).toBe(3);
      for (const sentence of [notInstalled, timedOut, empty]) {
        expect(sentence.length).toBeGreaterThan(40);
      }

      // The whole operator-facing half of #311: the timeout sentence must not
      // be the not-installed sentence. Every content word the not-installed
      // reading owns is forbidden in it, because a cause that sends the reader
      // to `bun add -d fallow` costs more than printing nothing would have.
      const NOT_INSTALLED_WORDING = [
        "not installed",
        "declared dependency",
        "install",
        "PATH",
      ];
      const leaked = NOT_INSTALLED_WORDING.filter(w =>
        timedOut.toLowerCase().includes(w.toLowerCase()),
      );
      expect(leaked).toEqual([]);
      // Vacuity: the list is only a filter if the sentence it was taken from
      // actually carries the words.
      const present = NOT_INSTALLED_WORDING.filter(w =>
        notInstalled.toLowerCase().includes(w.toLowerCase()),
      );
      expect(present).toEqual(NOT_INSTALLED_WORDING);
    },
  );

  fallowTest("AC-4: the narrow local reading agrees with the binding the checks gate on", () => {
    // `fallowInstalledLocally` is this repo's reading and is deliberately
    // NARROWER than rungate's `fallowAvailable`, which also accepts any
    // `fallow` on PATH. They are allowed to disagree on a machine with a
    // global install and no local one; on a tree that has run `bun install`
    // they must not, or the runner and the conformity checks are classifying
    // the same tree two ways.
    expect(fallowInstalledLocally(ROOT)).toBe(true);
    expect(fallowAvailable(ROOT)).toBe(true);
  });
});

/** The hook form exists and is budgeted too; asserting it is what keeps it so. */
describe("the budgeted hook wrapper (#311)", () => {
  let hookRan = false;
  fallowBeforeAll(() => {
    hookRan = true;
  });

  fallowTest("AC-2: the budgeted beforeAll wrapper runs its hook", () => {
    expect(hookRan).toBe(true);
  });
});
