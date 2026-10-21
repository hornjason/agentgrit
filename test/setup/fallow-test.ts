/**
 * The second clock (#311).
 *
 * A generous spawn timeout does nothing about the one that actually fired.
 * bun kills a `test` or `beforeAll` body at 5000ms unless the registration is
 * handed a timeout, and on PR #310 that is what killed `FALLOW-1` at 5010ms
 * and `test/fallow-baseline.test.ts`'s `beforeAll` at 5105ms — both of them
 * holding a spawn budget of 180_000ms they never got near.
 *
 * So every case and hook that can reach fallow registers through here, and the
 * budget comes from the same constant the spawn timeout does. Two clocks, one
 * number. `test/fallow-timeout.test.ts` holds the population: in any repo file
 * that spawns fallow, a bare `test(` or `beforeAll(` is a violation, with no
 * exemption list — because the exemption is exactly the state #311 found.
 *
 * This module imports `bun:test` and therefore cannot be imported from the
 * preload; `test/setup/fallow-run.ts` is the half that can, and holds the
 * number.
 */
import { beforeAll, test } from "bun:test";
import { FALLOW_BUDGET_MS } from "./fallow-run";

type Body = () => void | Promise<unknown>;

export function fallowTest(name: string, body: Body): void {
  test(name, body, FALLOW_BUDGET_MS);
}

export function fallowBeforeAll(body: Body): void {
  beforeAll(body, FALLOW_BUDGET_MS);
}
