/**
 * context.ts — Session-start context injection + reranking
 *
 * Consolidated from:
 *   - PAI hooks/GraphContext.hook.ts — domain detection, rule cluster injection
 *   - PAI hooks/lib/learning-readback.ts — read learnings back into context
 *   - PAI Tools/VoyageReranker.ts — optional reranking of candidates
 */

import type { Graph, BM25Index } from "./types";
import { Tier, type Rule } from "../adapters/types";
import { searchIndex } from "./bm25";
import { queryTrajectoriesSync } from "../detect/trajectories";

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

const EXPANSION_RELS = new Set(["reinforces", "sibling", "caused_by_same_root", "same_domain", "co_occurred_in_failure"]);
const EXPANSION_DECAY = 0.5;

export function getContextRules(
  graph: Graph,
  index: BM25Index,
  currentDomains: string[],
  limit: number = 10,
  signalDir?: string,
  queryText?: string,
): Rule[] {
  const domains = currentDomains.length > 0 ? currentDomains : DEFAULT_DOMAINS;

  // 1. BM25 primary — retrieve 3x candidates
  const fetchLimit = Math.max(limit * 3, 30);
  const searchText = queryText || domains.join(" ");
  const bm25Results = searchIndex(index, searchText, fetchLimit);

  // 2. Graph expansion — for each BM25 hit, expand 1-hop via edges
  const scores = new Map<string, number>();

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

      const expandedScore = hit.score * EXPANSION_DECAY;
      scores.set(neighborId, Math.max(scores.get(neighborId) || 0, expandedScore));
    }
  }

  // 3. Sort by score, take top limit
  const ranked = Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  // 4. Build rule objects
  const resultIds = new Set<string>();
  const rules: Rule[] = [];

  for (const [id, score] of ranked) {
    resultIds.add(id);
    const node = graph.nodes[id];

    rules.push({
      id,
      text: node?.description || node?.name || id,
      tier: Tier.Graph,
      tags: node?.domains || [],
      created: node?.last_updated || new Date().toISOString(),
      correlationScore: score,
      sourceSignals: [],
      schemaVersion: 1,
    });
  }

  // 5. Trajectory backfill
  if (signalDir && rules.length < limit) {
    const remaining = limit - rules.length;
    const trajectories = queryTrajectoriesSync(domains, signalDir, remaining);
    for (const t of trajectories) {
      if (rules.length >= limit) break;
      if (resultIds.has(t.id)) continue;
      resultIds.add(t.id);
      rules.push({
        id: t.id,
        text: `[trajectory] ${t.summary}`,
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
}

export function writeSessionContext(rules: Rule[], domains: string[], domainSource: "metadata" | "keyword" | "bm25" = "keyword"): void {
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
  };

  writeFileSync(filePath, JSON.stringify(context, null, 2), "utf-8");

  const historyPath = statePath(SESSION_HISTORY_FILE);
  appendFileSync(historyPath, JSON.stringify(context) + "\n", "utf-8");
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
export function getContextRulesWithReranking(
  graph: Graph,
  index: BM25Index,
  currentDomains: string[],
  reranker: Reranker | null,
  query: string,
  limit: number = 10,
): Promise<Rule[]> {
  const rules = getContextRules(graph, index, currentDomains, limit * 2, undefined, query);

  if (!reranker || rules.length === 0) {
    return Promise.resolve(rules.slice(0, limit));
  }

  const candidates = rules.map((r) => ({ id: r.id, text: r.text }));

  return reranker.rerank(query, candidates, limit).then((reranked) => {
    const ruleMap = new Map(rules.map((r) => [r.id, r]));
    return reranked
      .map((r) => ruleMap.get(r.id))
      .filter((r): r is Rule => r !== undefined);
  });
}
