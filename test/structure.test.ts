/**
 * Structural guards.
 *
 * Deep modules with thin consumers only holds if nothing bypasses the deep
 * module. These tests fail the build when source reaches around the path
 * authority or hardcodes this machine's layout — the failure mode that left
 * 57 call sites pinned to ~/.claude and made the package uninstallable by
 * anyone else.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const ROOT = join(import.meta.dir, "..");
const PATH_AUTHORITY = join(ROOT, "src", "adapters", "paths.ts");

/** Every .ts file under the given dirs, excluding the path authority itself. */
function sourceFiles(dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts") && full !== PATH_AUTHORITY) out.push(full);
    }
  };
  for (const d of dirs) walk(join(ROOT, d));
  return out;
}

/** file:line for each line matching the pattern, ignoring comments. */
function offenders(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const file of sourceFiles(["src", "bin"])) {
    const lines = readFileSync(file, "utf-8").split("\n");
    lines.forEach((line, i) => {
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
      if (pattern.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1}`);
    });
  }
  return hits;
}

describe("ST-1: the path authority is the only place that names host layout", () => {
  test("no source file outside paths.ts mentions .claude", () => {
    expect(offenders(/\.claude\b/)).toEqual([]);
  });

  test("no source file hardcodes a PAI MEMORY path", () => {
    expect(offenders(/MEMORY\/LEARNING|MEMORY["'\s,)]*,\s*["']LEARNING/)).toEqual([]);
  });
});

describe("ST-2: no personal identifiers in shipped source", () => {
  test("no home directory of a specific user", () => {
    expect(offenders(/\/Users\/[a-z]+\//i)).toEqual([]);
  });
});

describe("ST-3: the path authority exports the documented surface", () => {
  const content = readFileSync(PATH_AUTHORITY, "utf-8");
  const required = [
    "getBaseDir", "hostDir", "hostRulesFile", "hostRulesDir", "hostSettingsFile",
    "hostRegistryFile", "hostTranscriptsDir", "hostProjectRulesFile",
    "hostProjectRulesDir", "learnedRulesFile", "ruleDomainsFile", "rulesDir",
    "pendingRulesFile", "pendingRulesArchiveFile", "graphContextFile",
    "patternsFile", "recallScoresFile", "ratingsFile", "toolAuditFile",
    "legacySignalDir", "stateDir", "signalsDir", "rubricsDir", "projectDir",
  ];
  for (const fn of required) {
    test(`exports ${fn}`, () => {
      expect(content).toContain(`export function ${fn}(`);
    });
  }
});
