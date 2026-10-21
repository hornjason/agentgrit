import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { getBaseDir, stateDir, ruleDomainsFile } from "../adapters/paths";
import type { GraphNode, GraphEdge, Rule } from "../adapters/types";
import type { CorpusProvenance, Graph } from "./types";
// Banked cycle (#261): domain-propagation.ts imports DOMAINS back from this
// module. Counted in fallow-baseline.json; remove the marker when the cycle is.
// fallow-ignore-next-line circular-dependency
import { propagateDomains } from "./domain-propagation";
// Banked cycle (#261): generate-patterns.ts imports back from this module.
// fallow-ignore-next-line circular-dependency
import { loadPatterns } from "./generate-patterns";
import { ruleIdFromFilename, stripRulePrefix } from "./rule-id";

// ── Domain Taxonomy ──

export const DOMAINS = [
  "testing", "escalation", "scope", "delivery",
  "deployment", "security", "ui", "data", "browser",
  "memory", "algorithm", "delegation", "architecture",
  "infra", "scraper", "process",
] as const;

type Domain = (typeof DOMAINS)[number];

// ── Rule-Domains Override ──

interface RuleDomainEntry {
  domains: string[];
  source: string;
}

interface RuleDomainsFile {
  version: number;
  reviewed: boolean;
  rules: Record<string, RuleDomainEntry>;
}

export function defaultRuleDomainsPath(): string {
  return ruleDomainsFile();
}

export function loadRuleDomains(path: string): RuleDomainsFile | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as RuleDomainsFile;
  } catch {
    return null;
  }
}

const normalizeId = stripRulePrefix;

function buildOverrideLookup(
  rules: Record<string, RuleDomainEntry>,
): Map<string, RuleDomainEntry> {
  const map = new Map<string, RuleDomainEntry>();
  for (const [key, entry] of Object.entries(rules)) {
    map.set(key, entry);
    map.set(normalizeId(key), entry);
  }
  return map;
}

function applyDomainOverrides(
  nodes: Record<string, GraphNode>,
  ruleDomains: RuleDomainsFile,
): number {
  const lookup = buildOverrideLookup(ruleDomains.rules);
  let count = 0;
  for (const [id, node] of Object.entries(nodes)) {
    const entry = lookup.get(id)
      ?? lookup.get(normalizeId(id))
      ?? lookup.get(node.name)
      ?? lookup.get(normalizeId(node.name));
    if (!entry) continue;
    const valid = entry.domains.filter((d): d is Domain =>
      (DOMAINS as readonly string[]).includes(d),
    );
    if (valid.length > 0) {
      node.domains = valid;
      node.domainSource = "override";
      count++;
    }
  }
  return count;
}

// ── Rule-Domains Sync ──

export function syncRuleDomains(
  nodes: Record<string, GraphNode>,
  ruleDomainsPath: string,
): { added: number; pruned: number } {
  let ruleDomains = loadRuleDomains(ruleDomainsPath);
  if (!ruleDomains) {
    ruleDomains = { version: 1, reviewed: false, rules: {} };
  }

  let added = 0;
  let pruned = 0;

  // Add entries for nodes with domains but no rule-domains.json entry
  for (const [id, node] of Object.entries(nodes)) {
    if (node.domains.length === 0) continue;
    if (ruleDomains.rules[id]) continue;
    ruleDomains.rules[id] = { domains: [...node.domains], source: "auto" };
    added++;
  }

  // Prune entries pointing to nodes not in graph
  const nodeIds = new Set(Object.keys(nodes));
  for (const id of Object.keys(ruleDomains.rules)) {
    if (!nodeIds.has(id)) {
      delete ruleDomains.rules[id];
      pruned++;
    }
  }

  if (added > 0 || pruned > 0) {
    const dir = dirname(ruleDomainsPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(ruleDomainsPath, JSON.stringify(ruleDomains, null, 2), "utf-8");
  }

  return { added, pruned };
}

// ── Graph I/O ──

function graphPath(): string {
  return join(stateDir(), "knowledge-graph.json");
}

export function readGraph(): Graph {
  const path = graphPath();
  if (!existsSync(path)) {
    return {
      version: "1.0",
      builtAt: new Date().toISOString(),
      nodeCount: 0,
      edgeCount: 0,
      nodes: {},
      edges: [],
    };
  }
  return JSON.parse(readFileSync(path, "utf-8")) as Graph;
}

/**
 * Where a build will actually land. `buildGraph(dir, stateDir())` and
 * `buildGraph(dir)` write the same file for every live caller; this makes the
 * two branches resolve through one expression so a guard cannot be added to
 * only one of them.
 */
function graphOutputPath(stateOutputDir?: string): string {
  return stateOutputDir ? join(stateOutputDir, "knowledge-graph.json") : graphPath();
}

/** Read the graph at an explicit path, or null if there is nothing there. */
function readGraphAt(path: string): Graph | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Graph;
  } catch {
    return null;
  }
}

