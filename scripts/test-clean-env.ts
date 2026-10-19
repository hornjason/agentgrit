#!/usr/bin/env bun
/**
 * Run the test suite the way CI runs it: no developer machine behind it, and the
 * files in an order both platforms agree on.
 *
 * Issue #249. CI was red on `main` from 2026-10-14 reporting 10 failures while
 * `bun test` on the same SHA reported 8 locally, and the two SETS DIFFERED. Three
 * distinct couplings produced that, and only the first is the one people expect:
 *
 *  1. **The developer's $HOME.** `test/commands/context.test.ts` read
 *     `~/.claude/MEMORY/STATE/GRAPH-CONTEXT.md` — a path the command under test
 *     has not written to since `graphContextFile()` was introduced — so it was
 *     asserting against whatever the live install had last left there. Present and
 *     populated here, absent on a runner.
 *  2. **The developer's git working tree.** `detectDomainsFromGitStatus` shells out
 *     to `git status --short` in the process's cwd. The test's fixture dir lived
 *     inside the repo, so the fallback domains were a function of which files
 *     happened to be dirty. A clean CI checkout produces none of them.
 *  3. **Directory iteration order.** `mock.module()` is process-global and bun's
 *     `mock.restore()` does not undo it. `test/graph/auto-domains.test.ts` left
 *     `src/adapters/inference` mocked for the rest of the run, so whether
 *     `test/adapters/inference-bare.test.ts` saw the real module came down to
 *     which file bun walked first — and APFS and ext4 disagree.
 *
 * Stripping HOME finds (1) and (2). Nothing about the environment finds (3): the
 * only way to see it is to fix the order, which is why this script enumerates the
 * test files, sorts them, and passes them to bun explicitly rather than letting
 * `bun test` discover them. An explicit list is honoured in the order given.
 *
 * ## What this does NOT model
 *
 * Printed on every run, because an unqualified claim about CI is how (1) and (2)
 * survived code review:
 *
 *   - the runner OS (Linux vs darwin) and its filesystem semantics
 *   - a fresh `bun install` from the lockfile
 *   - the bun version CI's `bun-version: latest` resolves to
 *   - `actions/checkout@v4`'s shallow, detached checkout — this runs in your tree
 *   - network and API availability
 *   - files git ignores but that are present here
 *
 * Usage:
 *   bun scripts/test-clean-env.ts                      # whole suite, sorted, hermetic
 *   bun scripts/test-clean-env.ts test/commands         # a subtree
 *   bun scripts/test-clean-env.ts test/cli/doctor.test.ts
 *   bun scripts/test-clean-env.ts --keep-home           # order fixed, $HOME left alone
 */

import { spawnSync } from "child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, relative, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");

const argv = process.argv.slice(2);
const keepHome = argv.includes("--keep-home");
const targets = argv.filter((a) => !a.startsWith("--"));

/** Every *.test.ts under `dir`, sorted, so the order is a property of the names. */
function collectTests(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectTests(full, out);
    else if (entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function resolveTargets(): string[] {
  if (targets.length === 0) return collectTests(join(ROOT, "test"));

  const files: string[] = [];
  for (const t of targets) {
    const full = resolve(ROOT, t);
    if (statSync(full).isDirectory()) files.push(...collectTests(full));
    else files.push(full);
  }
  // Sort across all targets, not within each, so two invocations naming the same
  // set in a different order still produce the same run.
  return [...new Set(files)].sort();
}

/**
 * Everything that leaks this machine into a test.
 *
 * XDG_CONFIG_HOME and GIT_CONFIG_GLOBAL sit beside HOME because git and gh read
 * config from them directly — moving HOME alone leaves a configured machine
 * visible through the side door. The GIT_AUTHOR_* / GIT_COMMITTER_* / EMAIL group
 * overrides every config file, so a developer who exports any of them would still
 * get a working git identity, in exactly the class this script hunts.
 *
 * Deliberately NOT setting a "this run is hermetic" marker: the only use a test
 * could make of one is skipping itself, which is the defect this exists to expose.
 */
function hermeticEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR", "GH_HOST",
    "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
    "EMAIL", "GIT_CONFIG_SYSTEM",
    // AgentGrit's own path authority. Left set, the suite inherits this session's
    // install and the preload in test/setup/isolate.ts never builds its sandbox.
    "AGENTGRIT_DIR", "AGENTGRIT_HOST_DIR", "AGENTGRIT_TEST_BASE",
    // Provider keys turn the inference adapter's failure paths into live API calls.
    "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "AGENTGRIT_PROVIDER",
  ]) {
    delete env[key];
  }
  env.HOME = home;
  env.XDG_CONFIG_HOME = join(home, ".config");
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  return env;
}

const UNMODELLED = [
  "the runner OS and its directory-iteration order",
  "a fresh `bun install` from the lockfile",
  "the bun version CI resolves from `bun-version: latest`",
  "actions/checkout@v4's shallow detached checkout",
  "network and API availability",
  "files git ignores but that exist here",
];

const files = resolveTargets();
if (files.length === 0) {
  console.error("[clean-env] no test files matched — refusing to report a green run over nothing");
  process.exit(2);
}

const home = mkdtempSync(join(tmpdir(), "agentgrit-clean-home-"));

try {
  console.error(`[clean-env] bun ${Bun.version} on ${process.platform}`);
  console.error(`[clean-env] ${files.length} test files, sorted by path`);
  console.error(
    keepHome
      ? `[clean-env] --keep-home: HOME is NOT stripped, so host-state coupling is NOT modelled`
      : `[clean-env] HOME=${home}  gh credentials stripped  git identity unset  AGENTGRIT_* unset`,
  );
  for (const u of UNMODELLED) console.error(`[clean-env] NOT modelled: ${u}`);

  const result = spawnSync("bun", ["test", ...files.map((f) => relative(ROOT, f))], {
    cwd: ROOT,
    env: keepHome ? process.env : hermeticEnv(home),
    stdio: "inherit",
  });

  // spawnSync reports a launch failure through .error and a signal through
  // .signal with a null status. Exiting 0 on either would report a clean suite
  // for a run that never produced a result.
  if (result.error) {
    console.error(`[clean-env] could not run the suite: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status === null) {
    console.error(`[clean-env] suite terminated by signal ${result.signal}`);
    process.exit(1);
  }
  process.exitCode = result.status;
} finally {
  rmSync(home, { recursive: true, force: true });
}
