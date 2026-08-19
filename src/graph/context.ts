/**
 * context.ts — Session-start context injection + reranking
 *
 * Consolidated from:
 *   - PAI hooks/GraphContext.hook.ts — domain detection, rule cluster injection
 *   - PAI hooks/lib/learning-readback.ts — read learnings back into context
 *   - PAI Tools/VoyageReranker.ts — optional reranking of candidates
 */

import type { Graph, BM25Index, DocEntry, VocabEntry } from "./types";
import { Tier, type Rule, type EmbeddingProvider } from "../adapters/types";
import { loadConfig } from "../adapters/paths";
import { searchIndex, tokenize } from "./bm25";
import { queryTrajectoriesSync } from "../detect/trajectories";
import { hybridRetrieve, type RRFWeights } from "./retrieval";
import { loadVectorCache, rankByVectorSimilarity } from "./embeddings";
import { cosine } from "./embedder";
import { loadPatterns, loadHybridPatterns } from "./generate-patterns";
import type { DomainPattern } from "./generate-patterns";
import { shouldEvict, loadEvictionAllowlist, appendEvictionLog, loadEvictedRegistry, addToEvictedRegistry, type EvictionTrigger } from "../promote/auto-eviction";
import { getFilteredRuleIds, transitionRule } from "../promote/lifecycle";
import { loadRuleStats, type RuleStats } from "../promote/rules";

// ── Default Domains ──

const _cfg = loadConfig();
const DEFAULT_DOMAINS = _cfg.thresholds?.defaultDomains ?? ["testing", "delivery", "process"];

// ── Domain Detection from Text ──

let _detectPatterns: Array<{ re: RegExp; domain: string }> | null = null;
let _hybridPatterns: DomainPattern[] | null = null;

function getDetectPatterns(): Array<{ re: RegExp; domain: string }> {
  if (_detectPatterns) return _detectPatterns;
  const loaded = loadPatterns();
  _detectPatterns = loaded.map(p => ({
    re: new RegExp(p.pattern, "i"),
    domain: p.domain,
  }));
  return _detectPatterns;
}

export function initHybridDetection(graph: Graph): void {
  _hybridPatterns = loadHybridPatterns(graph);
  _detectPatterns = null;
}

export function resetDetectPatterns(): void {
  _detectPatterns = null;
  _hybridPatterns = null;
}

function passesConfidenceGate(text: string, augTerms: string[]): boolean {
  const lower = text.toLowerCase();
  let distinctMatches = 0;
  let totalHits = 0;

  for (const term of augTerms) {
    const termLower = term.toLowerCase();
    const isBigram = term.includes(" ");
    if (lower.includes(termLower)) {
      distinctMatches++;
      let idx = 0;
      while ((idx = lower.indexOf(termLower, idx)) !== -1) {
        totalHits++;
        idx += termLower.length;
      }
      if (isBigram) return true;
    }
  }

  if (distinctMatches >= 2) return true;
  if (totalHits >= 3) return true;
  return false;
}

export function detectDomains(text: string): string[] {
  const lower = text.toLowerCase();
  const domains = new Set<string>();
  for (const { re, domain } of getDetectPatterns()) {
    if (re.test(lower)) domains.add(domain);
  }

  if (_hybridPatterns) {
    for (const p of _hybridPatterns) {
      if (domains.has(p.domain)) continue;
      if (p.augmentedTerms && passesConfidenceGate(text, p.augmentedTerms)) {
        domains.add(p.domain);
      }
    }
  }

  return domains.size > 0 ? Array.from(domains) : [];
}

// ── BM25-based Domain Detection ──

import seedData from "./domain-seeds.json";

let _domainBM25Index: BM25Index | null = null;

function getDomainBM25Index(): BM25Index {
  if (_domainBM25Index) return _domainBM25Index;

  const docs: DocEntry[] = [];
  for (const entry of seedData.patterns) {
    const termText = entry.terms.join(" ");
    const tokens = tokenize(termText);
    const counts: Record<string, number> = {};
    for (const t of tokens) counts[t] = (counts[t] || 0) + 1;
    docs.push({ id: entry.domain, tokens: counts, len: tokens.length });
  }

  const N = docs.length;
  const avgDocLen = N > 0 ? docs.reduce((sum, d) => sum + d.len, 0) / N : 0;
  const df: Record<string, number> = {};
  for (const doc of docs) {
    for (const term of Object.keys(doc.tokens)) {
      df[term] = (df[term] || 0) + 1;
    }
  }
  const vocabulary: Record<string, VocabEntry> = {};
  for (const [term, dfVal] of Object.entries(df)) {
    const idf = Math.log((N - dfVal + 0.5) / (dfVal + 0.5) + 1);
    vocabulary[term] = { idf, df: dfVal };
  }

  _domainBM25Index = { builtAt: new Date().toISOString(), docCount: N, avgDocLen, vocabulary, docs };
  return _domainBM25Index;
}

