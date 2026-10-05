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
