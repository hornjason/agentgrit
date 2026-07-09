import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { getBaseDir, stateDir } from "../adapters/paths";
import type { GraphNode, GraphEdge, Rule } from "../adapters/types";
import type { Graph } from "./types";

// ── Domain Taxonomy ──

export const DOMAINS = [
  "verification", "escalation", "scope", "delivery", "communication",
  "deployment", "security", "ui-testing", "data", "browser",
  "memory", "algorithm", "delegation",
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
  return join(homedir(), ".claude", "MEMORY", "LEARNING", "STATE", "rule-domains.json");
}

export function loadRuleDomains(path: string): RuleDomainsFile | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as RuleDomainsFile;
  } catch {
    return null;
  }
}

const KNOWN_PREFIXES = ["feedback_", "success_", "project_", "reference_"];

function normalizeId(id: string): string {
  let s = id;
  for (const pfx of KNOWN_PREFIXES) {
    if (s.startsWith(pfx)) { s = s.slice(pfx.length); break; }
  }
  return s.replace(/-/g, "_");
}

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
      count++;
    }
  }
  return count;
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

export function writeGraphFile(graph: Graph): void {
  const path = graphPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  graph.nodeCount = Object.keys(graph.nodes).length;
  graph.edgeCount = graph.edges.length;
  graph.builtAt = new Date().toISOString();

  writeFileSync(path, JSON.stringify(graph, null, 2), "utf-8");
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

export function keywordClassify(name: string, description: string, content: string): string[] | null {
  const text = `${name} ${description} ${content}`.toLowerCase();

  if (/makefile|make rebuild|make test|test container|docker|podman|deploy sequence|rebuild/.test(text) &&
      !/before assert|check before|read before|verify state/.test(text)) return ["deployment"];
  if (/\bquinn\b|playwright.*project|visual.*test|screenshot.*valid/.test(text)) return ["ui-testing"];
  if (/\biframe\b|page\.fill|page\.route|selector.*fail|sso.*redirect|login.*flow|browser.*context/.test(text)) return ["browser"];
  if (/security scan|security.*gate|security.*review|vulnerability|destructive|force push/.test(text)) return ["security"];
  if (/spawn.*agent|agent.*spawn|worktree isolation|pre-brief|handoff|delegate.*code/.test(text)) return ["delegation"];
  if (/escalat|bring in.*specialist|wrong approach|1-2 attempt|after.*fail|stuck.*diagnos/.test(text)) return ["escalation"];
  if (/\bprd\b|\bisc\b|algorithm.*phase|effort level|criteria.*count/.test(text)) return ["algorithm"];
  if (/feedback_.*\.md|memory\.md|ratings\.jsonl|learning capture|failure capture/.test(text)) return ["memory"];
  if (/minimal.*scope|only.*asked|don.t add|unrequested|no.*cleanup|stay.*focused/.test(text)) return ["scope"];
  if (/false.*complet|partial.*deliver|incomplete.*deliver|not.*done|self.audit|before.*claiming.*done/.test(text)) return ["delivery"];
  if (/response.*format|output.*format|trailing summary|terse.*response|format.*response/.test(text)) return ["communication"];
  if (/actual.*data|live.*data|measure.*before|read.*before.*plan|real.*numbers/.test(text)) return ["data"];
  if (/read.*before.*answer|check.*before.*claim|verify.*before.*answer|look.*before|read.*source.*first/.test(text)) return ["verification"];

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

function discoverRuleFiles(rulesDir: string): MemoryFile[] {
  if (!existsSync(rulesDir)) return [];

  return readdirSync(rulesDir)
    .filter(f => f.endsWith(".md") && !f.startsWith("MEMORY") && !f.startsWith("README"))
    .map(filename => {
      const content = readFileSync(join(rulesDir, filename), "utf-8");
      const frontmatter = parseFrontmatter(content);
      const id = filename.replace(/\.md$/, "");
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

    const weight = 1;
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

  const cachedHashes = new Map<string, { domains: string[]; hash: string }>();
  for (const node of Object.values(existingGraph.nodes)) {
    if (node.content_hash) {
      cachedHashes.set(node.id, { domains: node.domains, hash: node.content_hash });
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
    if (cached && cached.hash === hash) {
      domains = cached.domains;
    } else {
      const classified = keywordClassify(name, desc, bodyText);
      domains = classified || [];
    }

    const existing = existingGraph.nodes[file.id];
    nodes[file.id] = {
      id: file.id,
      file: file.filename,
      type: file.frontmatter["type"] || "rule",
      name,
      description: desc || bodyText.trim().slice(0, 500),
      domains,
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

  const graph: Graph = {
    version: "1.0",
    builtAt: new Date().toISOString(),
    nodeCount: Object.keys(nodes).length,
    edgeCount: allEdges.length,
    nodes,
    edges: allEdges,
  };

  if (stateOutputDir) {
    const outputPath = join(stateOutputDir, "knowledge-graph.json");
    const dir = dirname(outputPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(outputPath, JSON.stringify(graph, null, 2), "utf-8");
  } else {
    writeGraphFile(graph);
  }

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

  const cachedHashes = new Map<string, { domains: string[]; hash: string }>();
  for (const node of Object.values(existingGraph.nodes)) {
    if (node.content_hash) {
      cachedHashes.set(node.id, { domains: node.domains, hash: node.content_hash });
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
    if (cached && cached.hash === hash) {
      domains = cached.domains;
    } else {
      // Use AI detector for changed/new nodes
      domains = await detector.detect(name, desc, bodyText);
    }

    const existing = existingGraph.nodes[file.id];
    nodes[file.id] = {
      id: file.id,
      file: file.filename,
      type: file.frontmatter["type"] || "rule",
      name,
      description: desc || bodyText.trim().slice(0, 500),
      domains,
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

  const graph: Graph = {
    version: "1.0",
    builtAt: new Date().toISOString(),
    nodeCount: Object.keys(nodes).length,
    edgeCount: allEdges.length,
    nodes,
    edges: allEdges,
  };

  if (stateOutputDir) {
    const outputPath = join(stateOutputDir, "knowledge-graph.json");
    const dir = dirname(outputPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(outputPath, JSON.stringify(graph, null, 2), "utf-8");
  } else {
    writeGraphFile(graph);
  }

  return graph;
}

// ── Update Graph (incremental single-node add) ──

export function updateGraph(graph: Graph, newRules: Rule[]): Graph {
  const updated = { ...graph, nodes: { ...graph.nodes }, edges: [...graph.edges] };

  for (const rule of newRules) {
    const hash = computeHash(rule.text);
    const domains = keywordClassify(rule.id, rule.text, rule.text) || ["verification"];

    if (updated.nodes[rule.id]) {
      updated.nodes[rule.id] = {
        ...updated.nodes[rule.id],
        domains,
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
