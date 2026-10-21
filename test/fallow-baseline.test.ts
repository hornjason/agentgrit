/**
 * #261: the four FALLOW conformity checks used to print
 * "fallow is not installed … this check did NOT run" and pass. `fallow` is a
 * declared devDependency now, so they run — and they run GREEN only because
 * `.fallowrc.json` hides a banked set of findings that already existed.
 *
 * A hidden finding and an absent finding look identical to the conformity
 * run, which is the defect #261 is about wearing different clothes. This file
 * is what stops the bank becoming an exemption list:
 *
 *  - it runs fallow a second time with `ignoreFindings` REMOVED, so it sees
 *    the unsuppressed tree, and refuses in BOTH directions against the count
 *    banked in `fallow-baseline.json` — growth fails, and so does shrinkage
 *    that nobody banked;
 *  - it asserts every banked path still owns a finding, so a path that has
 *    been cleaned cannot sit in the config quietly hiding the next one;
 *  - it asserts the suppressed reading — the one the conformity checks see —
 *    is empty, so "FALLOW-1 passed" means the same thing this file measured.
 *
 * Refusals, never skips. An unresolvable binary, an unparseable reading or an
 * empty one ends this file loudly: `0`, `{}` and silence are indistinguishable
 * from success (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const BASELINE_PATH = join(ROOT, "fallow-baseline.json");
const RC_PATH = join(ROOT, ".fallowrc.json");

/**
 * The banked-count key beside the array `lib/conformity.ts`'s FALLOW check of
 * the same number reads. One row per check, so a class nobody banked is a
 * missing key rather than a silently absent comparison.
 */
const CLASSES = {
  unusedFiles: "unused_files",
  unusedExports: "unused_exports",
  unusedDependencies: "unused_dependencies",
  circularDependencies: "circular_dependencies",
} as const;

type ClassKey = keyof typeof CLASSES;
const CLASS_KEYS = Object.keys(CLASSES) as ClassKey[];

interface FallowReading {
  unused_files: Array<{ path: string }>;
  unused_exports: Array<{ path: string }>;
  unused_dependencies: Array<{ name: string }>;
  circular_dependencies: Array<{ files: string[] }>;
}

function runFallow(configPath?: string): FallowReading {
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
  let parsed: FallowReading & { error?: boolean; message?: string };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`fallow output did not parse as JSON: ${stdout.slice(0, 400)}`);
  }
  if (parsed.error) throw new Error(`fallow refused: ${parsed.message}`);
  for (const arrayKey of Object.values(CLASSES)) {
    if (!Array.isArray((parsed as unknown as Record<string, unknown>)[arrayKey])) {
      throw new Error(`fallow's JSON carries no '${arrayKey}' array — the conformity check reads it`);
    }
  }
  return parsed;
}

function ownersOf(reading: FallowReading): Set<string> {
  const owners = new Set<string>();
  for (const f of reading.unused_files) owners.add(f.path);
  for (const e of reading.unused_exports) owners.add(e.path);
  for (const c of reading.circular_dependencies) for (const f of c.files) owners.add(f);
  return owners;
}

function countsOf(reading: FallowReading): Record<ClassKey, number> {
  return Object.fromEntries(
    CLASS_KEYS.map((k) => [k, (reading as unknown as Record<string, unknown[]>)[CLASSES[k]].length]),
  ) as Record<ClassKey, number>;
}

describe("fallow dead-code baseline (#261)", () => {
  let scratch: string;
  let suppressed: FallowReading;
  let unsuppressed: FallowReading;
  let banked: {
    _comment?: unknown;
    bankedAt?: unknown;
    issue?: unknown;
    counts?: Record<string, unknown>;
  };
  let ignoreFindings: string[];

  beforeAll(() => {
    if (!existsSync(BASELINE_PATH)) {
      throw new Error(`${BASELINE_PATH} is missing — the banked counts are what this file ratchets against`);
    }
    banked = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));

    if (!existsSync(RC_PATH)) throw new Error(`${RC_PATH} is missing — it declares the banked paths`);
    const rc = JSON.parse(readFileSync(RC_PATH, "utf-8"));
    if (!Array.isArray(rc.ignoreFindings)) {
      throw new Error(".fallowrc.json declares no ignoreFindings array — nothing is banked, so nothing is measured");
    }
    ignoreFindings = rc.ignoreFindings;

    // The unsuppressed config is DERIVED from the live one rather than written
    // out a second time: two entry-point lists would drift, and the reading
    // taken against the stale one would be a measurement of nothing.
    scratch = mkdtempSync(join(tmpdir(), "agentgrit-fallow-"));
    const full = { ...rc };
    delete full.ignoreFindings;
    delete full.$schema;
    const fullPath = join(scratch, "fallow-unsuppressed.json");
    writeFileSync(fullPath, JSON.stringify(full));

    suppressed = runFallow();
    unsuppressed = runFallow(fullPath);
  });

  afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  // AC-1: fallow is declared and locally resolvable, so no check can skip.
  test("AC-1: fallow is a declared devDependency and resolves to a local binary", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
    expect(pkg.devDependencies?.fallow).toBeDefined();
    expect(existsSync(join(ROOT, "node_modules", ".bin", "fallow"))).toBe(true);
  });

  // AC-3: the four arrays the conformity checks read are all present.
  test("AC-3: the reading carries all four dead-code arrays", () => {
    for (const arrayKey of Object.values(CLASSES)) {
      expect(Array.isArray((unsuppressed as unknown as Record<string, unknown>)[arrayKey])).toBe(true);
    }
  });

  // AC-4: the bank is interpretable — a number nobody can read is a number
  // nobody lowers.
  test("AC-4: the baseline banks a numeric count for each of the four classes", () => {
    expect(typeof banked._comment).toBe("string");
    expect(typeof banked.bankedAt).toBe("string");
    expect(banked.issue).toBe(261);
    for (const k of CLASS_KEYS) expect(typeof banked.counts?.[k]).toBe("number");
  });

  // The instrument control. Every assertion below compares against the banked
  // numbers, and a bank of all-zeros would make them agree with a fallow run
  // that read nothing at all.
  test("the unsuppressed run found something — a bank of zeros measures nothing", () => {
    const total = CLASS_KEYS.reduce((n, k) => n + (banked.counts?.[k] as number), 0);
    expect(total).toBeGreaterThan(0);
    expect(ownersOf(unsuppressed).size).toBeGreaterThan(0);
  });

  // The ratchet, refusing in both directions.
  test("the unsuppressed counts equal the banked counts, exactly", () => {
    expect(countsOf(unsuppressed)).toEqual(
      Object.fromEntries(CLASS_KEYS.map((k) => [k, banked.counts?.[k]])) as Record<ClassKey, number>,
    );
  });

  // A banked path that owns nothing is an exemption, not a bank.
  test("every banked path still owns at least one finding", () => {
    const owners = ownersOf(unsuppressed);
    const stale = ignoreFindings.filter((p) => !owners.has(p));
    expect(stale).toEqual([]);
  });

  // What the conformity FALLOW checks see. If this disagrees with the bank,
  // "FALLOW-1 passed" stops meaning what this file measured.
  test("the suppressed reading — what the conformity checks read — is empty", () => {
    expect(countsOf(suppressed)).toEqual({
      unusedFiles: 0,
      unusedExports: 0,
      unusedDependencies: 0,
      circularDependencies: 0,
    });
  });
});
