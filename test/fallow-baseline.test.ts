/**
 * The fallow ratchet reconciles with what is actually suppressed (#261).
 *
 * `FALLOW-1..4` in `test/scaffold-conformity.test.ts` answer one question:
 * does fallow report any dead code that is NOT banked? They go red on
 * anything new, and that is the whole of their job. Nothing is asserted here
 * about the live fallow output, deliberately — two guards answering one
 * question about one input are behaviourally one guard, and a mutation of
 * either leaves the other holding the case up.
 *
 * The question nobody else asks is whether `fallow-baseline.json` still
 * describes the suppressions. A number and the thing it counts live in two
 * files, so they drift in silence: delete a `circular-dependency` marker and
 * the conformity run stays green while the baseline keeps claiming six, and
 * the next person to lower the number has no way to tell what it meant.
 *
 * So this file compares the two, in both directions. Over-banking and
 * under-banking are both red.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, relative, sep } from "path";
import { fallowAvailable } from "rungate/lib/conformity";

const ROOT = join(import.meta.dir, "..");
const BASELINE_PATH = join(ROOT, "fallow-baseline.json");
const CONFIG_PATH = join(ROOT, ".fallowrc.json");

/** The exact marker fallow honours. A near-miss suppresses nothing. */
const CYCLE_MARKER = "// fallow-ignore-next-line circular-dependency";

interface Baseline {
  issue: number;
  bankedAt: string;
  _comment: string;
  /** Names the tool version the banked counts were taken with. */
  measuredWith: string;
  counts: Record<string, number>;
  circularDependencySites: Array<{ file: string; markers: number; cycles: number }>;
}

interface FallowConfig {
  ignoreFindings?: string[];
  ignoreExports?: Array<{ file: string; exports: string[] }>;
  ignoreDependencies?: string[];
}

const baseline: Baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
const config: FallowConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

/** Every `.ts` file under `src/`, repo-relative, `/`-separated. */
function srcFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) out.push(relative(ROOT, full).split("\\").join("/"));
    }
  };
  walk(join(ROOT, "src"));
  return out;
}

function markerCount(relPath: string): number {
  return readFileSync(join(ROOT, relPath), "utf-8").split(CYCLE_MARKER).length - 1;
}

describe("fallow baseline ratchet (#261)", () => {
  test("the baseline is a readable record and not just a number", () => {
    expect(baseline.issue).toBe(261);
    expect(typeof baseline.bankedAt).toBe("string");
    // A ratchet nobody can interpret becomes a number nobody lowers.
    expect(baseline._comment.length).toBeGreaterThan(80);
    for (const cls of ["unusedFiles", "unusedExports", "unusedDependencies", "circularDependencies"]) {
      expect(typeof baseline.counts[cls]).toBe("number");
    }
  });

  test("unusedFiles equals the files banked in .fallowrc.json", () => {
    const banked = config.ignoreFindings ?? [];
    // Non-emptiness is asserted separately: comparing two empty collections
    // is satisfied by a config whose suppressions were all deleted.
    expect(banked.length).toBeGreaterThan(0);
    expect(banked.length).toBe(baseline.counts.unusedFiles);
  });

  test("unusedExports equals the export names banked in .fallowrc.json", () => {
    const rules = config.ignoreExports ?? [];
    expect(rules.length).toBeGreaterThan(0);
    // `exports: ["*"]` would bank an unbounded, uncountable population — a
    // suppression that keeps growing while the recorded number stands still.
    expect(rules.flatMap(r => r.exports).filter(n => n === "*")).toEqual([]);
    const banked = rules.reduce((n, r) => n + r.exports.length, 0);
    expect(banked).toBe(baseline.counts.unusedExports);
  });

  test("unusedDependencies is zero and nothing is suppressing a dependency", () => {
    expect(config.ignoreDependencies ?? []).toEqual([]);
    expect(baseline.counts.unusedDependencies).toBe(0);
  });

  test("circularDependencies equals the cycles the inline markers bank", () => {
    const sites = baseline.circularDependencySites;
    expect(sites.length).toBeGreaterThan(0);
    const declared = sites.reduce((n, s) => n + s.cycles, 0);
    expect(declared).toBe(baseline.counts.circularDependencies);
  });

  test("every declared cycle site carries the markers it claims", () => {
    const actual = baseline.circularDependencySites.map(s => ({
      file: s.file,
      markers: markerCount(s.file),
    }));
    expect(actual).toEqual(
      baseline.circularDependencySites.map(s => ({ file: s.file, markers: s.markers })),
    );
  });

  test("no cycle marker exists outside the declared sites", () => {
    const declared = new Set(baseline.circularDependencySites.map(s => s.file));
    const undeclared = srcFiles().filter(f => !declared.has(f) && markerCount(f) > 0);
    expect(undeclared).toEqual([]);
  });
});

