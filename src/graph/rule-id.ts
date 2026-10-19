/**
 * rule-id.ts — the one place a rule id is derived.
 *
 * A rule arrives from several directions: a `.md` filename under the rules
 * dir (graph nodes), a `.md` filename under the memory dir (BM25 docs), a
 * `Rule.id` handed to the registry writer, and a slug minted by a converter.
 * When each of those spelled the id its own way the registry and the graph
 * drifted apart — 590 registry ids against 47 graph nodes, 4 in common — and
 * a lookup miss was rendered to the user as a rule whose body was its own id.
 *
 * Two derivations, and only two:
 *
 *   - `ruleIdFromFilename` / `ruleFileName` — the id as it is *spelled*, the
 *     round-trip between a file on disk and the id that names it. Spelling is
 *     preserved, because the file has to be findable again.
 *   - `canonicalRuleId` — the id as it is *compared*. Case, hyphens,
 *     underscores and punctuation all collapse, so two sources that spell the
 *     same rule differently still meet.
 *
 * Canonicalising is deliberately conservative: it never deletes a word. Two
 * ids that differ by a word are two different rules, and matching them would
 * swap one rule's text onto another's name.
 */

import { basename } from "path";

/** Prefixes that encode a rule's origin rather than its subject. */
const KNOWN_PREFIXES = ["feedback", "success", "project", "reference"] as const;

/** The id that names a rule file: its basename, minus the `.md`. */
export function ruleIdFromFilename(filename: string): string {
  return basename(filename).replace(/\.md$/i, "");
}

/**
 * True when an id can be used as a filename inside one directory.
 *
 * Ids reach `join(dir, ruleFileName(id))` from the registry, the graph and
 * callers of the exported resolvers — none of which this module minted. An id
 * carrying a separator or a `..` segment turns that join into a read or a
 * write outside the directory, so the id is checked where it becomes a path
 * segment rather than at each call site.
 *
 * Deliberately narrow about *structure* only: 586 of the registry's 623 ids
 * are sentence-shaped, with spaces, parentheses and dots, and those are
 * legitimate filenames. Rejecting them would empty the corpus.
 */
export function isSafeRuleId(id: string): boolean {
  if (!id) return false;
  if (id.includes("\0")) return false;
  if (id.includes("/") || id.includes("\\")) return false;
  if (id === "." || id === "..") return false;
  // basename() of a single safe segment is the segment itself; anything the
  // platform reads as a path is caught by the comparison.
  return basename(id) === id;
}

/**
 * The file that an id names. Inverse of `ruleIdFromFilename`.
 *
 * Throws rather than sanitising: an id that is not a single path segment is
 * not a rule this registry knows about, and silently rewriting it would file
 * the rule under a name no lookup will ever ask for.
 */
export function ruleFileName(id: string): string {
  if (!isSafeRuleId(id)) {
    throw new Error(`Unsafe rule id (must be a single path segment): ${JSON.stringify(id)}`);
  }
  return `${id}.md`;
}

/**
 * The comparison key for a rule id. Idempotent: canonical input is returned
 * unchanged, so it is safe to apply to an already-canonical id.
 */
export function canonicalRuleId(raw: string): string {
  return ruleIdFromFilename(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** True when two ids name the same rule under the canonical spelling. */
export function ruleIdsMatch(a: string, b: string): boolean {
  return canonicalRuleId(a) === canonicalRuleId(b);
}

/**
 * The canonical id with its origin prefix removed, for matching a registry
 * key written without one (`verify-before-answering`) against a graph node id
 * written with one (`feedback_verify_before_answering`).
 */
export function stripRulePrefix(id: string): string {
  const canon = canonicalRuleId(id);
  for (const prefix of KNOWN_PREFIXES) {
    if (canon.startsWith(`${prefix}_`)) return canon.slice(prefix.length + 1);
  }
  return canon;
}
