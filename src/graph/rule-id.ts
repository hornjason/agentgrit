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
 * True when an id is safe to turn into a filename inside a known directory.
 *
 * Rule ids reach this module from the registry, from converters and from
 * retrieval candidates — none of which are filenames to begin with. An id
 * carrying a separator or a parent segment escapes the directory it is joined
 * to, so it is rejected rather than sanitised: a rewritten id would silently
 * name a *different* rule, and that is the class of bug this module exists to
 * stop.
 */
export function isSafeRuleId(id: string): boolean {
  if (typeof id !== "string" || id.trim() === "") return false;
  if (id.includes("/") || id.includes("\\") || id.includes("\0")) return false;
  if (id === "." || id === "..") return false;
  return basename(id) === id;
}

/**
 * The file that an id names. Inverse of `ruleIdFromFilename`.
 *
 * Throws on an id that would escape the directory it is joined to. Callers
 * join the result to a rules or memory dir, so returning a traversal here
 * would be a write (or read) outside that dir.
 */
export function ruleFileName(id: string): string {
  if (!isSafeRuleId(id)) {
    throw new Error(`unsafe rule id: ${JSON.stringify(id)} cannot name a file`);
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
