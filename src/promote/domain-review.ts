import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { mkdtempSync, rmSync } from "fs";
import type { Graph, GraphNode, DocEntry, VocabEntry } from "../graph/types";
import { buildGraph, defaultRuleDomainsPath, loadRuleDomains, keywordClassify, DOMAINS } from "../graph/builder";
import { resolveMemoryDir } from "../adapters/paths";
import { tokenize, searchIndex } from "../graph/bm25";

export interface DomainReviewResult {
  ruleId: string;
  autoDomains: string[];
  inferredDomains: string[];
  agreement: number;
  status: "reviewed" | "disagreement" | "no-inference";
}

interface RuleDomainEntry {
  domains: string[];
  source: string;
}

const VALID_DOMAINS = new Set<string>(DOMAINS);

const KNOWN_PREFIXES = ["feedback_", "success_", "project_", "reference_"];

function normalizeId(id: string): string {
  let s = id;
  for (const pfx of KNOWN_PREFIXES) {
    if (s.startsWith(pfx)) { s = s.slice(pfx.length); break; }
  }
  return s.replace(/-/g, "_");
}

function computeAgreement(autoDomains: string[], inferredDomains: string[]): number {
  const validAuto = autoDomains.filter(d => VALID_DOMAINS.has(d));
  if (validAuto.length === 0) return 0;
  const matchCount = validAuto.filter(d => inferredDomains.includes(d)).length;
  return matchCount / validAuto.length;
}

function buildClassifiedIndex(nodes: Record<string, GraphNode>) {
  const docs: DocEntry[] = [];
  for (const node of Object.values(nodes)) {
    if (node.domains.length === 0) continue;
    const tokens = tokenize(`${node.name} ${node.description}`);
    const counts: Record<string, number> = {};
    for (const t of tokens) counts[t] = (counts[t] || 0) + 1;
    docs.push({ id: node.id, tokens: counts, len: tokens.length });
  }

  const N = docs.length;
  const avgDocLen = N > 0 ? docs.reduce((s, d) => s + d.len, 0) / N : 0;

  const df: Record<string, number> = {};
  for (const doc of docs) {
    for (const term of Object.keys(doc.tokens)) {
      df[term] = (df[term] || 0) + 1;
    }
  }

  const vocabulary: Record<string, VocabEntry> = {};
  for (const [term, dfVal] of Object.entries(df)) {
    vocabulary[term] = {
      idf: Math.log((N - dfVal + 0.5) / (dfVal + 0.5) + 1),
      df: dfVal,
    };
  }

  return { builtAt: new Date().toISOString(), docCount: N, avgDocLen, vocabulary, docs };
}

function inferViaBM25(ruleId: string, ruleText: string, graph: Graph): string[] {
  const index = buildClassifiedIndex(graph.nodes);
  if (index.docCount === 0) return [];

  const results = searchIndex(index, `${ruleId} ${ruleText}`, 5);
  if (results.length < 3) return [];

  const top3Domains = results
    .slice(0, 3)
    .map(r => graph.nodes[r.id]?.domains[0])
    .filter(Boolean) as string[];
  if (top3Domains.length < 3) return [];

  const domainCounts: Record<string, number> = {};
  for (const d of top3Domains) domainCounts[d] = (domainCounts[d] || 0) + 1;

  const majority = Object.entries(domainCounts).find(([, c]) => c >= 2);
  if (majority && VALID_DOMAINS.has(majority[0])) {
    return [majority[0]];
  }
  return [];
}

export function parseLearnedRules(content: string): Map<string, string> {
  const rules = new Map<string, string>();
  for (const line of content.split("\n")) {
    const match = line.match(/^- \*\*(.+?)(?:\s*\(from\s.*?\))?:\*\*\s*(.*)/);
    if (!match) continue;
    const name = match[1].trim();
    const text = match[2].trim();
    const kebabId = name
      .toLowerCase()
      .replace(/[_/]/g, " ")
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    rules.set(kebabId, text);

    const underscoreId = kebabId.replace(/-/g, "_");
    if (underscoreId !== kebabId) rules.set(underscoreId, text);
  }
  return rules;
}

