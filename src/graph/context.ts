/**
 * context.ts — Session-start context injection + reranking
 *
 * Consolidated from:
 *   - PAI hooks/GraphContext.hook.ts — domain detection, rule cluster injection
 *   - PAI hooks/lib/learning-readback.ts — read learnings back into context
 *   - PAI Tools/VoyageReranker.ts — optional reranking of candidates
 */

import type { Graph, BM25Index } from "./types";
import { Tier, type Rule, type EmbeddingProvider } from "../adapters/types";
import { loadConfig } from "../adapters/paths";
import { searchIndex, tokenize } from "./bm25";
import { queryTrajectoriesSync } from "../detect/trajectories";
import { loadVectorCache, computeCentroid, rankByVectorSimilarity } from "./embeddings";
import { rrfMerge, RRF_WEIGHTS } from "./retrieval";

// ── Default Domains ──

const _cfg = loadConfig();
const DEFAULT_DOMAINS = _cfg.thresholds?.defaultDomains ?? ["verification", "delivery", "deployment"];

// ── Domain Detection from Text ──

export function detectDomains(text: string): string[] {
  const lower = text.toLowerCase();
  const domains = new Set<string>();

  if (/makefile|make rebuild|make test|test container|docker|podman|deploy|rebuild/.test(lower)) domains.add("deployment");
  if (/\bquinn\b|playwright|visual.*test|screenshot/.test(lower)) domains.add("ui-testing");
  if (/\biframe\b|page\.fill|page\.route|sso|login.*flow|scraper|browser.*context/.test(lower)) domains.add("browser");
  if (/security scan|security.*gate|security.*review|vulnerability|destructive/.test(lower)) domains.add("security");
  if (/spawn.*agent|agent.*spawn|worktree|pre-brief|handoff|delegate|marcus|brief.*template/.test(lower)) domains.add("delegation");
  if (/escalat|bring in.*specialist|wrong approach|stuck/.test(lower)) domains.add("escalation");
  if (/\bprd\b|\bisc\b|algorithm.*phase|effort level/.test(lower)) domains.add("algorithm");
  if (/feedback_.*\.md|memory\.md|ratings\.jsonl|learning capture/.test(lower)) domains.add("memory");
  if (/minimal.*scope|only.*asked|unrequested|stay.*focused/.test(lower)) domains.add("scope");
  if (/false.*complet|partial.*deliver|incomplete|not.*done|self.audit|\bship\b|acceptance.*criter|template.*ac|github.*issue/.test(lower)) domains.add("delivery");
  if (/response.*format|output.*format|terse.*response/.test(lower)) domains.add("communication");
  if (/actual.*data|live.*data|measure.*before|read.*before.*plan/.test(lower)) domains.add("data");
  if (/verify|check.*before|read.*before.*answer|look.*before|source.*first/.test(lower)) domains.add("verification");

  return domains.size > 0 ? Array.from(domains) : [];
}

// ── Sanitize Rule Text ──

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/gi,
  /you\s+are\s+now\s+/gi,
  /act\s+as\s+(a\s+)?/gi,
  /system\s*:\s*/gi,
  /\[INST\]/gi,
  /<<SYS>>/gi,
  /<\|im_start\|>/gi,
];

export function sanitizeRuleText(text: string): string {
  let sanitized = text;
  for (const p of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(p, "");
  }
  return sanitized.trim();
}

// ── Get Context Rules ──

const EXPANSION_RELS = new Set(["reinforces", "sibling", "caused_by_same_root", "same_domain", "co_occurred"]);
const EXPANSION_DECAY = _cfg.thresholds?.expansionDecay ?? 0.5;

