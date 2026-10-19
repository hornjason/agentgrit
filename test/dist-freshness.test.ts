/**
 * #264: dist/ is never rebuilt, so every hook runs the bundle from whenever
 * someone last ran `bun run build` by hand.
 *
 * This matters more here than it would in most projects, because the global
 * install is a symlink INTO this repo:
 *
 *   /opt/homebrew/bin/agentgrit
 *     -> ../lib/node_modules/@agentgrit/core/dist/agentgrit.js
 *     -> <repo>/dist/agentgrit.js
 *
 * So every `agentgrit capture …` hook in ~/.claude/settings.json executes this
 * repo's dist/, and source and behaviour are free to diverge indefinitely. On
 * 2026-10-19 the bundle was from 2026-10-05: every fix merged in between
 * (#254..#259) was in src/ and in none of the behaviour the user experienced.
 *
 * WHY MTIME, WHEN MTIME IS NORMALLY THE WRONG INSTRUMENT. git does not preserve
 * mtimes, so on a fresh clone every file carries checkout time and an
 * "is dist older than src" comparison answers a question about the clone. That
 * objection does not apply here, and the reason is the one fact that makes this
 * check sound: **dist/ is gitignored.** It is never cloned, never restored from
 * an archive, and only ever exists on a machine that built it. Where the check
 * runs at all, the mtimes are real ones written by the build.
 *
 * The alternative — byte-comparing against a fresh build — was tried first and
 * is NOT sound here. `bun build` inlines `process.env.NODE_ENV` at build time,
 * so the bundle's bytes depend on the environment of whoever ran the build:
 *
 *   NODE_ENV unset -> 388511 bytes
 *   NODE_ENV=test  -> 388548 bytes
 *
 * Measured, not assumed. A byte check would therefore report "stale" for a
 * bundle that is perfectly current and was merely built from a different shell,
 * which is a check that fails for a reason unrelated to what it claims to
 * measure. That 37-byte difference is a real defect in its own right and is
 * filed separately; `bundleWasNotBuiltInTestMode` below is the part of it this
 * file can hold.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const repoRoot = join(import.meta.dir, "..");
const distPath = join(repoRoot, "dist", "agentgrit.js");

/** Every source file the bundle is built from, with its mtime. */
function sourceFiles(): { path: string; mtimeMs: number }[] {
  const out: { path: string; mtimeMs: number }[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx|js|mjs|json)$/.test(entry.name)) {
        out.push({ path: full, mtimeMs: statSync(full).mtimeMs });
      }
    }
  };
  walk(join(repoRoot, "src"));
  walk(join(repoRoot, "bin"));
  return out;
}

/**
 * The one place the staleness question is answered, so there is a single
 * binding to mutate. Returns the source files newer than the bundle, newest
 * first — empty means current.
 */
export function sourcesNewerThanBundle(): { path: string; mtimeMs: number }[] {
  const bundleMs = statSync(distPath).mtimeMs;
  return sourceFiles()
    .filter(f => f.mtimeMs > bundleMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// dist/ is gitignored, so a clean checkout and CI legitimately have no bundle.
// A missing bundle is not a fresh bundle and must not read as a pass: nothing
// was measured. `0`, `{}` and silence are all indistinguishable from success;
// saying UNMEASURED out loud is not.
const distPresent = existsSync(distPath);

if (!distPresent) {
  console.warn(
    `UNMEASURED: dist freshness not checked. ${distPath} does not exist, so ` +
      `there is no bundle whose age could be compared to src/. This is not a ` +
      `pass — it means this tree has never run 'bun run build'.`,
  );
}

describe("dist bundle freshness (#264)", () => {
  test("the walk can see the sources it is meant to compare against", () => {
    // Without this, an empty walk would make the staleness check below pass
    // unconditionally — zero files newer than the bundle is exactly what a
    // current bundle looks like, and exactly what a broken walk looks like.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(50);
    expect(files.some(f => f.path.endsWith(join("bin", "agentgrit.ts")))).toBe(true);
  });

  test.skipIf(!distPresent)("dist/agentgrit.js is not older than src/ or bin/", () => {
    const stale = sourcesNewerThanBundle();
    if (stale.length > 0) {
      const bundleAge = new Date(statSync(distPath).mtime).toISOString();
      const worst = stale.slice(0, 5).map(f => `    ${f.path.slice(repoRoot.length + 1)}`);
      throw new Error(
        `dist/agentgrit.js (built ${bundleAge}) is older than ${stale.length} source file(s).\n` +
          `${worst.join("\n")}${stale.length > 5 ? `\n    …and ${stale.length - 5} more` : ""}\n` +
          `The globally linked 'agentgrit' binary runs this bundle, so every hook is ` +
          `executing stale code. Run 'bun run build'.`,
      );
    }
    expect(stale).toHaveLength(0);
  });

  test.skipIf(!distPresent)("the bundle was not built with NODE_ENV=test", () => {
    // `bun build` resolves process.env.NODE_ENV at build time. src/graph/context.ts
    // has `if (process.env.NODE_ENV === "test" && !process.env.AGENTGRIT_DIR) return;`
    // — build that with NODE_ENV=test and the early return is compiled into the
    // shipped bundle, so `agentgrit graph context` silently does nothing for any
    // user who has not set AGENTGRIT_DIR. Built with NODE_ENV unset the whole
    // branch is eliminated instead, which is the correct shipped behaviour.
    // Asserted as a boolean rather than `expect(bundle).not.toContain(...)`:
    // the bundle is ~390KB and a failed toContain prints the whole received
    // string, which buries the finding in the output it is reported in.
    const bundle = readFileSync(distPath, "utf-8");
    const builtInTestMode = bundle.includes("AGENTGRIT_DIR)return");
    if (builtInTestMode) {
      throw new Error(
        `dist/agentgrit.js was built with NODE_ENV=test: it carries the test-only ` +
          `early return from src/graph/context.ts. In that bundle ` +
          `'agentgrit graph context' silently does nothing for any user who has not ` +
          `set AGENTGRIT_DIR. Rebuild with NODE_ENV unset: 'env -u NODE_ENV bun run build'.`,
      );
    }
    expect(builtInTestMode).toBe(false);
  });
});