/**
 * …and the bank is reconciled against the tree, not only against itself.
 *
 * The describe above compares `fallow-baseline.json` to `.fallowrc.json`. Both
 * are declarations, so every assertion in it holds over a suppression that
 * suppresses nothing: add `src/gone.ts` to `ignoreFindings`, raise
 * `counts.unusedFiles` to 5 in the same commit, and the two sides still agree.
 * The conformity checks cannot see it either — they read the SUPPRESSED tree,
 * where a dead exemption and a live one look identical. So the question "does
 * each banked entry still own a finding" is asked by nothing, which is how an
 * exemption list grows under a ratchet that reports it is holding.
 *
 * The one reading that can answer it is fallow with the config suppressions
 * removed. Measured 2026-10-21 on this tree: unsuppressed is 4 unused files
 * and 67 unused exports — exactly what is banked — while the suppressed
 * reading the conformity checks see is 0 of everything.
 *
 * NOT measured here, stated rather than implied: `circularDependencies`.
 * fallow's own schema says the inter-file rules take no config suppression and
 * names `// fallow-ignore-next-line circular-dependency` as the mechanism, so
 * stripping the config cannot unsuppress a cycle — the unsuppressed run still
 * reports 0. The marker census above is what holds those six, and the last
 * test here pins the premise so the day fallow gains a config form, this file
 * goes red rather than going on quietly not measuring them.
 *
 * Refusals, never skips: an unresolvable binary, an unparseable reading or an
 * empty one ends this block loudly. `0`, `{}` and silence are
 * indistinguishable from success.
 */