// ── Corpus Collapse Guard ──

/**
 * A graph smaller than this is too small for a ratio to mean anything — a
 * three-rule fixture losing two rules is not an incident.
 */
const COLLAPSE_MIN_BASELINE = 20;

/** Below this fraction of the previous node count, the build must explain itself. */
const COLLAPSE_RATIO = 0.5;

/** Set to "1" to write anyway. Named in the refusal message. */
const COLLAPSE_OVERRIDE_ENV = "AGENTGRIT_ALLOW_GRAPH_COLLAPSE";

export class GraphCollapseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphCollapseError";
  }
}

/**
 * Decide whether writing `next` over `previous` would silently destroy the
 * corpus, and return the reason if so.
 *
 * The discriminator is not the node count on its own — a corpus genuinely can
 * shrink. It is the *directory*. A collapse is explained only when the new
 * build walked the same directory the previous graph was built from, and that
 * directory really does hold that few rule files now. A build from a
 * different directory, or a same-directory build that walked 600 files and
 * produced 47 nodes, is refused.
 *
 * A previous graph with no provenance cannot explain anything, so any collapse
 * against it is refused; the override env var is the way through.
 */
export function detectCorpusCollapse(
  previous: Graph | null,
  next: { nodeCount: number; builtFrom?: CorpusProvenance },
): string | null {
  if (!previous) return null;

  const prevCount = previous.nodeCount ?? Object.keys(previous.nodes ?? {}).length;
  if (prevCount < COLLAPSE_MIN_BASELINE) return null;
  if (next.nodeCount >= prevCount * COLLAPSE_RATIO) return null;

  const prevDir = previous.builtFrom?.dir;
  const nextDir = next.builtFrom?.dir;
  const sameCorpus = Boolean(prevDir && nextDir && prevDir === nextDir);
  const corpusReallyShrank =
    next.builtFrom !== undefined && next.builtFrom.fileCount < prevCount * COLLAPSE_RATIO;

  if (sameCorpus && corpusReallyShrank) return null;

  const from = nextDir ?? "(unrecorded)";
  const was = prevDir ?? "(unrecorded — graph predates corpus provenance)";
  const walked = next.builtFrom ? `${next.builtFrom.fileCount} rule file(s)` : "an unrecorded corpus";

  return (
    `refusing to write knowledge graph: node count collapse ${prevCount} -> ${next.nodeCount}. ` +
    `This build walked ${from} and found ${walked}; the graph on disk was built from ${was}. ` +
    `A graph built from the wrong directory still answers every query, so this is refused rather than warned about (issue #290). ` +
    `If the corpus really did shrink, rebuild once with ${COLLAPSE_OVERRIDE_ENV}=1 to record the new provenance.`
  );
}

/**
 * Throw if writing a graph with this shape to `outputPath` would collapse it.
 * Call this *before* any side effect of the build, not just at the write.
 */
