/**
 * doc-check — advisory doc-staleness report for pull requests (#171).
 *
 * Three checks, all non-blocking. The workflow posts the report as a PR comment
 * and always writes it to the job summary; it never fails the build.
 *
 *   1. cascade     — src/ changed, the doc sections describing it did not
 *   2. version     — package.json version changed, CHANGELOG.md did not
 *   3. test counts — "N tests pass" claims in docs/SYSTEM-SPEC.md vs live `bun test`
 *
 * Deliberately NOT here: node-count and precision@5 drift. Both live in
 * ~/.agentgrit/ (README.md "All state lives under ~/.agentgrit/"), which is
 * gitignored and does not exist on a pull_request runner, and P@5 additionally
 * needs a built graph and an eval run. A check with nothing to read would pass
 * unconditionally; see .claude/rules/checks-must-be-able-to-fail.md.
 *
 * Every exported function is pure so test/scripts/doc-check.test.ts can drive
 * it without git, CI or a network. The IO lives in main() at the bottom.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface CascadeTarget {
  doc: string;
  section: string;
}

export interface CascadeEntry {
  targets: CascadeTarget[];
  /** Required when `targets` is empty: why no doc section covers this directory. */
  undocumented?: string;
}

export interface CascadeMap {
  version: number;
  cascade: Record<string, CascadeEntry>;
  testCounts: Record<string, string>;
  testCountDoc: string;
}

export interface Finding {
  check: "cascade" | "version" | "test-counts";
  message: string;
}

/** A measured value, or an explicit "the instrument did not report". */
export type Measurement = { kind: "count"; value: number } | { kind: "unmeasured"; why: string };

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Every ATX heading in a markdown document, as its raw text with the #s stripped. */
export function headings(markdown: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (m) out.push(m[2]);
  }
  return out;
}

/**
 * Headings whose text contains `section`. A cascade target is valid when
 * exactly one heading matches: zero means the section was renamed or never
 * existed, more than one means the reference is ambiguous and a reader cannot
 * tell which section to update.
 */
export function matchingHeadings(markdown: string, section: string): string[] {
  return headings(markdown).filter((h) => h.includes(section));
}

/**
 * Parse `| Area | Status | ... N tests pass ... |` rows out of a markdown
 * table. Returns area → claimed count.
 */
export function parseTestCountClaims(markdown: string): Record<string, number> {
  const claims: Record<string, number> = {};
  for (const line of markdown.split("\n")) {
    const m = /^\|\s*([^|]+?)\s*\|[^|]*\|\s*(\d+)\s+tests?\s+pass\b/.exec(line);
    if (m) claims[m[1]] = Number(m[2]);
  }
  return claims;
}

/**
 * Pull the pass count out of `bun test` output. bun prints the summary on
 * stderr, so callers should hand in stdout and stderr concatenated. Returns an
 * explicit `unmeasured` rather than 0 when the summary line is absent — a run
 * that crashed before printing must not read as "zero tests, no drift".
 */
export function parseBunPassCount(output: string): Measurement {
  const m = /^\s*(\d+)\s+pass\s*$/m.exec(output);
  if (!m) {
    return { kind: "unmeasured", why: "no `N pass` summary line in the bun test output" };
  }
  return { kind: "count", value: Number(m[1]) };
}