describe("fallow baseline reconciles with the unsuppressed tree (#261)", () => {
  /** Config keys that HIDE findings, as against `entry`/`ignorePatterns`, which scope the walk. */
  const SUPPRESSION_KEYS = ["ignoreFindings", "ignoreExports", "ignoreDependencies"];
  /** Every `ignore*` key this file knows the meaning of. A new one must be classified, not inherited. */
  const KNOWN_IGNORE_KEYS = [...SUPPRESSION_KEYS, "ignorePatterns"];

  interface Reading {
    unused_files: Array<{ path: string }>;
    unused_exports: Array<{ path: string; export_name: string }>;
    unused_dependencies: unknown[];
    circular_dependencies: unknown[];
  }

  function runFallow(configPath?: string): Reading {
    const args = ["fallow", "dead-code"];
    if (configPath) args.push("--config", configPath);
    args.push("--format", "json", "--quiet");
    const proc = Bun.spawnSync(["npx", ...args], {
      cwd: ROOT,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      timeout: 180_000,
    });
    const stdout = proc.stdout.toString().trim();
    if (!stdout) {
      throw new Error(
        `fallow produced no output (config=${configPath ?? ".fallowrc.json"}). ` +
          `stderr: ${proc.stderr.toString().slice(0, 400)}`,
      );
    }
    let parsed: Reading & { error?: boolean; message?: string };
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`fallow output did not parse as JSON: ${stdout.slice(0, 400)}`);
    }
    if (parsed.error) throw new Error(`fallow refused: ${parsed.message}`);
    for (const key of ["unused_files", "unused_exports", "unused_dependencies", "circular_dependencies"]) {
      if (!Array.isArray((parsed as unknown as Record<string, unknown>)[key])) {
        throw new Error(`fallow's JSON carries no '${key}' array — the conformity check reads it`);
      }
    }
    return parsed;
  }

  let scratch: string;
  let suppressed: Reading;
  let unsuppressed: Reading;

  beforeAll(() => {
    const unknown = Object.keys(config).filter(
      k => k.toLowerCase().startsWith("ignore") && !KNOWN_IGNORE_KEYS.includes(k),
    );
    if (unknown.length > 0) {
      throw new Error(
        `.fallowrc.json carries ignore key(s) this file does not classify: ${unknown.join(", ")}. ` +
          `Add each to SUPPRESSION_KEYS (it hides findings) or to KNOWN_IGNORE_KEYS (it scopes the walk) — ` +
          `an unclassified suppression survives the strip, and the unsuppressed reading then measures nothing.`,
      );
    }

    // The unsuppressed config is DERIVED from the live one rather than written
    // out a second time: two entry-point lists would drift, and the reading
    // taken against the stale one would be a measurement of nothing.
    scratch = mkdtempSync(join(tmpdir(), "agentgrit-fallow-"));
    const full: Record<string, unknown> = { ...(config as Record<string, unknown>) };
    delete full.$schema;
    for (const key of SUPPRESSION_KEYS) delete full[key];
    const fullPath = join(scratch, "fallow-unsuppressed.json");
    writeFileSync(fullPath, JSON.stringify(full));

    suppressed = runFallow();
    unsuppressed = runFallow(fullPath);
  });

  afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  test("the unsuppressed reading is what the baseline banks — in both directions", () => {
    // Vacuity first: a derivation that produced a config finding nothing would
    // satisfy "0 unbanked findings" and every comparison below it.
    expect(unsuppressed.unused_files.length + unsuppressed.unused_exports.length).toBeGreaterThan(0);
    expect(unsuppressed.unused_files.length).toBe(baseline.counts.unusedFiles);
    expect(unsuppressed.unused_exports.length).toBe(baseline.counts.unusedExports);
    expect(unsuppressed.unused_dependencies.length).toBe(baseline.counts.unusedDependencies);
  });

  test("every banked path still owns a finding — the bank is not an exemption list", () => {
    const owners = new Set(unsuppressed.unused_files.map(f => f.path));
    const stale = (config.ignoreFindings ?? []).filter(p => !owners.has(p));
    expect(stale).toEqual([]);
  });

  test("every banked export still owns a finding", () => {
    const owned = new Set(unsuppressed.unused_exports.map(e => `${e.path}::${e.export_name}`));
    const stale: string[] = [];
    for (const rule of config.ignoreExports ?? []) {
      for (const name of rule.exports) {
        if (!owned.has(`${rule.file}::${name}`)) stale.push(`${rule.file}::${name}`);
      }
    }
    expect(stale).toEqual([]);
  });

  test("the suppressed reading the conformity checks see is empty", () => {
    // Without this, "FALLOW-1 passed" and "FALLOW-1 was measured against a
    // different tree than this file was" are the same observation.
    expect({
      unusedFiles: suppressed.unused_files.length,
      unusedExports: suppressed.unused_exports.length,
      unusedDependencies: suppressed.unused_dependencies.length,
      circularDependencies: suppressed.circular_dependencies.length,
    }).toEqual({ unusedFiles: 0, unusedExports: 0, unusedDependencies: 0, circularDependencies: 0 });
  });

  test("cycles are UNMEASURED by the config strip — the premise the marker census rests on", () => {
    // fallow suppresses circular-dependency only from a source comment, so the
    // strip above cannot reach the six this tree banks. If this ever reports
    // them, the strip HAS become a reading of cycles and the marker census is
    // no longer the only thing holding them — which is a better world, and one
    // this file should be rewritten for rather than left silently stale.
    expect(unsuppressed.circular_dependencies.length).toBe(0);
    expect(baseline.counts.circularDependencies).toBeGreaterThan(0);
    expect(baseline.circularDependencySites.length).toBeGreaterThan(0);
  });
});