function assertNoCorpusCollapse(
  outputPath: string,
  next: { nodeCount: number; builtFrom?: CorpusProvenance },
  previous?: Graph | null,
): void {
  if (process.env[COLLAPSE_OVERRIDE_ENV] === "1") return;
  const prior = previous !== undefined ? previous : readGraphAt(outputPath);
  const refusal = detectCorpusCollapse(prior, next);
  if (refusal) throw new GraphCollapseError(refusal);
}

/**
 * The single write path for the knowledge graph. Every site that puts a graph
 * on disk goes through here, because a guard on one of three write sites is a
 * guard on none — `buildGraph()` reaches `writeGraphFile()` only when
 * `stateOutputDir` is undefined, and no live caller leaves it undefined.
 */
function persistGraph(graph: Graph, outputPath: string): void {
  const previous = readGraphAt(outputPath);

  // Keep provenance sticky through read-modify-write callers (attribution.ts,
  // classify-isolated.ts) that never set it — otherwise the guard erases its
  // own evidence on the first such write.
  if (!graph.builtFrom && previous?.builtFrom) graph.builtFrom = previous.builtFrom;

  assertNoCorpusCollapse(outputPath, graph, previous);

  const dir = dirname(outputPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outputPath, JSON.stringify(graph, null, 2), "utf-8");
}

export function writeGraphFile(graph: Graph): void {
  graph.nodeCount = Object.keys(graph.nodes).length;
  graph.edgeCount = graph.edges.length;
  graph.builtAt = new Date().toISOString();

  persistGraph(graph, graphPath());
}

// ── Frontmatter Parser ──

export function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    fields[key] = value;
  }
  return fields;
}

// ── Severity Inference ──

export function inferSeverity(content: string): number {
  const text = content.toLowerCase();
  if (text.includes("hard stop") || text.includes("zero exceptions") || text.includes("critical")) return 5;
  if (text.includes("never") || text.includes("always") || text.includes("mandatory")) return 4;
  if (text.includes("must") || text.includes("required") || text.includes("important")) return 3;
  if (text.includes("should") || text.includes("prefer") || text.includes("typically")) return 2;
  return 1;
}

// ── Content Hash ──

function computeHash(body: string): string {
  return createHash("md5").update(body).digest("hex").slice(0, 8);
}

// ── Keyword Domain Classifier ──

let _classifyPatterns: Array<{ re: RegExp; neg?: RegExp; domain: string }> | null = null;

function getClassifyPatterns(): Array<{ re: RegExp; neg?: RegExp; domain: string }> {
  if (_classifyPatterns) return _classifyPatterns;
  const loaded = loadPatterns();
  _classifyPatterns = loaded.map(p => ({
    re: new RegExp(p.cascadePattern ?? p.pattern, "i"),
    neg: p.negativePattern ? new RegExp(p.negativePattern, "i") : undefined,
    domain: p.domain,
  }));
  return _classifyPatterns;
}

export function resetClassifyPatterns(): void {
  _classifyPatterns = null;
}

export function keywordClassify(name: string, description: string, content: string): string[] | null {
  const text = `${name} ${description} ${content}`.toLowerCase();
  for (const { re, neg, domain } of getClassifyPatterns()) {
    if (re.test(text) && (!neg || !neg.test(text))) return [domain];
  }
  return null;
}

// ── AI Domain Detection (fallback for ambiguous rules) ──

export interface DomainDetector {
  detect(name: string, description: string, text: string): Promise<string[]>;
}

const DOMAIN_SYSTEM_PROMPT = `You are a behavioral rule classifier. Assign 1-3 domain tags.
Domains: ${DOMAINS.join(", ")}
Respond with JSON only: {"domains": ["tag1", "tag2"]}`;

/**
 * Create a domain detector that uses an inference function.
 * Falls back to keyword classification, only calls LLM for ambiguous cases.
 */