function makeResult(
  ruleId: string,
  autoDomains: string[],
  inferredDomains: string[],
): DomainReviewResult {
  const agreement = computeAgreement(autoDomains, inferredDomains);
  return {
    ruleId,
    autoDomains,
    inferredDomains,
    agreement,
    status: agreement >= 0.5 ? "reviewed" : "disagreement",
  };
}

export function reviewDomains(
  ruleDomains: Record<string, RuleDomainEntry>,
  graph: Graph,
  learnedRulesText?: Map<string, string>,
): DomainReviewResult[] {
  const nodeByKey = new Map<string, GraphNode>();
  for (const node of Object.values(graph.nodes)) {
    nodeByKey.set(node.id, node);
    nodeByKey.set(normalizeId(node.id), node);
    if (node.name && node.name !== node.id) {
      nodeByKey.set(node.name, node);
      nodeByKey.set(normalizeId(node.name), node);
    }
  }

  const results: DomainReviewResult[] = [];

  for (const [ruleId, entry] of Object.entries(ruleDomains)) {
    if (entry.source === "reviewed") continue;

    const node = nodeByKey.get(ruleId)
      ?? nodeByKey.get(normalizeId(ruleId));

    if (node && node.domains.length > 0) {
      results.push(makeResult(ruleId, entry.domains, node.domains));
      continue;
    }

    const ruleText = learnedRulesText?.get(ruleId)
      ?? learnedRulesText?.get(normalizeId(ruleId));

    if (ruleText) {
      const keywordDomains = keywordClassify(ruleId, ruleText, ruleText);
      if (keywordDomains && keywordDomains.length > 0) {
        results.push(makeResult(ruleId, entry.domains, keywordDomains));
        continue;
      }

      const bm25Domains = inferViaBM25(ruleId, ruleText, graph);
      if (bm25Domains.length > 0) {
        results.push(makeResult(ruleId, entry.domains, bm25Domains));
        continue;
      }
    }

    results.push({
      ruleId,
      autoDomains: entry.domains,
      inferredDomains: [],
      agreement: 0,
      status: "no-inference",
    });
  }

  return results;
}

export async function runDomainReview(rulesDir?: string, ruleDomainsPath?: string): Promise<{
  results: DomainReviewResult[];
  promoted: number;
  disagreements: number;
  noInference: number;
  total: number;
}> {
  const memDir = rulesDir ?? resolveMemoryDir();
  const rdPath = ruleDomainsPath ?? defaultRuleDomainsPath();
  const ruleDomains = loadRuleDomains(rdPath);
  if (!ruleDomains) throw new Error(`Cannot load rule-domains.json from ${rdPath}`);

  const tempDir = mkdtempSync(join(tmpdir(), "agentgrit-domain-review-"));
  try {
    const graph = await buildGraph(memDir, tempDir, join(tempDir, "nonexistent.json"));

    let learnedRulesText: Map<string, string> | undefined;
    const learnedPath = join(homedir(), ".claude", "CLAUDE-LEARNED.md");
    if (existsSync(learnedPath)) {
      learnedRulesText = parseLearnedRules(readFileSync(learnedPath, "utf-8"));
    }

    const results = reviewDomains(ruleDomains.rules, graph, learnedRulesText);

    let promoted = 0;
    for (const result of results) {
      if (result.status === "reviewed" && ruleDomains.rules[result.ruleId]) {
        ruleDomains.rules[result.ruleId].source = "reviewed";
        promoted++;
      }
    }

    if (promoted > 0) {
      writeFileSync(rdPath, JSON.stringify(ruleDomains, null, 2) + "\n", "utf-8");
    }

    const disagreements = results.filter(r => r.status === "disagreement").length;
    const noInference = results.filter(r => r.status === "no-inference").length;
    const total = Object.keys(ruleDomains.rules).length;

    return { results, promoted, disagreements, noInference, total };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