/**
 * …and the three things that make any of the above a measurement at all.
 *
 * Everything in this file so far compares one reading to another. None of it
 * can fire when there is no reading: `runFallowCommand` in `lib/conformity.ts`
 * asks `fallowAvailable(root)` first and, on a false answer, prints
 * `SKIP FALLOW-N` and returns. A skipped check is a green check. That is the
 * state issue #261 opened in — four conformity checks reporting nothing wrong
 * about a tree none of them had looked at — and Phase 1 left it one ordinary
 * edit away from returning, because nothing held the three artefacts it added:
 *
 *   1. the devDependency, without which `bun install` installs no binary,
 *   2. the binary under `node_modules/.bin`, which is what makes the spawn a
 *      local resolution rather than a registry fetch per invocation, and
 *   3. `fallow-baseline.json`, which is what the counts mean.
 *
 * Drop any one and the suite goes back to passing for a reason unrelated to
 * the code. So each is pinned here, in a repo-owned file rather than in the
 * generated conformity run, and `.claude/rules/checks-must-be-able-to-fail.md`
 * asks what was broken to make each go red.
 *
 * WHAT WAS BROKEN, run and counted rather than asserted. Measured 2026-10-21
 * on this tree, each mutation applied to the real files, observed, reverted,
 * and the files confirmed byte-identical by sha256 afterwards. Every count was
 * predicted before the battery ran, and the baseline rows were read first — an
 * instrument that has stopped reporting takes the baseline down with it, and
 * that is the row nobody mutates anything to produce. The denominator is the
 * three cases below, selected by the same `--test-name-pattern` the brief uses.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | baseline, these three | 3 pass, 0 fail | 3 pass, 0 fail | — |
 * | baseline, whole file | 15 pass, 0 fail | 15 pass, 0 fail | — |
 * | `fallow` deleted from `devDependencies` | 1 | 1 of 3 | this tree: the original reads one declaring field, the mutant reads none — and `bun install` then installs no binary |
 * | `fallow` ALSO added to `dependencies` | 1 | 1 of 3 | two fields naming the tool: the original reports one declaring position, the mutant two, which is two answers to one question |
 * | the pin loosened to `^3.34.1` | 1 | 1 of 3 | a caret spec: the original demands `x.y.z`, the mutant's spec re-resolves and the installed binary drifts off the banked counts |
 * | `measuredWith` bumped to 3.34.2, pin left at 3.34.1 | 2 | 2 of 3 | a bank claiming a version nothing installs: the declaration case sees 3.34.1 against 3.34.2, and the version reading comes back `fallow 3.34.1` |
 * | `node_modules/.bin/fallow` moved aside | 1 | 1 of 3 | a tree with no local install: `existsSync` is false, which is precisely the state in which `fallowAvailable` goes false on CI and FALLOW-1..4 print SKIP |
 * | every `counts` entry set to 0 | 1 | 1 of 3 | a bank of four zeros: it parses, carries four integers, and banks nothing |
 * | one byte flipped in `fallow-baseline.json` | the file aborts | 0 pass, 1 fail, 1 error — `SyntaxError` at load | an unparseable bank: nothing in the file runs, loudly |
 *
 * The last row is the honest one to read carefully. The corruption refusal is
 * the MODULE-SCOPE parse's, not the third case's — both would refuse, so they
 * are two deciders answering one question and no count can tell them apart.
 * The third case re-reads the bytes anyway so that it is not asserting over an
 * object its own setup produced, but what it uniquely holds is the rest: the
 * bank is at the canonical path, is tracked by git, and carries non-negative
 * integers summing above zero. Those are the assertions the 1-of-3 row above
 * is measuring.
 *
 * THE CHEAPEST WRONG FIXES, named, and whether these cases survive them:
 *
 *  - The declaration case goes red after a version bump. The 5pm repair is to
 *    edit `measuredWith` to the new version and ship without re-measuring.
 *    These cases GO GREEN under it — they compare two declarations, and both
 *    now agree. What catches it is the reconciling block above, which runs the
 *    new binary and compares its findings to the banked counts. Said out loud
 *    because a survival nobody writes down reads as coverage.
 *  - The local binary is missing in some environment. The 5pm repair is
 *    `npm i -g fallow`, which satisfies `fallowAvailable` — it accepts a
 *    `fallow` anywhere on PATH, which is exactly why asserting that alone
 *    would be the skip wearing a green tick. The case SURVIVES: the path under
 *    this project is asserted directly, so a machine-wide install leaves it
 *    red and the CI-only failure stays visible here.
 *  - The bank is renamed. The 5pm repair is to edit `BASELINE_PATH` at the top
 *    of this file, and these cases go green. Nothing holds that name, because
 *    nothing outside this file reads it — the readers are this file and the
 *    people lowering the numbers.
 */
