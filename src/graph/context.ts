import type { Graph, BM25Index, RankedCluster } from "./types";
import { Tier, type Rule } from "../adapters/types";
import { queryGraph } from "./query";
import { searchIndex } from "./bm25";

// ── Default Domains ──

const DEFAULT_DOMAINS = ["verification", "delivery", "deployment"];

// ── Domain Detection from Text ──

export function detectDomains(text: string): string[] {
  const lower = text.toLowerCase();
  const domains = new Set<string>();

  if (/makefile|make rebuild|make test|test container|docker|podman|deploy|rebuild/.test(lower)) domains.add("deployment");
  if (/\bquinn\b|playwright|visual.*test|screenshot/.test(lower)) domains.add("ui-testing");
  if (/\biframe\b|page\.fill|page\.route|sso|login.*flow|scraper|browser.*context/.test(lower)) domains.add("browser");
  if (/security scan|security.*gate|security.*review|vulnerability|destructive/.test(lower)) domains.add("security");
  if (/spawn.*agent|agent.*spawn|worktree|pre-brief|handoff|delegate/.test(lower)) domains.add("delegation");
  if (/escalat|bring in.*specialist|wrong approach|stuck/.test(lower)) domains.add("escalation");
  if (/\bprd\b|\bisc\b|algorithm.*phase|effort level/.test(lower)) domains.add("algorithm");
  if (/feedback_.*\.md|memory\.md|ratings\.jsonl|learning capture/.test(lower)) domains.add("memory");
  if (/minimal.*scope|only.*asked|unrequested|stay.*focused/.test(lower)) domains.add("scope");
  if (/false.*complet|partial.*deliver|incomplete|not.*done|self.audit/.test(lower)) domains.add("delivery");
  if (/response.*format|output.*format|terse.*response/.test(lower)) domains.add("communication");
  if (/actual.*data|live.*data|measure.*before|read.*before.*plan/.test(lower)) domains.add("data");
  if (/verify|check.*before|read.*before.*answer|look.*before|source.*first/.test(lower)) domains.add("verification");

  return domains.size > 0 ? Array.from(domains) : [];
}

// ── Get Context Rules ──

export function getContextRules(
  graph: Graph,
  index: BM25Index,
  currentDomains: string[],
  limit: number = 10,
): Rule[] {
  const domains = currentDomains.length > 0 ? currentDomains : DEFAULT_DOMAINS;

  // Graph query for domain-matched clusters
  const clusters: RankedCluster[] = queryGraph(graph, domains, limit);

  // Optionally boost with BM25 keyword search
  const queryText = domains.join(" ");
  const bm25Results = searchIndex(index, queryText, limit);
  const bm25Ids = new Set(bm25Results.map(r => r.id));

  // Merge: graph-first, BM25 fills gaps
  const resultIds = new Set<string>();
  const rules: Rule[] = [];

  for (const cluster of clusters) {
    if (rules.length >= limit) break;
    const node = cluster.primary;
    if (resultIds.has(node.id)) continue;
    resultIds.add(node.id);

    rules.push({
      id: node.id,
      text: node.description || node.name,
      tier: Tier.Graph,
      tags: node.domains,
      created: node.last_updated,
      correlationScore: cluster.score,
      sourceSignals: [],
      schemaVersion: 1,
    });
  }

  // Fill remaining slots from BM25 results not already in graph results
  for (const result of bm25Results) {
    if (rules.length >= limit) break;
    if (resultIds.has(result.id)) continue;
    resultIds.add(result.id);

    const node = graph.nodes[result.id];
    rules.push({
      id: result.id,
      text: node?.description || node?.name || result.id,
      tier: Tier.Graph,
      tags: node?.domains || [],
      created: node?.last_updated || new Date().toISOString(),
      correlationScore: result.score,
      sourceSignals: [],
      schemaVersion: 1,
    });
  }

  return rules;
}
