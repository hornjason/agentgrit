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
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
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