export async function getContextRules(
  graph: Graph,
  index: BM25Index,
  currentDomains: string[],
  limit: number = 10,
  signalDir?: string,
  queryText?: string,
  vectorCachePath?: string,
  embeddingProvider?: EmbeddingProvider,
): Promise<Rule[]> {
  const domains = currentDomains.length > 0 ? currentDomains : DEFAULT_DOMAINS;

  // 1. BM25 primary — retrieve 3x candidates
  const fetchLimit = Math.max(limit * 3, 30);
  const searchText = queryText || domains.join(" ");
  const bm25Results = searchIndex(index, searchText, fetchLimit);

  // 2. Vector retrieval — real query embedding when provider available, centroid fallback
  let vectorScores: Array<{ id: string; score: number }> | null = null;
  if (vectorCachePath) {
    const cache = loadVectorCache(vectorCachePath);
    if (cache && cache.size > 0) {
      if (embeddingProvider) {
        const [queryVec] = await embeddingProvider.embed([searchText]);
        vectorScores = rankByVectorSimilarity(queryVec, cache, fetchLimit);
      } else {
        const topBm25Ids = bm25Results.slice(0, 5).map(r => r.id);
        const centroid = computeCentroid(topBm25Ids, cache);
        if (centroid) {
          vectorScores = rankByVectorSimilarity(centroid, cache, fetchLimit);
        }
      }
    }
  }

  // 3. Graph expansion — for each BM25 hit, expand 1-hop via edges
  const scores = new Map<string, number>();

  // Precompute edge counts for hub-dampening
  const edgeCounts = new Map<string, number>();
  for (const edge of graph.edges) {
    edgeCounts.set(edge.from, (edgeCounts.get(edge.from) || 0) + 1);
    edgeCounts.set(edge.to, (edgeCounts.get(edge.to) || 0) + 1);
  }

  for (const hit of bm25Results) {
    scores.set(hit.id, Math.max(scores.get(hit.id) || 0, hit.score));

    const node = graph.nodes[hit.id];
    if (!node) continue;

    for (const edge of graph.edges) {
      if (!EXPANSION_RELS.has(edge.relationship)) continue;
      let neighborId: string | null = null;
      if (edge.from === hit.id) neighborId = edge.to;
      else if (edge.to === hit.id) neighborId = edge.from;
      if (!neighborId || !graph.nodes[neighborId]) continue;

      let expandedScore = hit.score * EXPANSION_DECAY;
      // Hub-dampening: suppress high-connectivity nodes
      const nEdges = edgeCounts.get(neighborId) || 0;
      if (nEdges >= 10) {
        expandedScore *= 1 / Math.log2(nEdges);
      }
      scores.set(neighborId, Math.max(scores.get(neighborId) || 0, expandedScore));
    }
  }

  // 4. 3-way RRF merge when vectors available, otherwise score-based ranking
  const NODE_TYPE_WEIGHT: Record<string, number> = {
    feedback: 1.0,
    steering: 1.0,
    success: 0.8,
    project: 0.3,
    reference: 0.5,
  };
  function nodeTypeWeight(id: string): number {
    const prefix = id.split("_")[0];
    return NODE_TYPE_WEIGHT[prefix] ?? 1.0;
  }

  let ranked: Array<[string, number]>;

  if (vectorScores) {
    const bm25List = bm25Results.map((r, i) => ({ id: r.id, rank: i + 1 }));
    const graphList = Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([id], i) => ({ id, rank: i + 1 }));
    const vectorList = vectorScores.map((r, i) => ({ id: r.id, rank: i + 1 }));

    const merged = rrfMerge(bm25List, graphList, vectorList, RRF_WEIGHTS);
    ranked = Array.from(merged.values())
      .map(e => ({ ...e, score: e.score * nodeTypeWeight(e.id) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(e => [e.id, e.score] as [string, number]);
  } else {
    ranked = Array.from(scores.entries())
      .map(([id, s]) => [id, s * nodeTypeWeight(id)] as [string, number])
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);
  }

  // 5. Type-allowlist — defense-in-depth filter
  const ALLOWED_TYPES = new Set(["feedback", "steering", "success", "learned"]);
  const INDEX_NODE_PATTERN = /^(MEMORY|README|INDEX)$/i;
  const filtered = ranked.filter(([id]) => {
    if (INDEX_NODE_PATTERN.test(id)) return false;
    const t = graph.nodes[id]?.type;
    if (!t) return true;
    return ALLOWED_TYPES.has(t);
  });

  // 6. Build rule objects
  const resultIds = new Set<string>();
  const rules: Rule[] = [];

  for (const [id, score] of filtered) {
    resultIds.add(id);
    const node = graph.nodes[id];

    rules.push({
      id,
      text: sanitizeRuleText(node?.description || node?.name || id),
      tier: Tier.Graph,
      tags: node?.domains || [],
      created: node?.last_updated || new Date().toISOString(),
      correlationScore: score,
      domainSource: node?.domainSource,
      sourceSignals: [],
      schemaVersion: 1,
    });
  }

  // 7. Trajectory backfill
  if (signalDir && rules.length < limit) {
    const remaining = limit - rules.length;
    const trajectories = queryTrajectoriesSync(domains, signalDir, remaining);
    for (const t of trajectories) {
      if (rules.length >= limit) break;
      if (resultIds.has(t.id)) continue;
      resultIds.add(t.id);
      rules.push({
        id: t.id,
        text: sanitizeRuleText(`[trajectory] ${t.summary}`),
        tier: Tier.Graph,
        tags: t.domains,
        created: t.timestamp,
        correlationScore: t.rating / 10,
        sourceSignals: [],
        schemaVersion: 1,
      });
    }
  }

  return rules;
}

// ── Learned Rules Filtering ──

export function parseLearnedRules(content: string): string[] {
  const rules: string[] = [];
  const lines = content.split("\n");
  let current = "";

  for (const line of lines) {
    if (line.startsWith("- **")) {
      if (current) rules.push(current.trim());
      current = line;
    } else if (current && line.startsWith("  ") && line.trim()) {
      current += "\n" + line;
    } else if (current && line.trim() === "") {
      // blank line ends a rule only if next non-blank isn't a continuation
    } else if (current && !line.startsWith("- **") && !line.startsWith("#") && line.trim()) {
      current += " " + line.trim();
    } else if (current) {
      rules.push(current.trim());
      current = "";
    }
  }
  if (current) rules.push(current.trim());

  return rules;
}

export function filterLearnedRules(rules: string[], queryText: string, topK: number = 10): string[] {
  if (rules.length === 0 || !queryText.trim()) return rules.slice(0, topK);
  if (rules.length <= topK) return rules;

  const queryTokens = tokenize(queryText);
  if (queryTokens.length === 0) return rules.slice(0, topK);

  const N = rules.length;
  const docs = rules.map((rule, i) => {
    const tokens = tokenize(rule);
    const counts: Record<string, number> = {};
    for (const t of tokens) counts[t] = (counts[t] || 0) + 1;
    return { id: String(i), tokens: counts, len: tokens.length };
  });

  const avgDocLen = docs.reduce((s, d) => s + d.len, 0) / N;

  const df: Record<string, number> = {};
  for (const doc of docs) {
    for (const term of Object.keys(doc.tokens)) {
      df[term] = (df[term] || 0) + 1;
    }
  }

  const K1 = 1.5;
  const B = 0.75;

  const scored = docs.map((doc, i) => {
    let score = 0;
    for (const term of queryTokens) {
      const termDf = df[term];
      if (!termDf) continue;
      const tf = doc.tokens[term] || 0;
      if (tf === 0) continue;
      const idf = Math.log((N - termDf + 0.5) / (termDf + 0.5) + 1);
      const tfNorm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (doc.len / avgDocLen)));
      score += idf * tfNorm;
    }
    return { index: i, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map(s => rules[s.index]);
}

// ── Session Context Attribution ──

import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { statePath } from "../adapters/paths";

const SESSION_CONTEXT_FILE = "session-context.json";
const SESSION_HISTORY_FILE = "session-context-history.jsonl";
const SESSION_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;

export interface SessionContext {
  ruleIds: string[];
  domains: string[];
  domain_source: "metadata" | "keyword" | "bm25";
  timestamp: string;
  ttl: number;
  rulesInjectedCount: number;
  rulesInjectedKB: number;
  totalContextLines: number;
}

export function writeSessionContext(rules: Rule[], domains: string[], domainSource: "metadata" | "keyword" | "bm25" = "keyword", totalContextLines: number = 0): void {
  const filePath = statePath(SESSION_CONTEXT_FILE);
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const rulesInjectedCount = rules.length;
  const rulesInjectedKB = Math.round((JSON.stringify(rules).length / 1024) * 10) / 10;

  const context: SessionContext = {
    ruleIds: rules.map((r) => r.id),
    domains,
    domain_source: domainSource,
    timestamp: new Date().toISOString(),
    ttl: SESSION_CONTEXT_TTL_MS,
    rulesInjectedCount,
    rulesInjectedKB,
    totalContextLines,
  };

  writeFileSync(filePath, JSON.stringify(context, null, 2), "utf-8");

  const historyPath = statePath(SESSION_HISTORY_FILE);
  appendFileSync(historyPath, JSON.stringify(context) + "\n", "utf-8");

  const historyContent = readFileSync(historyPath, "utf-8");
  const lines = historyContent.trimEnd().split("\n");
  if (lines.length > 1000) {
    writeFileSync(historyPath, lines.slice(-1000).join("\n") + "\n", "utf-8");
  }
}

export function readSessionContext(): SessionContext | null {
  const filePath = statePath(SESSION_CONTEXT_FILE);
  if (!existsSync(filePath)) return null;

  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as SessionContext;
    const age = Date.now() - new Date(raw.timestamp).getTime();
    if (age > raw.ttl) return null;
    return raw;
  } catch {
    return null;
  }
}

export function readSessionHistory(limit: number = 10): SessionContext[] {
  const filePath = statePath(SESSION_HISTORY_FILE);
  if (!existsSync(filePath)) return [];

  try {
    const lines = readFileSync(filePath, "utf-8").split("\n").filter((l) => l.trim());
    const entries: SessionContext[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as SessionContext);
      } catch { /* skip malformed */ }
    }
    return entries.slice(-limit);
  } catch {
    return [];
  }
}

