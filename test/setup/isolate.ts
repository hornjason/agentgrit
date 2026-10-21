/**
 * Test isolation — preloaded before every test file (see bunfig.toml).
 *
 * The path authority resolves both AgentGrit's own state and the host's files
 * from AGENTGRIT_DIR / AGENTGRIT_HOST_DIR, falling back to the live install.
 * Unset, the suite resolves to the real install and writes to it: syncRuleDomains
 * prunes any entry absent from the graph it is handed, so a fixture graph run
 * against the live rule-domains.json empties it. That happened on 2026-10-05.
 *
 * Pinning both to a per-run temp dir makes the whole suite inert with respect to
 * the user's data. An explicitly-set value is honoured, so CI or a debugging run
 * can still point somewhere specific.
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { warmFallow } from "./fallow-run";

if (!process.env.AGENTGRIT_DIR) {
  const base = mkdtempSync(join(tmpdir(), "agentgrit-test-"));
  process.env.AGENTGRIT_DIR = base;
  process.env.AGENTGRIT_HOST_DIR ??= join(base, "host");

  // Published separately because many suites point AGENTGRIT_DIR at their own
  // fixture dir and clear it afterwards. Clearing it outright would hand every
  // later file in the process the live install, so they restore this instead.
  process.env.AGENTGRIT_TEST_BASE = base;

  // Don't become the stranded-fixture problem this suite just fixed (ISC-12/13).
  process.on("exit", () => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
      // Best effort — a leftover temp dir is not worth failing a run over.
    }
  });
}

/**
 * Pay fallow's cold start here, once per process, before any test body (#311).
 *
 * Deliberately OUTSIDE the guard above: that guard is about whether this
 * process owns the temp dir, and the cold start is paid per process either
 * way. `warmFallow` memoises, so the preload running again for a second test
 * file in the same process costs nothing.
 *
 * This is the only hook into the process that runs the GENERATED
 * `test/scaffold-conformity.test.ts`, which this repo does not own and cannot
 * edit. Without it, `FALLOW-1` is the first fallow invocation in the process,
 * pays ~1s of index building that FALLOW-2/3/4 never see, and is killed by
 * bun's 5000ms default on a slow runner — which is PR #310's red on a commit
 * that changed two markdown files.
 *
 * Failure is swallowed and recorded, never thrown: a warm-up that can kill a
 * run is a new way for an unrelated commit to go red, which is the thing being
 * removed. An absent record is refused loudly in `test/fallow-timeout.test.ts`,
 * where it is a judgement rather than a side effect.
 */
try {
  warmFallow(join(import.meta.dir, "..", ".."));
} catch {
  // Recorded by its absence. See test/fallow-timeout.test.ts AC-1.
}
