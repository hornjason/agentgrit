import { mock } from "bun:test";

/**
 * A `mock.module` that can be undone, and that does not drop the exports it
 * wasn't asked to replace.
 *
 * Two properties of bun's `mock.module` make the raw call unsafe in a suite that
 * runs many files in one process, and both of them produced real failures here
 * (issue #249):
 *
 * 1. **It is process-global and permanent.** `mock.restore()` does NOT undo it —
 *    verified on bun 1.3.14. So a file that mocks `src/adapters/inference` leaves
 *    every later file in the run holding the mock. `test/adapters/inference-bare`
 *    asserts the real module's defaults, so it passed or failed purely on whether
 *    it ran before or after `test/graph/auto-domains`. Bun walks the test files in
 *    directory order, which APFS and ext4 disagree about: test/adapters first on
 *    the developer's Mac (real module, green), test/graph first on the Linux CI
 *    runner (leaked mock returning level "fast", red). That single leak is the
 *    whole of CI's "inference level defaults to standard" failure.
 *
 * 2. **It replaces the module wholesale.** `mock.module(spec, () => ({ a }))` on a
 *    module exporting seventeen things leaves sixteen of them `undefined` for the
 *    rest of the run. `test/graph/classify-isolated` did exactly that to
 *    `src/graph/builder`, so any later file importing `readGraph` from it got
 *    `undefined` — a landmine that had not gone off yet only because of ordering.
 *
 * Spreading a snapshot of the real namespace fixes (2); returning a restore
 * function to call from `afterAll` fixes (1).
 *
 * @param specifier  Module path, exactly as the code under test imports it.
 * @param realSnapshot A plain-object copy of the real namespace, taken at import
 *   time — `const REAL = { ...realNamespace }` at the top of the test file, before
 *   any mocking. A copy, not the namespace itself: the namespace object has live
 *   bindings that `mock.module` overwrites in place.
 * @param overrides The exports to replace.
 * @returns A restore function. Call it from `afterAll`.
 */
export function mockModuleScoped<T extends Record<string, unknown>>(
  specifier: string,
  realSnapshot: T,
  overrides: Partial<Record<keyof T, unknown>> & Record<string, unknown>,
): () => void {
  mock.module(specifier, () => ({ ...realSnapshot, ...overrides }));
  return () => {
    mock.module(specifier, () => ({ ...realSnapshot }));
  };
}