// ── Learning Readback ──

interface LearningDigest {
  recentSignals: string[];
  failurePatterns: string[];
  themes: string[];
}

function getRecentLearnings(baseDir: string, subdir: string, count: number): string[] {
  const insights: string[] = [];
  const learningDir = join(baseDir, "learning", subdir);
  if (!existsSync(learningDir)) return insights;

  try {
    // Look for month directories sorted descending
    const months = readdirSync(learningDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name))
      .map((d) => d.name)
      .sort()
      .reverse();

    for (const month of months) {
      if (insights.length >= count) break;
      const monthPath = join(learningDir, month);
      try {
        const files = readdirSync(monthPath).filter((f) => f.endsWith(".md")).sort().reverse();
        for (const file of files) {
          if (insights.length >= count) break;
          try {
            const content = readFileSync(join(monthPath, file), "utf-8");
            const feedbackMatch = content.match(/\*\*Feedback:\*\*\s*(.+)/);
            const ratingMatch = content.match(/rating:\s*(\d+)/);
            if (feedbackMatch) {
              const rating = ratingMatch ? ratingMatch[1] : "?";
              insights.push(`[${rating}/10] ${feedbackMatch[1].substring(0, 80)}`);
            }
          } catch { /* skip unreadable */ }
        }
      } catch { /* skip unreadable month */ }
    }
  } catch { /* skip if dir fails */ }

  return insights;
}