/** The version field of a package.json blob, or null if it cannot be read. */
export function versionOf(packageJsonText: string): string | null {
  try {
    const v = JSON.parse(packageJsonText)?.version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Map validation — the guard on the guard
// ---------------------------------------------------------------------------

/**
 * Check the cascade map against the repo it describes. Returns human-readable
 * problems; an empty array means the map is usable.
 *
 * This is what stops the staleness check from quietly measuring nothing: a
 * section that no longer exists, or a src/ directory nobody mapped, makes the
 * cascade check look satisfied when it is simply blind.
 */
export function validateCascadeMap(root: string, map: CascadeMap): string[] {
  const problems: string[] = [];
  const srcDir = join(root, "src");

  const actualDirs = readdirSync(srcDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `src/${e.name}`)
    .sort();

  const mapped = Object.keys(map.cascade).sort();

  for (const dir of actualDirs) {
    if (!mapped.includes(dir)) {
      problems.push(
        `${dir} exists but has no entry in doc-cascade-map.json — add its doc targets, or an empty targets list with an \`undocumented\` reason`,
      );
    }
  }
  for (const dir of mapped) {
    if (!actualDirs.includes(dir)) {
      problems.push(`doc-cascade-map.json maps ${dir}, which is not a directory under src/`);
    }
  }

  // Doc caches, so each doc is read once.
  const docText = new Map<string, string | null>();
  const read = (doc: string): string | null => {
    if (!docText.has(doc)) {
      const p = join(root, doc);
      docText.set(doc, existsSync(p) ? readFileSync(p, "utf8") : null);
    }
    return docText.get(doc) ?? null;
  };

  for (const [dir, entry] of Object.entries(map.cascade)) {
    if (entry.targets.length === 0) {
      if (!entry.undocumented?.trim()) {
        problems.push(`${dir} has no cascade targets and no \`undocumented\` reason explaining why`);
      }
      continue;
    }
    for (const t of entry.targets) {
      const text = read(t.doc);
      if (text === null) {
        problems.push(`${dir} → ${t.doc} does not exist`);
        continue;
      }
      const hits = matchingHeadings(text, t.section);
      if (hits.length === 0) {
        problems.push(`${dir} → ${t.doc} has no heading containing "${t.section}"`);
      } else if (hits.length > 1) {
        problems.push(
          `${dir} → ${t.doc} has ${hits.length} headings containing "${t.section}" (${hits.join(" / ")}) — the reference is ambiguous`,
        );
      }
    }
  }

  // A directory the docs name explicitly must be cascaded. This is derived from
  // the docs, not from a hand-kept allowlist, so emptying a targets list to
  // silence a failure does not work.
  for (const doc of new Set(Object.values(map.cascade).flatMap((e) => e.targets.map((t) => t.doc)))) {
    const text = read(doc);
    if (!text) continue;
    for (const h of headings(text)) {
      const m = /\(`(src\/[a-z0-9-]+)\/`\)/i.exec(h);
      if (!m) continue;
      const dir = m[1];
      const entry = map.cascade[dir];
      if (entry && entry.targets.length === 0) {
        problems.push(
          `${doc} heading "${h}" documents ${dir}, but doc-cascade-map.json gives ${dir} no targets`,
        );
      }
    }
  }

  // Each test-count claim must still be findable in the doc, and each test path
  // must still exist. A renamed row would otherwise take the drift check with it.
  const specText = read(map.testCountDoc);
  if (specText === null) {
    problems.push(`testCountDoc ${map.testCountDoc} does not exist`);
  } else {
    const claims = parseTestCountClaims(specText);
    for (const area of Object.keys(map.testCounts)) {
      if (!(area in claims)) {
        problems.push(
          `testCounts area "${area}" has no "N tests pass" row in ${map.testCountDoc} — the row was renamed or removed, so the drift check would measure nothing`,
        );
      }
    }
    for (const [area, path] of Object.entries(map.testCounts)) {
      if (!existsSync(join(root, path))) {
        problems.push(`testCounts area "${area}" points at ${path}, which does not exist`);
      }
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// The three checks
// ---------------------------------------------------------------------------

export function checkCascade(changedPaths: string[], map: CascadeMap): Finding[] {
  const changed = new Set(changedPaths);
  const findings: Finding[] = [];

  for (const [dir, entry] of Object.entries(map.cascade)) {
    const touched = changedPaths.filter((p) => p.startsWith(`${dir}/`));
    if (touched.length === 0 || entry.targets.length === 0) continue;
    const stale = entry.targets.filter((t) => !changed.has(t.doc));
    if (stale.length === 0) continue;
    findings.push({
      check: "cascade",
      message:
        `\`${dir}/\` changed (${touched.length} file${touched.length === 1 ? "" : "s"}) but ` +
        stale.map((t) => `**${t.doc}** § _${t.section}_`).join(" and ") +
        " did not.",
    });
  }
  return findings;
}

export function checkVersionChangelog(
  changedPaths: string[],
  baseVersion: string | null,
  headVersion: string | null,
): Finding[] {
  if (!baseVersion || !headVersion || baseVersion === headVersion) return [];
  if (changedPaths.includes("CHANGELOG.md")) return [];
  return [
    {
      check: "version",
      message: `\`package.json\` version went ${baseVersion} → ${headVersion} but **CHANGELOG.md** was not touched.`,
    },
  ];
}

export function checkTestCountDrift(
  specMarkdown: string,
  live: Record<string, Measurement>,
): Finding[] {
  const claims = parseTestCountClaims(specMarkdown);
  const findings: Finding[] = [];

  for (const [area, measurement] of Object.entries(live)) {
    const claimed = claims[area];
    if (claimed === undefined) {
      findings.push({
        check: "test-counts",
        message: `No "N tests pass" row for **${area}** — the cascade map expects one. UNMEASURED, not clean.`,
      });
      continue;
    }
    if (measurement.kind === "unmeasured") {
      findings.push({
        check: "test-counts",
        message: `**${area}**: UNMEASURED — ${measurement.why}. The doc still claims ${claimed}.`,
      });
      continue;
    }
    if (measurement.value !== claimed) {
      const delta = measurement.value - claimed;
      findings.push({
        check: "test-counts",
        message: `**${area}**: doc says ${claimed} tests pass, live run says ${measurement.value} (${delta > 0 ? "+" : ""}${delta}).`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const HEADINGS: Record<Finding["check"], string> = {
  cascade: "Source changed, docs did not",
  version: "Version bumped, changelog did not",
  "test-counts": "Hardcoded test counts have drifted",
};

export function renderReport(findings: Finding[], mapProblems: string[] = []): string {
  if (findings.length === 0 && mapProblems.length === 0) return "";

  const lines = ["## Doc staleness check", "", "_Advisory — this check never blocks a merge._", ""];

  if (mapProblems.length > 0) {
    lines.push(
      "### `doc-cascade-map.json` is out of step with the repo",
      "",
      "The cascade check below can only see what the map points at, so treat these as blinding it:",
      "",
      ...mapProblems.map((p) => `- ${p}`),
      "",
    );
  }

  for (const check of ["cascade", "version", "test-counts"] as const) {
    const group = findings.filter((f) => f.check === check);
    if (group.length === 0) continue;
    lines.push(`### ${HEADINGS[check]}`, "", ...group.map((f) => `- ${f.message}`), "");
  }

  lines.push("<!-- agentgrit-doc-check -->");
  return lines.join("\n");
}

export function loadCascadeMap(root: string): CascadeMap {
  return JSON.parse(readFileSync(join(root, "doc-cascade-map.json"), "utf8")) as CascadeMap;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const root = process.cwd();
  const baseSha = process.env.DOC_CHECK_BASE_SHA ?? "origin/main";
  const map = loadCascadeMap(root);

  const sh = async (cmd: string[]): Promise<{ ok: boolean; out: string }> => {
    const p = Bun.spawn(cmd, { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    const code = await p.exited;
    return { ok: code === 0, out: `${stdout}\n${stderr}` };
  };

  const diff = await sh(["git", "diff", "--name-only", `${baseSha}...HEAD`]);
  const changedPaths = diff.out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const mapProblems = validateCascadeMap(root, map);

  const findings: Finding[] = [...checkCascade(changedPaths, map)];

  if (changedPaths.includes("package.json")) {
    const base = await sh(["git", "show", `${baseSha}:package.json`]);
    findings.push(
      ...checkVersionChangelog(
        changedPaths,
        base.ok ? versionOf(base.out) : null,
        versionOf(readFileSync(join(root, "package.json"), "utf8")),
      ),
    );
  }

  const live: Record<string, Measurement> = {};
  for (const [area, path] of Object.entries(map.testCounts)) {
    const run = await sh(["bun", "test", path]);
    live[area] = parseBunPassCount(run.out);
  }
  findings.push(...checkTestCountDrift(readFileSync(join(root, map.testCountDoc), "utf8"), live));

  const report = renderReport(findings, mapProblems);
  await Bun.write("doc-check-report.md", report);
  console.log(report || "Doc staleness check: nothing to report.");
}

if (import.meta.main) {
  await main();
}
