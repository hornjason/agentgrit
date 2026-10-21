/**
 * AC-4 (#308): the auto-reflection module references no inference, judge, or
 * network call site.
 *
 * `src/daemon/auto-reflection.ts` exists so a standalone install — no API key,
 * no credential of any kind — still produces the reflections the optimizer
 * stack reads. That promise is a property of the code, not of a run: a cycle
 * on a machine with no key would pass a behavioural test whether or not the
 * module reaches an LLM, because the call would merely fail. So this is a
 * source-level check, and it has to be a transitive one.
 *
 * test/daemon/auto-reflection.test.ts already asserts the module's own text
 * carries no `adapters/inference` import and no `inference(` call. That holds
 * the first edge and nothing beyond it: an import of a neighbour that itself
 * imports the inference adapter satisfies it exactly as well as purity does,
 * and the module's own header names that risk — `AutoReflection` is declared
 * locally rather than imported "so this module keeps no edge — not even a
 * type-only one — to a module that pulls in the inference adapter." Nothing
 * was holding that sentence. This file walks the whole import closure.
 *
 * The detector is proved against sources that do carry the call sites before
 * it is pointed at the module, because a scanner that matches nothing and a
 * module that contains nothing produce the same green.
 */

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";

const SRC_ROOT = resolve(import.meta.dir, "..", "..", "src");
const ENTRY = join(SRC_ROOT, "daemon", "auto-reflection.ts");

/** `from "x"`, `import("x")` — static, dynamic and type-position — and `require("x")`. */
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

/**
 * Call sites that reach inference, a judge, or the network. Matched against
 * source with comments stripped: the entry module's header discusses the
 * inference adapter in prose, and prose must neither trip this check nor
 * satisfy it.
 */
const BANNED_CALLS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: "inference", pattern: /\binference\s*\(/ },
  { kind: "judge", pattern: /\bjudge(?:Trace|Batch)\s*\(/ },
  { kind: "network", pattern: /\bfetch\s*\(/ },
  { kind: "network", pattern: /\bnew\s+XMLHttpRequest\b/ },
];

/**
 * Modules and packages that are themselves the call site. Checked against
 * resolved import specifiers only — never against arbitrary source text,
 * because `src/adapters/types.ts` legitimately contains the string literal
 * `"openai"` as a provider union member and is not thereby impure.
 */
const BANNED_SPECIFIERS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: "inference", pattern: /(?:^|\/)adapters\/inference$/ },
  { kind: "judge", pattern: /(?:^|\/)evaluate\/judge$/ },
  { kind: "network", pattern: /(?:^|\/)adapters\/langfuse$/ },
  { kind: "network", pattern: /(?:^|\/)graph\/(?:contextual-)?embedder$/ },
  { kind: "network", pattern: /^(?:node:)?(?:http|https|net|tls|dgram)$/ },
  { kind: "network", pattern: /^(?:axios|undici|openai|@anthropic-ai\/.*|@google\/.*)$/ },
];

/**
 * Block comments, and line comments that are not the `//` inside a URL. A
 * scheme-relative `//` is always preceded by `:`, which is excluded.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/gm, "$1");
}

function specifiersOf(source: string): string[] {
  return [...stripComments(source).matchAll(SPECIFIER_RE)].map((m) => m[1]!);
}

/** Relative specifiers resolve inside the tree; bare ones are package names. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (candidate.endsWith(".ts") && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every `.ts` file reachable from `entry` by import, keyed by path. */
function importClosure(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    const source = readFileSync(file, "utf-8");
    seen.set(file, source);

    for (const spec of specifiersOf(source)) {
      const next = resolveSpecifier(file, spec);
      if (next && !seen.has(next)) queue.push(next);
    }
  }

  return seen;
}

