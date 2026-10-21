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
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";

const ROOT = join(import.meta.dir, "..");
const BASELINE_PATH = join(ROOT, "fallow-baseline.json");
const CONFIG_PATH = join(ROOT, ".fallowrc.json");

/** The exact marker fallow honours. A near-miss suppresses nothing. */
const CYCLE_MARKER = "// fallow-ignore-next-line circular-dependency";

interface Baseline {
  issue: number;
  bankedAt: string;
  _comment: string;
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
