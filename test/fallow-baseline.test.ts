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
 * …and the three artefacts the whole arrangement stands on are pinned (#261).
 *
 * Everything above reasons about readings. None of it survives the regression
 * that opened this issue, because that regression removes the ability to take
 * one: `fallowAvailable(root)` in `rungate/lib/fallow-availability.ts` answers
 * `existsSync(root/node_modules/.bin/fallow) || Bun.which("fallow") !== null`,
 * and on `false` each of `FALLOW-1..4` prints `SKIP … this check did NOT run`
 * and returns. Four green lines over four checks that looked at nothing — and
 * `bun test` exits 0, because a `console.warn` is not a failure.
 *
 * So three facts, each the single point of failure for a different part of it:
 *
 *   1. the devDependency, which is what puts the binary in `node_modules`;
 *   2. the binary resolving from THIS project's modules, which is what makes
 *      the run local — `npx fallow` with nothing installed is a registry fetch
 *      per invocation, and that is the slow non-deterministic path #581 named;
 *   3. the baseline file, parseable, at the name everything above reads.
 *
 * Deliberately NOT asserted here: that the checks pass. That is what
 * `FALLOW-1..4` are for, and asking it twice would make two guards out of one.
 * What is asserted is that they CAN run, which is the only thing their green
 * does not establish about itself.
 *
 * What was broken to make each go red is recorded case by case below, because
 * a check nobody has seen fail is a line in a report.
 */
describe("the four FALLOW checks cannot silently skip again (#261)", () => {
  /**
   * One binding for the declared version. Both the pin case and the binary
   * case compare against it, so there is one thing to delete and two cases
   * that notice.
   */
  function declaredFallowVersion(): string | undefined {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return pkg.devDependencies?.fallow ?? pkg.dependencies?.fallow;
  }

  test("fallow is declared in package.json, pinned to the version the bank was measured with", () => {
    // Read from disk rather than importing: a declaration is a fact about the
    // file an install reads, and this case is about that file.
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    // Named as a dev tool, not a runtime one: it is in neither `files[]` nor
    // any `src/` import, and a runtime entry would ship it to every consumer.
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("fallow");
    expect(typeof pkg.devDependencies?.fallow).toBe("string");

    // An exact pin, not a range. Every number in fallow-baseline.json was
    // produced by ONE version of the tool; a caret lets an install move the
    // tool under a ratchet whose counts nobody re-measured, and the suite
    // stays green while the population it counts changes underneath it.
    expect(declaredFallowVersion()).toMatch(/^\d+\.\d+\.\d+$/);

    // Vacuity guard. Without it, a `measuredWith` that stopped naming a
    // version would make the comparison below `undefined === undefined`,
    // which every tree in the world satisfies.
    const measured = /\b(\d+\.\d+\.\d+)\b/.exec(baseline.measuredWith ?? "");
    expect(measured).not.toBeNull();
    expect(declaredFallowVersion()).toBe(measured?.[1]);

    // Broken to prove it: deleting the `fallow` line from devDependencies is
    // red here (and in the next case); changing the pin to `^3.34.1` is red on
    // the exact-pin assertion; editing `measuredWith` to 3.33.0 is red on the
    // agreement.
  });

  test("the fallow binary resolves from this project's node_modules, not from a network fetch", () => {
    // The exact path the availability predicate stats. Asserting the predicate
    // alone would not say this: its second disjunct is `Bun.which`, so a tool
    // on $PATH — a global install on one laptop, absent in CI — satisfies it
    // with nothing in `node_modules` at all.
    const localBin = join(ROOT, "node_modules", ".bin", "fallow");
    expect(existsSync(localBin)).toBe(true);
    // …and it points INTO this project's modules. A `.bin` entry symlinked at
    // a global store resolves, runs, and is still not the declared install.
    const inProjectModules = realpathSync(localBin).startsWith(
      realpathSync(join(ROOT, "node_modules")) + sep,
    );
    expect(inProjectModules).toBe(true);

    // The reading. Spawned BY PATH rather than through `npx`, so there is no
    // resolution step that can reach a registry: if this prints a version, the
    // tool ran off this disk. `existsSync` passes over a dangling symlink and
    // over a stub that exits 1; neither gets past here.
    const probe = Bun.spawnSync([localBin, "--version"], {
      cwd: ROOT,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      timeout: 60_000,
    });
    const reading = `${probe.stdout.toString()}${probe.stderr.toString()}`.trim();
    const pinned = declaredFallowVersion();
    expect({
      exitCode: probe.exitCode,
      readingIsEmpty: reading.length === 0,
      namesThePinnedVersion: pinned !== undefined && reading.includes(pinned),
    }).toEqual({ exitCode: 0, readingIsEmpty: false, namesThePinnedVersion: true });

    // And the predicate the four checks actually consult agrees, so they run
    // instead of printing the skip notice. Imported from rungate rather than
    // re-implemented here: a second copy of that `||` would agree with the
    // first on every input and neither could be mutated out from under the
    // other.
    expect(fallowAvailable(ROOT)).toBe(true);

    // Broken to prove it: `rm node_modules/.bin/fallow` is red on the first
    // assertion and on `fallowAvailable`; replacing the symlink with a script
    // that exits 1 is red on the reading while `existsSync` stays green;
    // pointing it at a copy outside the project is red on `inProjectModules`.
  });

  test("the baseline file parses, at the exact name every reading above resolves", () => {
    // Scoped honestly: a file that is MISSING or wholly unparseable aborts
    // this module at import, loudly, before any case here runs — that is the
    // top-level `JSON.parse` near the head of the file, and it is a real
    // refusal, just not this one's. What this case holds is the population a
    // parse survives, which is the population nothing else looks at: a record
    // emptied to `{}`, a `counts` block gutted to a different shape, a number
    // turned into a string or a float, and a file re-created under a new name
    // beside a stale one.
    expect(existsSync(BASELINE_PATH)).toBe(true);
    expect(relative(ROOT, BASELINE_PATH).split("\\").join("/")).toBe("fallow-baseline.json");

    const raw = readFileSync(BASELINE_PATH, "utf-8");
    let parsed: Baseline;
    try {
      parsed = JSON.parse(raw) as Baseline;
    } catch (err) {
      throw new Error(
        `fallow-baseline.json does not parse — the ratchet has no record, and ` +
          `FALLOW-1..4 have nothing to be measured against: ${(err as Error).message}`,
      );
    }

    // The four classes `runFallowCheck` reports, each a whole count and not a
    // negative one. `typeof x === "number"` is satisfied by `NaN` and by
    // `-1`, and a ratchet cannot be lowered below the floor it describes.
    const classes = ["unusedFiles", "unusedExports", "unusedDependencies", "circularDependencies"];
    const whole = classes.filter(c => Number.isInteger(parsed.counts?.[c]) && parsed.counts[c] >= 0);
    expect(whole).toEqual(classes);

    // Not every count is non-zero — `unusedDependencies` is legitimately 0 —
    // but a record of all zeros banks nothing, and would agree with a tree
    // whose suppressions had every one been deleted.
    expect(classes.reduce((n, c) => n + parsed.counts[c], 0)).toBeGreaterThan(0);
    expect(parsed.issue).toBe(261);

    // Broken to prove it: truncating the file mid-object is red on the parse
    // refusal; `counts.unusedExports` set to "67" or to -1 is red on the
    // whole-count list; a record whose four counts are all 0 is red on the
    // sum, with every other assertion in this case still green.
  });
});
