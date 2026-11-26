/** #327 — the comparison's metrics decide which model grades nightly, so they are tested like code. */
import { describe, expect, test } from "bun:test";
import type { RubricConfig, Score } from "../../src/adapters/types";
import { auc, bootstrapAuc, stratifiedSample, weightedScore, type Item } from "../../scripts/compare-judges";

describe("auc", () => {
  test("perfect separation is 1, perfect inversion is 0, all ties are 0.5", () => {
    expect(auc([5, 4, 1, 2], [true, true, false, false])).toBe(1);
    expect(auc([1, 2, 5, 4], [true, true, false, false])).toBe(0);
    expect(auc([3, 3, 3, 3], [true, true, false, false])).toBe(0.5);
  });
  test("a known mixed case: 3 of 4 pairs ordered, no ties", () => {
    // positives 4, 2; negatives 3, 1 → (4>3, 4>1, 2>1) win, (2<3) lose
    expect(auc([4, 2, 3, 1], [true, true, false, false])).toBe(0.75);
  });
  test("an empty class is NaN, not a number that looks like a result", () => {
    expect(Number.isNaN(auc([1, 2], [true, true]))).toBe(true);
  });
});

describe("bootstrapAuc", () => {
  test("is reproducible for a seed and brackets the point estimate", () => {
    const s = [5, 4, 4, 3, 2, 3, 1, 2]; const l = [true, true, true, true, false, false, false, false];
    const a = bootstrapAuc(s, l, 500, 7); const b = bootstrapAuc(s, l, 500, 7);
    expect(a).toEqual(b);
    expect(a[0]).toBeLessThanOrEqual(auc(s, l)); expect(a[1]).toBeGreaterThanOrEqual(auc(s, l));
  });
});

describe("weightedScore", () => {
  const rubric = { dimensions: [{ name: "a", weight: 0.75 }, { name: "b", weight: 0.25 }] } as unknown as RubricConfig;
  const sc = (dimension: string, value: number) => ({ dimension, value } as Score);
  test("weights the dimensions", () => { expect(weightedScore([sc("a", 4), sc("b", 2)], rubric)).toBe(3.5); });
  test("renormalises over the dimensions present", () => { expect(weightedScore([sc("b", 2)], rubric)).toBe(2); });
  test("nothing returned is null, not zero", () => { expect(weightedScore([], rubric)).toBeNull(); });
});

describe("stratifiedSample", () => {
  const items: Item[] = Array.from({ length: 40 }, (_, i) => ({ id: `i${i}`, up: i % 4 !== 0, input: "", output: "" }));
  test("keeps the up/down ratio and is reproducible for a seed", () => {
    const a = stratifiedSample(items, 20, 3); const b = stratifiedSample(items, 20, 3);
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
    expect(a).toHaveLength(20);
    expect(a.filter((x) => !x.up)).toHaveLength(5);
  });
  test("a different seed draws a different sample", () => {
    expect(stratifiedSample(items, 20, 3).map((x) => x.id)).not.toEqual(stratifiedSample(items, 20, 4).map((x) => x.id));
  });
});