export function createAIDetector(
  infer: (system: string, user: string) => Promise<{ success: boolean; parsed?: unknown }>,
): DomainDetector {
  return {
    async detect(name: string, description: string, text: string): Promise<string[]> {
      // Try keyword classifier first
      const keywords = keywordClassify(name, description, text);
      if (keywords) return keywords;

      // Fall back to LLM inference
      try {
        const result = await infer(
          DOMAIN_SYSTEM_PROMPT,
          `Name: ${name}\nDescription: ${description}\nRule: ${text.slice(0, 400)}`,
        );
        if (result.success && result.parsed) {
          const parsed = result.parsed as { domains?: string[] };
          const valid = (parsed.domains || []).filter((d): d is Domain =>
            (DOMAINS as readonly string[]).includes(d),
          );
          if (valid.length > 0) return valid;
        }
      } catch { /* fall through */ }

      return [];
    },
  };
}

// ── Drift Detection ──

export interface DriftReport {
  unindexedFiles: string[];
  staleNodes: string[];
  driftCount: number;
  staleCount: number;
}

export function detectDrift(graph: Graph, ruleFiles: string[]): DriftReport {
  const fileIds = new Set(ruleFiles.map((f) => f.replace(/\.md$/, "")));
  const nodeIds = new Set(Object.keys(graph.nodes));

  const unindexedFiles = [...fileIds].filter((id) => !nodeIds.has(id));
  const staleNodes = [...nodeIds].filter((id) => !fileIds.has(id));

  return {
    unindexedFiles,
    staleNodes,
    driftCount: unindexedFiles.length,
    staleCount: staleNodes.length,
  };
}

// ── File Discovery ──

interface MemoryFile {
  id: string;
  filename: string;
  content: string;
  frontmatter: Record<string, string>;
}

/**
 * Whether the graph builder will index a file of this name.
 *
 * Exported so doctor can report graph coverage against the same population the
 * builder actually walks. Two copies of this predicate would be two deciders
 * that agree until one is edited, and the disagreement would show up as a
 * coverage gap nobody can reproduce.
 */
export function isIndexableRuleFile(filename: string): boolean {
  return (
    filename.endsWith(".md") &&
    !filename.startsWith("MEMORY") &&
    !filename.startsWith("README")
  );
}

function discoverRuleFiles(rulesDir: string): MemoryFile[] {
  if (!existsSync(rulesDir)) return [];

  return readdirSync(rulesDir)
    .filter(isIndexableRuleFile)
    .map(filename => {
      const content = readFileSync(join(rulesDir, filename), "utf-8");
      const frontmatter = parseFrontmatter(content);
      const id = ruleIdFromFilename(filename);
      return { id, filename, content, frontmatter };
    });
}

// ── Same-Domain Edges ──

function buildSameDomainEdges(
  nodes: Record<string, GraphNode>,
  existingPairs: Set<string>,
): GraphEdge[] {
  const byDomain: Record<string, GraphNode[]> = {};
  for (const node of Object.values(nodes)) {
    const primary = node.domains[0];
    if (!primary) continue;
    (byDomain[primary] = byDomain[primary] || []).push(node);
  }

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  for (const group of Object.values(byDomain)) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.id.localeCompare(b.id));

    for (let i = 0; i < sorted.length; i++) {
      let edgesForNode = 0;
      const neighbors: GraphNode[] = [];
      for (let d = 1; d <= 4 && neighbors.length < 4; d++) {
        if (i - d >= 0) neighbors.push(sorted[i - d]);
        if (i + d < sorted.length && neighbors.length < 4) neighbors.push(sorted[i + d]);
      }

      for (const neighbor of neighbors) {
        if (edgesForNode >= 4) break;
        const pairKey = [sorted[i].id, neighbor.id].sort().join("::");
        if (existingPairs.has(pairKey) || seen.has(pairKey)) continue;

        seen.add(pairKey);
        edges.push({
          from: sorted[i].id,
          to: neighbor.id,
          relationship: "same_domain",
          strength: 0.5,
        });
        edgesForNode++;
      }
    }
  }

  return edges;
}

