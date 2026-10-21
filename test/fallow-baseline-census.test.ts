/**
 * AC-7 (#312): the #261 reconciliation file still declares at least fifteen
 * top-level cases, so none was skipped or deleted to make #311 green.
 *
 * #311 is a timeout: `test/fallow-baseline.test.ts` spends five seconds in a
 * cold `fallow` invocation and gets killed at the budget. Raising the budget
 * fixes it. So does deleting the cases that spend the time — and the two are
 * indistinguishable from the outside, because both produce a green run of a
 * file that is still there and still named after #261. Thinning the file is
 * the cheapest wrong fix available, and it is cheapest precisely while
 * someone is under pressure to turn a red check green.
 *
 * This census is deliberately NOT inside the file it counts. A guard that
 * lives in `fallow-baseline.test.ts` goes away with it: delete the file and
 * the count disappears silently, which is the failure this exists to catch.
 * From here, deleting the file is a red `existsSync`.
 *
 * What it holds, and why the weaker form does not:
 *
 * - A count, not a list of names. Names would have to be edited every time a
 *   case is reworded, and a guard people routinely edit is a guard people
 *   routinely edit downward.
 * - Skipped and todo cases do not count. `test.skip` leaves the line in the
 *   file and the case out of the run, so a text count that accepted it would
 *   be satisfied by exactly the state the criterion forbids.
 * - The three describes are named. A file can keep fifteen cases while losing
 *   a whole question — the reconciliation block is the one #311 times out in,
 *   and it is the one with the most to gain from being quietly dropped.
 *
 * This is a ratchet. Fifteen is the count on `main` at the time #312 was
 * written; it is a floor, not a target. Raise it when the file grows, and
 * treat a request to lower it as a change that needs its own reasoning.
 */

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const RECONCILIATION_FILE = join(import.meta.dir, "fallow-baseline.test.ts");

/**
 * The floor, measured on `main` at 5d3a414. Seven cases in the ratchet block,
 * five in the reconciliation block, three in the wiring block.
 */
const MINIMUM_CASES = 15;

/** `test(` / `it(` at the start of a line, with no modifier attached. */
const LIVE_CASE_RE = /^[ \t]*(?:test|it)\s*\(/gm;

/** Anything that leaves the line in the file and the case out of the run. */
const INERT_CASE_RE = /^[ \t]*(?:test|it)\s*\.\s*(?:skip|todo|failing|skipIf)\b/gm;

/** `describe(` at column zero — the file's top-level questions. */
const TOP_LEVEL_DESCRIBE_RE = /^describe\s*\(\s*["'`]([^"'`]+)["'`]/gm;

function source(): string {
  return readFileSync(RECONCILIATION_FILE, "utf-8");
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

describe("the #261 reconciliation file was not thinned to make #311 green (#312 AC-7)", () => {
  test("the file is still there", () => {
    // The census below reads this path. If the file is gone, every count is
    // zero and a tolerant reader would call that clean.
    expect(existsSync(RECONCILIATION_FILE)).toBe(true);
  });

  test(`it declares at least ${MINIMUM_CASES} live top-level cases`, () => {
    const live = countMatches(source(), LIVE_CASE_RE);
    expect(live).toBeGreaterThanOrEqual(MINIMUM_CASES);
  });

  test("no case is skipped, todo, failing or conditional", () => {
    const inert = [...source().matchAll(INERT_CASE_RE)].map((m) => m[0].trim());
    expect(inert).toEqual([]);
  });

  test("all three top-level questions are still asked", () => {
    const titles = [...source().matchAll(TOP_LEVEL_DESCRIBE_RE)].map((m) => m[1]!);

    expect(titles).toHaveLength(3);
    expect(titles.some((t) => t.includes("ratchet"))).toBe(true);
    expect(titles.some((t) => t.includes("reconciles with the unsuppressed tree"))).toBe(true);
    expect(titles.some((t) => t.includes("wired rather than skipped"))).toBe(true);
  });

  test("the counter distinguishes a live case from an inert one", () => {
    // Without this, a counting bug that matched everything or nothing would
    // produce the same green as a healthy file.
    const sample = [
      "  test(\"live one\", () => {});",
      "  it(\"live two\", () => {});",
      "  test.skip(\"inert\", () => {});",
      "  it.todo(\"also inert\");",
      "    test . failing (\"spaced inert\", () => {});",
      "  // test(\"commented out\", () => {});",
    ].join("\n");

    expect(countMatches(sample, LIVE_CASE_RE)).toBe(2);
    expect(countMatches(sample, INERT_CASE_RE)).toBe(3);
  });
});