export function detectDomainsBM25(text: string): string[] {
  const index = getDomainBM25Index();
  const results = searchIndex(index, text, 16);
  if (results.length === 0) return [];

  const topScore = results[0].score;
  const threshold = topScore * 0.3;
  const filtered = results.filter(r => r.score >= threshold);
  return filtered.slice(0, 3).map(r => r.id);
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

// ── Embedding Seed Retrieval ──

export type RetrievalStrategy = "current" | "embeddings";

export function retrieveByEmbeddingSeed(
  queryText: string,
  graph: Graph,
  index: BM25Index,
  vectorCache: Map<string, number[]>,
  limit: number,
): Rule[] {
  if (vectorCache.size === 0) return [];

  const bm25Results = searchIndex(index, queryText, 5);
  if (bm25Results.length === 0) return [];

  const seedIds = bm25Results.map(r => r.id);
  const seedVectors: number[][] = [];
  for (const id of seedIds) {
    const v = vectorCache.get(id);
    if (v) seedVectors.push(v);
  }
  if (seedVectors.length === 0) return [];

  const candidateScores = new Map<string, number[]>();
  for (const seedVec of seedVectors) {
    const neighbors = rankByVectorSimilarity(seedVec, vectorCache, 10);
    for (const n of neighbors) {
      if (!candidateScores.has(n.id)) candidateScores.set(n.id, []);
      candidateScores.get(n.id)!.push(n.score);
    }
  }

  const scored = Array.from(candidateScores.entries())
    .map(([id, scores]) => ({
      id,
      avgCosine: scores.reduce((a, b) => a + b, 0) / scores.length,
    }))
    .sort((a, b) => b.avgCosine - a.avgCosine);

  const ALLOWED_TYPES = new Set(["feedback", "steering", "success", "learned"]);
  const INDEX_NODE_PATTERN = /^(MEMORY|README|INDEX)$/i;

  const rules: Rule[] = [];
  for (const entry of scored) {
    if (rules.length >= limit) break;
    if (INDEX_NODE_PATTERN.test(entry.id)) continue;
    const node = graph.nodes[entry.id];
    if (!node) continue;
    const t = node.type;
    if (t && !ALLOWED_TYPES.has(t)) continue;

    rules.push({
      id: entry.id,
      text: sanitizeRuleText(node.description || node.name || entry.id),
      tier: Tier.Graph,
      tags: node.domains || [],
      created: node.last_updated || new Date().toISOString(),
      correlationScore: entry.avgCosine,
      domainSource: node.domainSource,
      sourceSignals: [],
      schemaVersion: 1,
    });
  }

  return rules;
}

// ── Get Context Rules ──

export async function getContextRules(
  graph: Graph,
  index: BM25Index,
  currentDomains: string[],
  limit: number = 10,
  signalDir?: string,
  queryText?: string,
  vectorCachePath?: string,
  embeddingProvider?: EmbeddingProvider,
  rrfWeights?: RRFWeights,
): Promise<Rule[]> {
  const domains = currentDomains.length > 0 ? currentDomains : DEFAULT_DOMAINS;

  // 1. Hybrid retrieval — BM25 + vector + domain-scored graph via RRF
  const fetchLimit = Math.max(limit * 3, 30);
  const searchText = queryText || domains.join(" ");

  let vectorList: Array<{ id: string; rank: number }> | undefined;
  if (vectorCachePath && embeddingProvider) {
    const cache = loadVectorCache(vectorCachePath);
    if (cache && cache.size > 0) {
      const [queryVec] = await embeddingProvider.embed([searchText]);
      if (queryVec) {
        const vectorResults = rankByVectorSimilarity(queryVec, cache, fetchLimit);
        vectorList = vectorResults.map((r, i) => ({ id: r.id, rank: i + 1 }));
      }
    }
  }

  let candidates = hybridRetrieve(searchText, domains, graph, index, fetchLimit, vectorList, rrfWeights);

  // Fallback: if hybrid returns nothing (no domain matches + no BM25 hits), use BM25-only
  if (candidates.length === 0) {
    const bm25Results = searchIndex(index, searchText, fetchLimit);
    candidates = bm25Results.map((r, i) => ({
      id: r.id,
      rrfScore: r.score,
      bm25Rank: i + 1,
    }));
  }

  // 2. Apply node-type weighting
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

  const scored = candidates
    .map(c => [c.id, c.rrfScore * nodeTypeWeight(c.id)] as [string, number])
    .sort((a, b) => b[1] - a[1]);

  // 2b. Per-domain diversity cap — prevent any single domain from taking all slots
  const domainSet = new Set<string>();
  for (const [id] of scored) {
    const d = graph.nodes[id]?.domains[0];
    if (d) domainSet.add(d);
  }
  const distinctDomains = Math.max(domainSet.size, 1);
  const perDomainCap = Math.ceil(limit / distinctDomains);

  const ranked: Array<[string, number]> = [];
  const domainSlots: Record<string, number> = {};
  for (const entry of scored) {
    if (ranked.length >= limit) break;
    const d = graph.nodes[entry[0]]?.domains[0] || "_none";
    const used = domainSlots[d] || 0;
    if (used >= perDomainCap) continue;
    domainSlots[d] = used + 1;
    ranked.push(entry);
  }

  // 3. Type-allowlist — defense-in-depth filter
  const ALLOWED_TYPES = new Set(["feedback", "steering", "success", "learned"]);
  const INDEX_NODE_PATTERN = /^(MEMORY|README|INDEX)$/i;
  const filtered = ranked.filter(([id]) => {
    if (INDEX_NODE_PATTERN.test(id)) return false;
    const t = graph.nodes[id]?.type;
    if (!t) return true;
    return ALLOWED_TYPES.has(t);
  });

  // 4. Auto-eviction filter — exclude low-value rules from injection
  let suppressedIds: Set<string>;
  try {
    const lifecyclePath = join(stateDir(), "rule-lifecycle.json");
    if (existsSync(lifecyclePath)) {
      suppressedIds = getFilteredRuleIds(["evicted", "graduated"]);
    } else {
      suppressedIds = loadEvictedRegistry();
    }
  } catch {
    suppressedIds = loadEvictedRegistry();
  }
  const afterRegistryFilter = filtered.filter(([id]) => !suppressedIds.has(id));

  const ruleStatsMap = loadRuleStats();
  const allowlist = loadEvictionAllowlist();
  const newlyEvicted: Array<{ id: string; eviction: { trigger: EvictionTrigger; reason: string }; stats: RuleStats }> = [];
  const afterEviction = afterRegistryFilter.filter(([id]) => {
    const stats = ruleStatsMap.get(id);
    if (!stats) return true;
    const eviction = shouldEvict(stats, allowlist);
    if (eviction) {
      newlyEvicted.push({ id, eviction, stats });
      return false;
    }
    return true;
  });

  for (const { id, eviction, stats } of newlyEvicted) {
    addToEvictedRegistry({ ruleId: id, trigger: eviction.trigger, reason: eviction.reason });
    transitionRule(id, "evicted", eviction.reason, "context-refresh-inline");
    appendEvictionLog({
      ruleId: id,
      trigger: eviction.trigger,
      reason: eviction.reason,
      avgRating: stats.avgCorrelatedRating,
      injections: stats.injectionCount,
      highActivations: stats.highRatingActivations,
      lowActivations: stats.lowRatingActivations,
      timestamp: new Date().toISOString(),
    });
  }

  // 5. Build rule objects
  const resultIds = new Set<string>();
  const rules: Rule[] = [];

  for (const [id, score] of afterEviction) {
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

  // 6. Trajectory backfill
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
import { execSync } from "child_process";
import { dirname, join } from "path";
import { stateDir, statePath } from "../adapters/paths";

const SESSION_CONTEXT_FILE = "session-context.json";
const SESSION_HISTORY_FILE = "session-context-history.jsonl";
const SESSION_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;

export interface SessionContext {
  ruleIds: string[];
  rules?: Array<{ id: string; text: string }>;
  domains: string[];
  domain_source: "metadata" | "keyword" | "bm25";
  timestamp: string;
  ttl: number;
  rulesInjectedCount: number;
  rulesInjectedKB: number;
  totalContextLines: number;
  toolCallPatterns?: string[];
  filePathsTouched?: string[];
}

export function writeSessionContext(
  rules: Rule[],
  domains: string[],
  domainSource: "metadata" | "keyword" | "bm25" = "keyword",
  totalContextLines: number = 0,
  extra?: { toolCallPatterns?: string[]; filePathsTouched?: string[] },
): void {
  const filePath = statePath(SESSION_CONTEXT_FILE);
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const rulesInjectedCount = rules.length;
  const rulesInjectedKB = Math.round((JSON.stringify(rules).length / 1024) * 10) / 10;

  const context: SessionContext = {
    ruleIds: rules.map((r) => r.id),
    rules: rules.map((r) => ({ id: r.id, text: r.text })),
    domains,
    domain_source: domainSource,
    timestamp: new Date().toISOString(),
    ttl: SESSION_CONTEXT_TTL_MS,
    rulesInjectedCount,
    rulesInjectedKB,
    totalContextLines,
    ...(extra?.toolCallPatterns && { toolCallPatterns: extra.toolCallPatterns }),
    ...(extra?.filePathsTouched && { filePathsTouched: extra.filePathsTouched }),
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

export function computeRelevanceScore(ruleText: string, sessionContext: SessionContext): number {
  const ruleWords = new Set(
    ruleText.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 3),
  );
  if (ruleWords.size === 0) return 0;

  const contextWords = new Set<string>();
  for (const src of [
    sessionContext.toolCallPatterns ?? [],
    sessionContext.filePathsTouched ?? [],
    sessionContext.domains,
  ]) {
    for (const item of src) {
      for (const w of item.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
        if (w.length > 3) contextWords.add(w);
      }
    }
  }
  if (contextWords.size === 0) return 0;

  let intersection = 0;
  for (const w of ruleWords) {
    if (contextWords.has(w)) intersection++;
  }
  const union = new Set([...ruleWords, ...contextWords]).size;
  return union === 0 ? 0 : intersection / union;
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

// ── Performance Summary ──

export interface PerformanceSummary {
  today_avg: number | null;
  week_avg: number | null;
  month_avg: number | null;
  trend: "improving" | "declining" | "stable";
  total_signals: number;
}

export async function computePerformanceSummary(signalDir: string): Promise<PerformanceSummary | null> {
  const ratingsPath = join(signalDir, "ratings.jsonl");
  if (!existsSync(ratingsPath)) return null;
  const raw = readFileSync(ratingsPath, "utf-8");
  const lines = raw.split("\n").filter(l => l.trim());
  if (lines.length === 0) return null;

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const todayRatings: number[] = [];
  const weekRatings: number[] = [];
  const monthRatings: number[] = [];
  let totalRatings = 0;

  for (const line of lines) {
    try {
      const s = JSON.parse(line);
      if (typeof s.rating !== "number") continue;
      totalRatings++;
      const ts = new Date(s.timestamp);
      if (ts >= todayStart) todayRatings.push(s.rating);
      if (ts >= weekAgo) weekRatings.push(s.rating);
      if (ts >= monthAgo) monthRatings.push(s.rating);
    } catch { /* skip malformed */ }
  }

  if (totalRatings === 0) return null;

  const avg = (arr: number[]) => arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length;
  const weekAvg = avg(weekRatings);
  const monthAvg = avg(monthRatings);

  let trend: "improving" | "declining" | "stable" = "stable";
  if (weekAvg !== null && monthAvg !== null) {
    if (weekAvg > monthAvg + 0.5) trend = "improving";
    else if (weekAvg < monthAvg - 0.5) trend = "declining";
  }

  return { today_avg: avg(todayRatings), week_avg: weekAvg, month_avg: monthAvg, trend, total_signals: totalRatings };
}

// ── Failure Patterns ──

export async function getRecentFailurePatterns(signalDir: string, limit: number = 5): Promise<string[]> {
  const filePath = join(signalDir, "incidents.jsonl");
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter(l => l.trim());

  const records: Array<{ error_type: string }> = [];
  for (const line of lines) {
    try { records.push(JSON.parse(line)); } catch { /* skip */ }
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (let i = records.length - 1; i >= 0; i--) {
    const et = records[i].error_type;
    if (!et || seen.has(et)) continue;
    seen.add(et);
    unique.push(et);
    if (unique.length >= limit) break;
  }
  return unique;
}

// ── Work Context Domains ──

const EXT_DOMAIN_MAP: Record<string, string> = {
  ".tsx": "frontend", ".jsx": "frontend", ".css": "frontend", ".scss": "frontend",
  ".vue": "frontend", ".svelte": "frontend",
  ".sql": "database", ".prisma": "database",
  ".ts": "code", ".js": "code", ".py": "code", ".go": "code", ".rs": "code",
  ".md": "documentation",
  ".yaml": "config", ".yml": "config", ".json": "config", ".toml": "config",
  ".dockerfile": "infrastructure", ".tf": "infrastructure",
};

export async function getWorkContextDomains(signalDir: string): Promise<string[]> {
  const filePath = join(signalDir, "work-completions.jsonl");
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter(l => l.trim());
  if (lines.length === 0) return [];

  let latest: { files_changed?: string[] } | null = null;
  for (const line of lines) {
    try { latest = JSON.parse(line); } catch { /* skip */ }
  }

  if (!latest?.files_changed || latest.files_changed.length === 0) return [];

  const domains = new Set<string>();
  for (const file of latest.files_changed) {
    if (/\.test\.[tj]sx?$/.test(file) || /\.spec\.[tj]sx?$/.test(file)) {
      domains.add("testing");
      continue;
    }
    const extMatch = file.match(/(\.[^./]+)$/);
    if (extMatch) {
      const domain = EXT_DOMAIN_MAP[extMatch[1]];
      if (domain) domains.add(domain);
    }
  }
  return Array.from(domains);
}

// ── Git Status Domain Detection ──

const PATH_DOMAIN_MAP: Array<{ pattern: RegExp; domain: string }> = [
  { pattern: /src\/graph\//, domain: "graph" },
  { pattern: /src\/capture\//, domain: "algorithm" },
  { pattern: /src\/daemon\//, domain: "data" },
  { pattern: /src\/detect\//, domain: "algorithm" },
  { pattern: /src\/adapters\//, domain: "architecture" },
  { pattern: /bin\/commands\//, domain: "delegation" },
  { pattern: /test\//, domain: "testing" },
  { pattern: /hooks\//, domain: "deployment" },
  { pattern: /\.tsx?$/, domain: "code" },
  { pattern: /\.md$/, domain: "documentation" },
  { pattern: /\.json$/, domain: "config" },
];

export function detectDomainsFromGitStatus(): string[] {
  try {
    const output = execSync("git status --short", {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    if (!output) return [];

    const domains = new Set<string>();
    for (const line of output.split("\n")) {
      const filePath = line.slice(3).trim();
      for (const { pattern, domain } of PATH_DOMAIN_MAP) {
        if (pattern.test(filePath)) {
          domains.add(domain);
          break;
        }
      }
    }
    return Array.from(domains);
  } catch {
    return [];
  }
}

// ── Smart Defaults from Session History ──

export function computeSmartDefaults(signalDir: string): string[] {
  const historyPath = join(dirname(signalDir), "state", "session-context-history.jsonl");
  if (!existsSync(historyPath)) return [];

  const lines = readFileSync(historyPath, "utf-8").split("\n").filter(l => l.trim());
  const recentLines = lines.slice(-20);
  const domainCounts: Record<string, number> = {};

  for (const line of recentLines) {
    try {
      const session = JSON.parse(line) as { domains?: string[] };
      if (!session.domains) continue;
      for (const d of session.domains) {
        domainCounts[d] = (domainCounts[d] || 0) + 1;
      }
    } catch { /* skip */ }
  }

  return Object.entries(domainCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([d]) => d);
}

// ── Graph Context Formatter ──

export function formatGraphContext(
  rules: Rule[],
  domains: string[],
): string {
  const timestamp = new Date().toISOString();
  const lines: string[] = [
    `# Graph Context — ${domains.join(", ")}`,
    `*Generated: ${timestamp} | ${rules.length} context rules from [${domains.join(", ")}]*`,
    "",
    "## Context Rules (correlation-ranked)",
    "",
  ];

  for (const rule of rules) {
    const tag = rule.tags[0] || "general";
    const score = rule.correlationScore?.toFixed(2) ?? "0.00";
    lines.push(`- **${rule.id}** [${tag}] (score: ${score})`);
    lines.push(`  ${rule.text}`);
    lines.push("");
  }

  return lines.join("\n");
}