export function loadLearningDigest(baseDir: string): LearningDigest {
  return {
    recentSignals: getRecentLearnings(baseDir, "algorithm", 5),
    failurePatterns: getRecentLearnings(baseDir, "failures", 3),
    themes: getRecentLearnings(baseDir, "system", 3),
  };
}

export function formatLearningContext(digest: LearningDigest): string | null {
  const parts: string[] = [];

  if (digest.recentSignals.length > 0) {
    parts.push("**Recent Signals:**");
    digest.recentSignals.forEach((s) => parts.push(`  ${s}`));
  }

  if (digest.failurePatterns.length > 0) {
    parts.push("**Failure Patterns:**");
    digest.failurePatterns.forEach((s) => parts.push(`  ${s}`));
  }

  if (digest.themes.length > 0) {
    parts.push("**Themes:**");
    digest.themes.forEach((s) => parts.push(`  ${s}`));
  }

  return parts.length > 0 ? parts.join("\n") : null;
}

// ── Reranking ──

export interface RerankCandidate {
  id: string;
  text: string;
}

export interface RerankResult {
  id: string;
  text: string;
  relevanceScore: number;
  originalIndex: number;
}

export interface Reranker {
  rerank(query: string, candidates: RerankCandidate[], topK?: number): Promise<RerankResult[]>;
}

/**
 * Create a reranker that uses Jina AI or Voyage AI reranking API.
 * Provider is auto-detected from environment variables.
 */
export function createReranker(apiKey: string, provider: "jina" | "voyage" = "jina"): Reranker {
  return {
    async rerank(query: string, candidates: RerankCandidate[], topK = 10): Promise<RerankResult[]> {
      const documents = candidates.map((c) => c.text);

      const url = provider === "jina"
        ? "https://api.jina.ai/v1/rerank"
        : "https://api.voyageai.com/v1/rerank";

      const model = provider === "jina"
        ? "jina-reranker-v2-base-multilingual"
        : "rerank-2-lite";

      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          query,
          documents,
          top_n: Math.min(topK, candidates.length),
        }),
      });

      if (!resp.ok) {
        throw new Error(`Rerank API ${resp.status}: ${await resp.text()}`);
      }

      const json = (await resp.json()) as {
        results?: Array<{ index: number; relevance_score: number }>;
        data?: Array<{ index: number; relevance_score: number }>;
      };

      const results = json.results || json.data || [];
      return results
        .sort((a, b) => b.relevance_score - a.relevance_score)
        .map((r) => ({
          id: candidates[r.index].id,
          text: candidates[r.index].text,
          relevanceScore: r.relevance_score,
          originalIndex: r.index,
        }));
    },
  };
}

/**
 * Get context rules with optional reranking.
 * First retrieves via graph + BM25, then optionally reranks with an API.
 */
export async function getContextRulesWithReranking(
  graph: Graph,
  index: BM25Index,
  currentDomains: string[],
  reranker: Reranker | null,
  query: string,
  limit: number = 10,
  vectorCachePath?: string,
  embeddingProvider?: EmbeddingProvider,
): Promise<Rule[]> {
  const rules = await getContextRules(graph, index, currentDomains, limit * 2, undefined, query, vectorCachePath, embeddingProvider);

  if (!reranker || rules.length === 0) {
    return rules.slice(0, limit);
  }

  const candidates = rules.map((r) => ({ id: r.id, text: r.text }));

  const reranked = await reranker.rerank(query, candidates, limit);
  const ruleMap = new Map(rules.map((r) => [r.id, r]));
  return reranked
    .map((r) => ruleMap.get(r.id))
    .filter((r): r is Rule => r !== undefined);
}