describe("the fallow run is wired rather than skipped (#261)", () => {
  /** Every field `bun install` would honour. A declaration in any of them installs. */
  const DEPENDENCY_FIELDS = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ] as const;

  const BASELINE_FILE = "fallow-baseline.json";
  const LOCAL_BIN = join(ROOT, "node_modules", ".bin", "fallow");

  const pkg: Record<string, unknown> = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

  function specIn(field: string): string | undefined {
    const map = pkg[field];
    if (typeof map !== "object" || map === null) return undefined;
    const spec = (map as Record<string, unknown>).fallow;
    return typeof spec === "string" ? spec : undefined;
  }

  /**
   * The version the bank says it was taken with.
   *
   * A refusal, not a default: an unreadable `measuredWith` compared against an
   * unreadable package spec is two absences agreeing, which is this file's own
   * reason for existing one level up.
   */
  const MEASURED_VERSION: string = (() => {
    const raw = baseline.measuredWith;
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new Error(
        `${BASELINE_FILE} carries no 'measuredWith' string, so there is no recorded ` +
          `version to hold the installed tool to. A bank that does not say what produced ` +
          `it cannot be reconciled with anything.`,
      );
    }
    const match = raw.match(/\bfallow (\d+\.\d+\.\d+)\b/);
    if (!match) {
      throw new Error(
        `${BASELINE_FILE}'s 'measuredWith' names no 'fallow <x.y.z>' version: ${raw.slice(0, 160)}`,
      );
    }
    return match[1]!;
  })();

  test("fallow is declared as an exactly-pinned devDependency, in one position", () => {
    const declaring = DEPENDENCY_FIELDS.filter(f => specIn(f) !== undefined);
    // One declaring position. Two would be two answers to one question, and
    // the day they disagree the installed binary is whichever bun resolved.
    expect(declaring).toEqual(["devDependencies"]);

    const spec = specIn("devDependencies")!;
    // A range re-resolves. The binary that produced the banked counts and the
    // binary CI installs stop being the same artefact, with nothing saying so.
    expect(spec).toMatch(/^\d+\.\d+\.\d+$/);

    // …and it is the version the bank names. Two files stating one version
    // with nothing comparing them is how they come to disagree in silence.
    expect({ pinned: spec, banked: MEASURED_VERSION }).toEqual({
      pinned: MEASURED_VERSION,
      banked: MEASURED_VERSION,
    });
  });

  test("the fallow binary resolves from this project's own node_modules, not the network", () => {
    // `fallowAvailable` is the binding the conformity checks gate on, and it
    // accepts EITHER a local install OR any `fallow` on PATH. A machine-wide
    // install answers true on a laptop and false on CI, so asserting it alone
    // would be the silent skip wearing a green tick. The local path is the
    // witness; fallowAvailable is asserted only to tie this to the consumer.
    expect(existsSync(LOCAL_BIN)).toBe(true);
    expect(statSync(LOCAL_BIN).mode & 0o111).toBeGreaterThan(0);
    expect(realpathSync(LOCAL_BIN).startsWith(realpathSync(ROOT) + sep)).toBe(true);
    expect(fallowAvailable(ROOT)).toBe(true);

    // The reading. `npx fallow` is the exact spawn `runFallowCommand` makes,
    // run here with the registry pointed at a closed port and the installer
    // offline. An answer under those conditions cannot have been fetched.
    const proc = Bun.spawnSync(["npx", "fallow", "--version"], {
      cwd: ROOT,
      env: {
        ...process.env,
        npm_config_registry: "http://127.0.0.1:1/",
        npm_config_offline: "true",
        NODE_NO_WARNINGS: "1",
      },
      timeout: 120_000,
    });
    const reading = proc.stdout.toString().trim();
    if (!reading) {
      throw new Error(
        `\`npx fallow --version\` produced no output with the registry unreachable — ` +
          `the spawn the conformity checks make is NOT resolving locally. ` +
          `stderr: ${proc.stderr.toString().slice(0, 400)}`,
      );
    }
    expect(reading.split("\n")[0]!.trim()).toBe(`fallow ${MEASURED_VERSION}`);
  });

  test("the baseline file parses, is committed, and banks something", () => {
    // Read the bytes here rather than reusing the module-scope parse: a case
    // asserting over an object the file already parsed is asserting a value
    // the test's own setup produced.
    expect(existsSync(BASELINE_PATH)).toBe(true);

    const inRepo = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], { cwd: ROOT });
    if (!inRepo.success) {
      throw new Error(
        `cannot establish whether ${BASELINE_FILE} is committed: ${ROOT} is not a git work ` +
          `tree. A reading that could not be taken is not a reading that passed.`,
      );
    }
    // Tracked, because a bank that exists only in this checkout is a bank CI
    // does not have — and a ratchet CI cannot read is a ratchet that holds
    // nothing, which is the shape of the defect this whole file is about.
    const tracked = Bun.spawnSync(["git", "ls-files", "--error-unmatch", "--", BASELINE_FILE], {
      cwd: ROOT,
    });
    if (!tracked.success) {
      throw new Error(
        `${BASELINE_FILE} is not tracked by git: ${tracked.stderr.toString().trim().slice(0, 200)}`,
      );
    }

    let parsed: Baseline;
    const raw = readFileSync(BASELINE_PATH, "utf-8");
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `${BASELINE_FILE} did not parse as JSON (${(err as Error).message}); ` +
          `first bytes: ${raw.slice(0, 120)}`,
      );
    }

    const classes = ["unusedFiles", "unusedExports", "unusedDependencies", "circularDependencies"];
    const counts = parsed.counts ?? {};
    // Integers, not merely numbers: `1.5` findings and `-1` findings are both
    // a corrupted bank that `typeof === "number"` reports as healthy.
    const malformed = classes.filter(c => !Number.isInteger(counts[c]) || (counts[c] as number) < 0);
    expect(malformed).toEqual([]);

    // A bank of all zeros parses, carries four integers, and suppresses
    // nothing — indistinguishable from a bank that was emptied, which is why
    // the sum is asserted rather than only the shape.
    expect(classes.reduce((n, c) => n + (counts[c] as number), 0)).toBeGreaterThan(0);
  });
});