/** One finding per banned call site or specifier, named by file and kind. */
function impurities(files: Map<string, string>): string[] {
  const found: string[] = [];

  for (const [file, source] of files) {
    const where = relative(SRC_ROOT, file);
    const body = stripComments(source);

    for (const { kind, pattern } of BANNED_CALLS) {
      if (pattern.test(body)) found.push(`${where}: ${kind} call ${pattern.source}`);
    }
    for (const spec of specifiersOf(source)) {
      for (const { kind, pattern } of BANNED_SPECIFIERS) {
        if (pattern.test(spec)) found.push(`${where}: ${kind} import "${spec}"`);
      }
    }
  }

  return found;
}

describe("the impurity detector fires on sources that do carry the call sites", () => {
  test("a module that imports and calls the inference adapter is named twice", () => {
    const synthetic = new Map([
      [
        join(SRC_ROOT, "daemon", "synthetic-impure.ts"),
        'import { inference } from "../adapters/inference";\n' +
          "export async function ask() {\n" +
          '  return inference({ prompt: "hi" });\n' +
          "}\n",
      ],
    ]);

    const found = impurities(synthetic);

    expect(found.filter((f) => f.includes("inference call"))).toHaveLength(1);
    expect(found.filter((f) => f.includes('inference import "../adapters/inference"'))).toHaveLength(1);
  });

  test("a judge call and a judge import are both named", () => {
    const synthetic = new Map([
      [
        join(SRC_ROOT, "daemon", "synthetic-judge.ts"),
        'import { judgeTrace } from "../evaluate/judge";\n' +
          "export const run = () => judgeTrace(t, r, c);\n",
      ],
    ]);

    const found = impurities(synthetic);

    expect(found.some((f) => f.includes("judge call"))).toBe(true);
    expect(found.some((f) => f.includes('judge import "../evaluate/judge"'))).toBe(true);
  });

  test("the real inference adapter and the real judge are both flagged for network", () => {
    const real = new Map<string, string>();
    for (const rel of ["adapters/inference.ts", "evaluate/judge.ts"]) {
      const file = join(SRC_ROOT, rel);
      real.set(file, readFileSync(file, "utf-8"));
    }

    const found = impurities(real);

    expect(found.some((f) => f.startsWith("adapters/inference.ts: network"))).toBe(true);
    expect(found.some((f) => f.startsWith("evaluate/judge.ts: network"))).toBe(true);
  });

  test("prose about the inference adapter is not a call site", () => {
    const commentary = new Map([
      [
        join(SRC_ROOT, "daemon", "synthetic-prose.ts"),
        "/** Nothing here may import the inference adapter, and nothing calls inference(). */\n" +
          "// see adapters/inference for the thing we do not use\n" +
          "export const pure = 1;\n",
      ],
    ]);

    expect(impurities(commentary)).toEqual([]);
  });

  test("a provider name in a string union is not a network import", () => {
    const union = new Map([
      [
        join(SRC_ROOT, "adapters", "synthetic-types.ts"),
        'export type Provider = "gemini" | "claude" | "openai";\n',
      ],
    ]);

    expect(impurities(union)).toEqual([]);
  });
});

describe("auto-reflection is pure (#308 AC-4)", () => {
  const closure = importClosure(ENTRY);

  test("the closure walks past the entry module", () => {
    // A walk that resolved nothing would scan one file and report clean, which
    // is the shape of a passing check that is measuring almost nothing.
    expect(closure.has(ENTRY)).toBe(true);
    expect(closure.has(join(SRC_ROOT, "adapters", "types.ts"))).toBe(true);
    expect(closure.size).toBeGreaterThanOrEqual(2);
  });

  test("no module reachable from auto-reflection.ts reaches inference, a judge, or the network", () => {
    expect(impurities(closure)).toEqual([]);
  });

  test("the closure does not reach any module that holds a credentialled call", () => {
    const credentialled = [
      "adapters/inference.ts",
      "adapters/langfuse.ts",
      "evaluate/judge.ts",
      "graph/embedder.ts",
      "graph/contextual-embedder.ts",
      "graph/context.ts",
      "optimize/skill-synthesizer.ts",
    ];
    const reached = [...closure.keys()].map((f) => relative(SRC_ROOT, f));

    for (const module of credentialled) {
      expect(reached).not.toContain(module);
    }
  });
});