// ── Co-Occurrence Edges ──

interface SessionEntry {
  ruleIds: string[];
  session_id?: string;
}

interface RatingEntry {
  session_id: string;
  rating: number;
}

function readJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").trim().split("\n");
  const items: T[] = [];
  for (const line of lines) {
    if (!line) continue;
    try { items.push(JSON.parse(line) as T); } catch { /* skip malformed */ }
  }
  return items;
}

export function buildCoOccurrenceEdges(
  nodes: Record<string, GraphNode>,
  existingPairs: Set<string>,
  historyPath?: string,
  ratingsPath?: string,
): GraphEdge[] {
  const hPath = historyPath ?? join(homedir(), ".agentgrit", "state", "session-context-history.jsonl");
  const sessions = readJsonLines<SessionEntry>(hPath);
  if (sessions.length === 0) return [];

  const rPath = ratingsPath ?? join(homedir(), ".agentgrit", "signals", "ratings.jsonl");
  const ratings = readJsonLines<RatingEntry>(rPath);
  const ratingBySession = new Map<string, number>();
  for (const r of ratings) {
    if (r.session_id && typeof r.rating === "number") {
      ratingBySession.set(r.session_id, r.rating);
    }
  }

  const nodeIds = new Set(Object.keys(nodes));
  const pairCounts = new Map<string, number>();
  const totalSessions = sessions.length;

  for (const session of sessions) {
    const ids = (session.ruleIds || []).filter(id => nodeIds.has(id));
    if (ids.length < 2) continue;

    const raw = session.session_id ? ratingBySession.get(session.session_id) : undefined;
    const valid = raw != null && Number.isFinite(raw);
    const clamped = valid ? Math.min(10, Math.max(1, raw)) : undefined;
    const weight = Math.max(0.3, (clamped ?? 5) / 10);
    const sorted = [...ids].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}::${sorted[j]}`;
        pairCounts.set(key, (pairCounts.get(key) || 0) + weight);
      }
    }
  }

  const ranked = [...pairCounts.entries()]
    .map(([key, count]) => ({ key, strength: count / totalSessions }))
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 200);

  const edges: GraphEdge[] = [];
  for (const { key, strength } of ranked) {
    if (existingPairs.has(key)) continue;
    const [from, to] = key.split("::");
    edges.push({ from, to, relationship: "co_occurred", strength });
  }

  return edges;
}

// ── Build Graph ──

export async function buildGraph(rulesDir: string, stateOutputDir?: string, ruleDomainsPath?: string): Promise<Graph> {
  const files = discoverRuleFiles(rulesDir);
  const existingGraph = readGraph();

  const cachedHashes = new Map<string, { domains: string[]; hash: string; domainSource?: GraphNode["domainSource"] }>();
  for (const node of Object.values(existingGraph.nodes)) {
    if (node.content_hash) {
      cachedHashes.set(node.id, { domains: node.domains, hash: node.content_hash, domainSource: node.domainSource });
    }
  }

  const nodes: Record<string, GraphNode> = {};

  for (const file of files) {
    const name = file.frontmatter["name"] || file.id;
    const desc = file.frontmatter["description"] || "";
    const bodyText = file.content.replace(/^---[\s\S]*?---\n/, "");
    const hash = computeHash(bodyText.trim());

    const cached = cachedHashes.get(file.id);
    let domains: string[];
    let domainSource: GraphNode["domainSource"];
    if (cached && cached.hash === hash) {
      domains = cached.domains;
      domainSource = cached.domainSource;
    } else {
      const classified = keywordClassify(name, desc, bodyText);
      domains = classified || [];
      domainSource = classified ? "keyword" : undefined;
    }

    const existing = existingGraph.nodes[file.id];
    nodes[file.id] = {
      id: file.id,
      file: file.filename,
      type: file.frontmatter["type"] || "rule",
      name,
      description: desc || bodyText.trim().slice(0, 500),
      domains,
      domainSource,
      severity: inferSeverity(bodyText),
      occurrence_count: existing?.occurrence_count ?? 0,
      last_updated: existing?.last_updated ?? new Date().toISOString(),
      content_hash: hash,
      memoryType: file.frontmatter["memoryType"] || "behavioral-rule",
    };
  }

  // Apply reviewed domain overrides from rule-domains.json
  const rdPath = ruleDomainsPath ?? defaultRuleDomainsPath();
  const ruleDomains = loadRuleDomains(rdPath);
  let overrideCount = 0;
  if (ruleDomains) {
    overrideCount = applyDomainOverrides(nodes, ruleDomains);
    if (overrideCount > 0) {
      console.log(`  rule-domains.json: ${overrideCount} node(s) overridden with reviewed domains`);
    }
  }

  const provenance: CorpusProvenance = { dir: resolve(rulesDir), fileCount: files.length };

  // Check before edge building, because syncRuleDomains() below prunes
  // rule-domains.json against this node set. A refused build must leave no
  // trace, not prune the real file and then decline to write the graph.
  assertNoCorpusCollapse(graphOutputPath(stateOutputDir), {
    nodeCount: Object.keys(nodes).length,
    builtFrom: provenance,
  });

  const allEdges: GraphEdge[] = [];
  const edgeSeen = new Set<string>();

  // Restore cached inferred edges where both nodes are unchanged
  for (const edge of existingGraph.edges) {
    const fromNode = nodes[edge.from];
    const toNode = nodes[edge.to];
    if (!fromNode || !toNode) continue;

    const fromCached = cachedHashes.get(edge.from);
    const toCached = cachedHashes.get(edge.to);
    const fromUnchanged = fromCached && fromNode.content_hash === fromCached.hash;
    const toUnchanged = toCached && toNode.content_hash === toCached.hash;

    if (fromUnchanged && toUnchanged) {
      const key = [edge.from, edge.to].sort().join("::") + "::" + edge.relationship;
      if (!edgeSeen.has(key)) {
        edgeSeen.add(key);
        allEdges.push(edge);
      }
    }
  }

  // Same-domain edges
  const existingPairs = new Set(allEdges.map(e => [e.from, e.to].sort().join("::")));
  const domainEdges = buildSameDomainEdges(nodes, existingPairs);
  for (const edge of domainEdges) {
    const key = [edge.from, edge.to].sort().join("::") + "::" + edge.relationship;
    if (!edgeSeen.has(key)) {
      edgeSeen.add(key);
      allEdges.push(edge);
    }
  }

  // Co-occurrence edges
  const pairsAfterDomain = new Set(allEdges.map(e => [e.from, e.to].sort().join("::")));
  const coEdges = buildCoOccurrenceEdges(nodes, pairsAfterDomain);
  for (const edge of coEdges) {
    const key = [edge.from, edge.to].sort().join("::") + "::" + edge.relationship;
    if (!edgeSeen.has(key)) {
      edgeSeen.add(key);
      allEdges.push(edge);
    }
  }

  // BM25 neighbor propagation + text similarity for unclassified nodes
  propagateDomains(nodes, allEdges);

  // Sync rule-domains.json: add missing entries, prune stale ones
  const syncResult = syncRuleDomains(nodes, rdPath);
  if (syncResult.added > 0 || syncResult.pruned > 0) {
    console.log(`  rule-domains.json sync: ${syncResult.added} added, ${syncResult.pruned} pruned`);
  }

  const graph: Graph = {
    version: "1.0",
    builtAt: new Date().toISOString(),
    nodeCount: Object.keys(nodes).length,
    edgeCount: allEdges.length,
    nodes,
    edges: allEdges,
    builtFrom: provenance,
  };

  persistGraph(graph, graphOutputPath(stateOutputDir));

  return graph;
}

// ── Build Graph with AI domain detection ──

export async function buildGraphWithAI(
  rulesDir: string,
  detector: DomainDetector,
  stateOutputDir?: string,
  ruleDomainsPath?: string,
): Promise<Graph> {
  const files = discoverRuleFiles(rulesDir);
  const existingGraph = readGraph();

  const cachedHashes = new Map<string, { domains: string[]; hash: string; domainSource?: GraphNode["domainSource"] }>();
  for (const node of Object.values(existingGraph.nodes)) {
    if (node.content_hash) {
      cachedHashes.set(node.id, { domains: node.domains, hash: node.content_hash, domainSource: node.domainSource });
    }
  }

  const nodes: Record<string, GraphNode> = {};

  for (const file of files) {
    const name = file.frontmatter["name"] || file.id;
    const desc = file.frontmatter["description"] || "";
    const bodyText = file.content.replace(/^---[\s\S]*?---\n/, "");
    const hash = computeHash(bodyText.trim());

    const cached = cachedHashes.get(file.id);
    let domains: string[];
    let domainSource: GraphNode["domainSource"];
    if (cached && cached.hash === hash) {
      domains = cached.domains;
      domainSource = cached.domainSource;
    } else {
      domains = await detector.detect(name, desc, bodyText);
      domainSource = domains.length > 0 ? "ai" : undefined;
    }

    const existing = existingGraph.nodes[file.id];
    nodes[file.id] = {
      id: file.id,
      file: file.filename,
      type: file.frontmatter["type"] || "rule",
      name,
      description: desc || bodyText.trim().slice(0, 500),
      domains,
      domainSource,
      severity: inferSeverity(bodyText),
      occurrence_count: existing?.occurrence_count ?? 0,
      last_updated: existing?.last_updated ?? new Date().toISOString(),
      content_hash: hash,
      memoryType: file.frontmatter["memoryType"] || "behavioral-rule",
    };
  }

  // Apply reviewed domain overrides from rule-domains.json
  const rdPath = ruleDomainsPath ?? defaultRuleDomainsPath();
  const ruleDomains = loadRuleDomains(rdPath);
  if (ruleDomains) {
    const overrideCount = applyDomainOverrides(nodes, ruleDomains);
    if (overrideCount > 0) {
      console.log(`  rule-domains.json: ${overrideCount} node(s) overridden with reviewed domains`);
    }
  }

  const provenance: CorpusProvenance = { dir: resolve(rulesDir), fileCount: files.length };

  // Same ordering reason as buildGraph(): refuse before syncRuleDomains().
  assertNoCorpusCollapse(graphOutputPath(stateOutputDir), {
    nodeCount: Object.keys(nodes).length,
    builtFrom: provenance,
  });

  const allEdges: GraphEdge[] = [];
  const edgeSeen = new Set<string>();

  // Restore cached edges where both nodes unchanged
  for (const edge of existingGraph.edges) {
    const fromNode = nodes[edge.from];
    const toNode = nodes[edge.to];
    if (!fromNode || !toNode) continue;

    const fromCached = cachedHashes.get(edge.from);
    const toCached = cachedHashes.get(edge.to);
    const fromUnchanged = fromCached && fromNode.content_hash === fromCached.hash;
    const toUnchanged = toCached && toNode.content_hash === toCached.hash;

    if (fromUnchanged && toUnchanged) {
      const key = [edge.from, edge.to].sort().join("::") + "::" + edge.relationship;
      if (!edgeSeen.has(key)) {
        edgeSeen.add(key);
        allEdges.push(edge);
      }
    }
  }

  // Same-domain edges
  const existingPairs = new Set(allEdges.map((e) => [e.from, e.to].sort().join("::")));
  const domainEdges = buildSameDomainEdges(nodes, existingPairs);
  for (const edge of domainEdges) {
    const key = [edge.from, edge.to].sort().join("::") + "::" + edge.relationship;
    if (!edgeSeen.has(key)) {
      edgeSeen.add(key);
      allEdges.push(edge);
    }
  }

  // Co-occurrence edges
  const pairsAfterDomainAI = new Set(allEdges.map(e => [e.from, e.to].sort().join("::")));
  const coEdgesAI = buildCoOccurrenceEdges(nodes, pairsAfterDomainAI);
  for (const edge of coEdgesAI) {
    const key = [edge.from, edge.to].sort().join("::") + "::" + edge.relationship;
    if (!edgeSeen.has(key)) {
      edgeSeen.add(key);
      allEdges.push(edge);
    }
  }

  // BM25 neighbor propagation + text similarity for unclassified nodes
  propagateDomains(nodes, allEdges);

  // Sync rule-domains.json: add missing entries, prune stale ones
  const syncResultAI = syncRuleDomains(nodes, rdPath);
  if (syncResultAI.added > 0 || syncResultAI.pruned > 0) {
    console.log(`  rule-domains.json sync: ${syncResultAI.added} added, ${syncResultAI.pruned} pruned`);
  }

  const graph: Graph = {
    version: "1.0",
    builtAt: new Date().toISOString(),
    nodeCount: Object.keys(nodes).length,
    edgeCount: allEdges.length,
    nodes,
    edges: allEdges,
    builtFrom: provenance,
  };

  persistGraph(graph, graphOutputPath(stateOutputDir));

  return graph;
}

// ── Update Graph (incremental single-node add) ──

export function updateGraph(graph: Graph, newRules: Rule[]): Graph {
  const updated = { ...graph, nodes: { ...graph.nodes }, edges: [...graph.edges] };

  for (const rule of newRules) {
    const hash = computeHash(rule.text);
    const classified = keywordClassify(rule.id, rule.text, rule.text);
    const domains = classified || ["testing"];
    const domainSource: GraphNode["domainSource"] = classified ? "keyword" : undefined;

    if (updated.nodes[rule.id]) {
      updated.nodes[rule.id] = {
        ...updated.nodes[rule.id],
        domains,
        domainSource,
        description: rule.text.slice(0, 500),
        content_hash: hash,
      };
      continue;
    }

    updated.nodes[rule.id] = {
      id: rule.id,
      file: `${rule.id}.md`,
      type: "rule",
      name: rule.id,
      description: rule.text.slice(0, 500),
      domains,
      domainSource,
      severity: inferSeverity(rule.text),
      occurrence_count: 0,
      last_updated: new Date().toISOString(),
      content_hash: hash,
      memoryType: "behavioral-rule",
    };

    // Connect to domain siblings
    const siblings = Object.values(updated.nodes).filter(
      n => n.id !== rule.id && n.domains.some(d => domains.includes(d)),
    );

    for (const sibling of siblings.slice(0, 4)) {
      const pairKey = [rule.id, sibling.id].sort().join("::");
      const exists = updated.edges.some(
        e => [e.from, e.to].sort().join("::") === pairKey,
      );
      if (!exists) {
        updated.edges.push({
          from: rule.id,
          to: sibling.id,
          relationship: "same_domain",
          strength: 0.5,
        });
      }
    }
  }

  updated.nodeCount = Object.keys(updated.nodes).length;
  updated.edgeCount = updated.edges.length;
  updated.builtAt = new Date().toISOString();

  return updated;
}

// ── Maintenance: prune stale nodes ──

export function pruneStaleNodes(graph: Graph, validIds: Set<string>): Graph {
  const pruned = { ...graph, nodes: { ...graph.nodes }, edges: [...graph.edges] };
  const staleIds = Object.keys(pruned.nodes).filter(id => !validIds.has(id));

  if (staleIds.length === 0) return pruned;

  const staleSet = new Set(staleIds);
  for (const id of staleIds) delete pruned.nodes[id];
  pruned.edges = pruned.edges.filter(e => !staleSet.has(e.from) && !staleSet.has(e.to));
  pruned.nodeCount = Object.keys(pruned.nodes).length;
  pruned.edgeCount = pruned.edges.length;

  return pruned;
}
