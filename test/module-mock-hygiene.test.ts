import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

/**
 * A raw module mock in a test file is a process-wide, permanent edit to the
 * module registry. Issue #249: `test/graph/auto-domains.test.ts` replaced
 * `src/adapters/inference` and never put it back, so every file bun loaded after
 * it saw the mock — including `test/adapters/inference-bare.test.ts`, whose whole
 * job is to assert the real module's defaults. Which of the two ran first is
 * decided by directory iteration order, and APFS and ext4 disagree, so the suite
 * was green on the developer's Mac and red on the Linux CI runner from the same
 * commit. `mock.restore()` does not undo it (verified, bun 1.3.14).
 *
 * `mockModuleScoped` (test/setup/module-mock.ts) returns a restore function and
 * preserves the exports it wasn't asked to replace. This holds the raw-call count
 * at zero so the next one is caught at review rather than six weeks later in CI.
 */

const TEST_ROOT = import.meta.dir;
const HELPER_REL = join("setup", "module-mock.ts");

const RAW_MOCK = /(?<![\w.])mock\.module\s*\(/;

/** Prose mentioning the call is not a call. Both this file and the helper do it. */
function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

export function rawMockModuleCalls(source: string): number[] {
  return source
    .split("\n")
    .map((line, i) => (!isCommentLine(line) && RAW_MOCK.test(line) ? i + 1 : 0))
    .filter((n) => n > 0);
}

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) testFiles(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("module mock hygiene", () => {
  test("no test file outside the helper calls mock.module directly", () => {
    const offenders: string[] = [];

    for (const file of testFiles(TEST_ROOT)) {
      const rel = file.slice(TEST_ROOT.length + 1);
      if (rel === HELPER_REL) continue; // the one place allowed to make the call
      for (const line of rawMockModuleCalls(readFileSync(file, "utf-8"))) {
        offenders.push(`${rel}:${line}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("the detector sees a real call and ignores prose about one", () => {
    // Assembled rather than written literally: a fixture spelling the call out
    // would make this file its own first offender. Synthetic rather than read off
    // the helper, because a detector checked against the file it is about goes
    // green the day both stop containing the thing.
    const CALL = `mock` + `.module("x", () => ({}));`;

    expect(rawMockModuleCalls(CALL)).toEqual([1]);
    expect(rawMockModuleCalls(`  ${CALL}`)).toEqual([1]);
    expect(rawMockModuleCalls(`// ${CALL}`)).toEqual([]);
    expect(rawMockModuleCalls(` * ${CALL}`)).toEqual([]);
    // A property access of the same name is not the global call.
    expect(rawMockModuleCalls(`thing.mock.module("x", () => ({}));`)).toEqual([]);
    // mockModuleScoped's own two internal calls must still register, or exempting
    // the helper by path would be exempting nothing.
    expect(rawMockModuleCalls(readFileSync(join(TEST_ROOT, HELPER_REL), "utf-8")).length).toBe(2);
  });

  test("the walker reaches every directory under test/", () => {
    // A walker that silently stopped recursing would also report zero offenders.
    const files = testFiles(TEST_ROOT);
    expect(files.length).toBeGreaterThan(100);
    for (const dir of ["/graph/", "/adapters/", "/setup/", "/daemon/", "/commands/"]) {
      expect(files.some((f) => f.includes(dir))).toBe(true);
    }
  });
});
