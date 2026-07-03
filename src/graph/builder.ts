import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { createHash } from "crypto";
import { getBaseDir, stateDir } from "../adapters/paths";
import type { GraphNode, GraphEdge, Rule } from "../adapters/types";
import type { Graph } from "./types";

// ── Domain Taxonomy ──

const DOMAINS = [
  "verification", "escalation", "scope", "delivery", "communication",
  "deployment", "security", "ui-testing", "data", "browser",
  "memory", "algorithm", "delegation",
] as const;

type Domain = (typeof DOMAINS)[number];

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

export function keywordClassify(name: string, description: string, ruleText: string): string[] | null {
  const text = `${name} ${description} ${ruleText}`.toLowerCase();

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
          source: sorted[i].id,
          target: neighbor.id,
          type: "same_domain",
          strength: 0.5,
        });
        edgesForNode++;
      }
    }
  }

  return edges;
}

// ── Build Graph ──

export async function buildGraph(rulesDir: string, stateOutputDir?: string): Promise<Graph> {
  const files = discoverRuleFiles(rulesDir);
  const existingGraph = readGraph();

  const cachedHashes = new Map<string, { domains: string[]; hash: string }>();
  for (const node of Object.values(existingGraph.nodes)) {
    if (node.hash) {
      cachedHashes.set(node.id, { domains: node.domains, hash: node.hash });
    }
  }

  const nodes: Record<string, GraphNode> = {};

  for (const file of files) {
    const name = file.frontmatter["name"] || file.id;
    const description = file.frontmatter["description"] || "";
    const ruleText = file.content.replace(/^---[\s\S]*?---\n/, "");
    const hash = computeHash(ruleText.trim());

    const cached = cachedHashes.get(file.id);
    let domains: string[];
    if (cached && cached.hash === hash) {
      domains = cached.domains;
    } else {
      const classified = keywordClassify(name, description, ruleText);
      domains = classified || ["verification"];
    }

    nodes[file.id] = {
      id: file.id,
      name,
      domains,
      ruleText: ruleText.trim().slice(0, 500),
      hash,
      stats: {
        injectionCount: existingGraph.nodes[file.id]?.stats.injectionCount ?? 0,
        avgRating: existingGraph.nodes[file.id]?.stats.avgRating ?? 0,
        highRatingActivations: existingGraph.nodes[file.id]?.stats.highRatingActivations ?? 0,
        lowRatingActivations: existingGraph.nodes[file.id]?.stats.lowRatingActivations ?? 0,
        sessionRatings: existingGraph.nodes[file.id]?.stats.sessionRatings ?? [],
        lastSeen: existingGraph.nodes[file.id]?.stats.lastSeen ?? new Date().toISOString(),
      },
    };
  }

  const allEdges: GraphEdge[] = [];
  const edgeSeen = new Set<string>();

  // Restore cached inferred edges where both nodes are unchanged
  for (const edge of existingGraph.edges) {
    const sourceNode = nodes[edge.source];
    const targetNode = nodes[edge.target];
    if (!sourceNode || !targetNode) continue;

    const sourceCached = cachedHashes.get(edge.source);
    const targetCached = cachedHashes.get(edge.target);
    const sourceUnchanged = sourceCached && sourceNode.hash === sourceCached.hash;
    const targetUnchanged = targetCached && targetNode.hash === targetCached.hash;

    if (sourceUnchanged && targetUnchanged) {
      const key = [edge.source, edge.target].sort().join("::") + "::" + edge.type;
      if (!edgeSeen.has(key)) {
        edgeSeen.add(key);
        allEdges.push(edge);
      }
    }
  }

  // Same-domain edges
  const existingPairs = new Set(allEdges.map(e => [e.source, e.target].sort().join("::")));
  const domainEdges = buildSameDomainEdges(nodes, existingPairs);
  for (const edge of domainEdges) {
    const key = [edge.source, edge.target].sort().join("::") + "::" + edge.type;
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
        ruleText: rule.text.slice(0, 500),
        hash,
      };
      continue;
    }

    updated.nodes[rule.id] = {
      id: rule.id,
      name: rule.id,
      domains,
      ruleText: rule.text.slice(0, 500),
      hash,
      stats: {
        injectionCount: 0,
        avgRating: 0,
        highRatingActivations: 0,
        lowRatingActivations: 0,
        sessionRatings: [],
        lastSeen: new Date().toISOString(),
      },
    };

    // Connect to domain siblings
    const siblings = Object.values(updated.nodes).filter(
      n => n.id !== rule.id && n.domains.some(d => domains.includes(d)),
    );

    for (const sibling of siblings.slice(0, 4)) {
      const pairKey = [rule.id, sibling.id].sort().join("::");
      const exists = updated.edges.some(
        e => [e.source, e.target].sort().join("::") === pairKey,
      );
      if (!exists) {
        updated.edges.push({
          source: rule.id,
          target: sibling.id,
          type: "same_domain",
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
  pruned.edges = pruned.edges.filter(e => !staleSet.has(e.source) && !staleSet.has(e.target));
  pruned.nodeCount = Object.keys(pruned.nodes).length;
  pruned.edgeCount = pruned.edges.length;

  return pruned;
}
