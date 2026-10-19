/**
 * rule-text.ts — resolve the body text of a retrieval candidate.
 *
 * Candidates arrive from two corpora that do not share a directory: BM25
 * indexes the memory dir, the graph indexes the rules dir. A candidate from
 * one is routinely absent from the other, so "no graph node" is the normal
 * case, not an error — but it is never a licence to render the id as the
 * rule's body. Either real text is found, or the candidate is reported as
 * unresolved and the caller omits it.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { parseFrontmatter } from "./builder";
import { canonicalRuleId, isSafeRuleId, ruleFileName } from "./rule-id";
import { resolveMemoryDir, rulesDir } from "../adapters/paths";
import type { BM25Index, Graph } from "./types";
import type { GraphNode } from "../adapters/types";

/** Longest body-derived rule text we will inject. */
const MAX_BODY_CHARS = 400;

const canonicalNodeIndexes = new WeakMap<Graph, Map<string, GraphNode>>();

function canonicalNodeIndex(graph: Graph): Map<string, GraphNode> {
  const cached = canonicalNodeIndexes.get(graph);
  if (cached) return cached;

  const index = new Map<string, GraphNode>();
  for (const [id, node] of Object.entries(graph.nodes)) {
    const key = canonicalRuleId(id);
    // First spelling wins, so an exact id never loses to a near-spelling.
    if (!index.has(key)) index.set(key, node);
  }
  canonicalNodeIndexes.set(graph, index);
  return index;
}

/**
 * The graph node a candidate id refers to, matching on the canonical spelling
 * when the exact one misses. Returns null when the graph genuinely has no
 * node for this rule — ids differing by a word are different rules.
 */
export function resolveGraphNode(id: string, graph: Graph): GraphNode | null {
  const exact = graph.nodes[id];
  if (exact) return exact;
  return canonicalNodeIndex(graph).get(canonicalRuleId(id)) ?? null;
}

/** Text that is just the rule's own name is the defect, not a resolution. */
function usable(text: string | undefined | null, id: string): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  if (canonicalRuleId(trimmed) === canonicalRuleId(id)) return null;
  return trimmed;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && /^(".*"|'.*')$/s.test(trimmed)) return trimmed.slice(1, -1);
  return trimmed;
}

/** First prose paragraph of a markdown document, frontmatter and headings skipped. */
function firstBodyParagraph(content: string): string | null {
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
  for (const block of body.split(/\n\s*\n/)) {
    const line = block
      .split("\n")
      .map(l => l.trim())
      .filter(l => l && !/^#{1,6}\s/.test(l) && !/^(---|```)/.test(l))
      .join(" ")
      .trim();
    if (line) {
      return line.length > MAX_BODY_CHARS ? `${line.slice(0, MAX_BODY_CHARS).trimEnd()}…` : line;
    }
  }
  return null;
}

/**
 * Candidate source documents for an id, most authoritative first.
 *
 * The id is attacker-reachable — `resolveRuleText` is exported and its ids
 * come from the registry file and the graph, not from this module — so it is
 * only turned into a path through `ruleFileName`, which refuses anything that
 * is not a single path segment. An unsafe id yields no corpus paths at all,
 * which `readRuleTextFromDocument` reports as "unresolved" rather than
 * reading outside the memory and rules dirs.
 */
function documentPaths(id: string, index?: BM25Index): string[] {
  const paths: string[] = [];
  const indexed = index?.docs.find(d => d.id === id)?.file;
  if (indexed) paths.push(indexed);

  if (!isSafeRuleId(id)) return paths;

  const filename = ruleFileName(id);
  for (const dir of [safeDir(resolveMemoryDir), safeDir(rulesDir)]) {
    if (dir) paths.push(join(dir, filename));
  }
  return paths;
}

function safeDir(fn: () => string): string | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** Body text read off the rule's own markdown file. */
export function readRuleTextFromDocument(id: string, index?: BM25Index): string | null {
  for (const path of documentPaths(id, index)) {
    if (!existsSync(path)) continue;
    let content: string;
    try {
      content = readFileSync(path, "utf-8");
    } catch {
      continue;
    }

    const described = usable(unquote(parseFrontmatter(content).description ?? ""), id);
    if (described) return described;

    const body = usable(firstBodyParagraph(content), id);
    if (body) return body;
  }
  return null;
}

/**
 * The rule's body text, or null when no source carries one.
 *
 * Null means "omit this candidate". It must never be substituted with the id:
 * that is what turned a missed lookup into `- **some_rule:** some_rule` in
 * every injected session.
 */
export function resolveRuleText(id: string, graph: Graph, index?: BM25Index): string | null {
  const node = resolveGraphNode(id, graph);
  if (node) {
    const fromNode = usable(node.description, id) ?? usable(node.name, id);
    if (fromNode) return fromNode;
  }
  return readRuleTextFromDocument(id, index);
}
