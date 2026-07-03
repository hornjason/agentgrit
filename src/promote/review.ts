/**
 * review.ts -- Weekly self-learning review and episodic consolidation
 *
 * Consolidates:
 *   LearningReview.ts       -- THE brain of the learning loop. Reads ratings,
 *                              detects recurring low-rating patterns via fuzzy-matching,
 *                              generates candidate rules, checks contradictions,
 *                              respects budget caps, promotes aged proposed rules,
 *                              identifies eviction candidates.
 *   EpisodicConsolidator.ts -- LLM-based episodic-to-semantic consolidation.
 *                              Bundles low-rated episodes, runs LLM critique to find
 *                              meta-patterns, proposes rules with graph-aware dedup.
 */

import { existsSync } from "fs";
import { join } from "path";
import type { Pattern, GraphNode, Rule } from "../adapters/types";
import { SCHEMA_VERSION } from "../adapters/types";
import type { InferenceFn, RuleStats } from "./rules";

// ── Review Result ──

export interface ReviewResult {
  patternsFound: number;
  candidatesProposed: number;
  skipped: number;
  candidates: Pattern[];
  scoreTrend: { avg: number; count: number; direction: "up" | "down" | "flat" };
}

// ── Contradiction Check Result ──

export interface ContradictionResult {
  contradicts: boolean;
  redundant: boolean;
  reason: string;
}

// ── Eviction Candidate ──

export interface EvictionCandidate {
  ruleId: string;
  reason: "low-rated" | "stale";
  avgRating?: number;
  injectionCount?: number;
  lastSeen?: string;
  preview: string;
}

// ── Episodic Consolidation Result ──

export interface ConsolidationResult {
  patternsFound: number;
  rulesProposed: number;
  duplicatesSkipped: number;
  proposals: Array<{
    patternName: string;
    failure: string;
    episodes: number;
    proposedRule: string;
  }>;
}

// ── Rating Entry (internal) ──

interface RatingEntry {
  timestamp: string;
  rating: number;
  sentimentSummary?: string;
  sentimentDetail?: string;
  responsePreview?: string;
  sessionId?: string;
  comment?: string;
}

// ── Text Utilities ──

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

export function wordOverlap(a: string, b: string): number {
  const tokA = tokenize(a);
  const tokB = tokenize(b);
  if (tokA.length === 0 || tokB.length === 0) return 0;
  const setB = new Set(tokB);
  const overlap = tokA.filter((w) => setB.has(w)).length;
  return overlap / Math.min(tokA.length, tokB.length);
}

function deriveRuleName(summaries: string[]): string {
  const stopwords = new Set([
    "the", "is", "at", "of", "on", "in", "to", "a", "an", "and", "or",
    "for", "was", "not", "but", "with", "this", "that", "from", "by",
    "it", "be", "are", "as", "do", "did", "has", "had", "have",
  ]);
  const freq = new Map<string, number>();
  for (const s of summaries) {
    for (const word of tokenize(s)) {
      if (!stopwords.has(word)) freq.set(word, (freq.get(word) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([w]) => w)
    .join("-") || "unnamed-rule";
}

function computeTrend(
  ratings: RatingEntry[],
): { avg: number; count: number; direction: "up" | "down" | "flat" } {
  if (ratings.length === 0) return { avg: 0, count: 0, direction: "flat" };

  const avg = ratings.reduce((s, r) => s + r.rating, 0) / ratings.length;

  if (ratings.length < 4) return { avg, count: ratings.length, direction: "flat" };

  const half = Math.floor(ratings.length / 2);
  const firstHalf = ratings.slice(0, half);
  const secondHalf = ratings.slice(half);
  const firstAvg = firstHalf.reduce((s, r) => s + r.rating, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((s, r) => s + r.rating, 0) / secondHalf.length;

  const delta = secondAvg - firstAvg;
  const direction = delta > 0.5 ? "up" : delta < -0.5 ? "down" : "flat";
  return { avg, count: ratings.length, direction };
}

// ── Parse ratings.jsonl ──

async function loadRatings(ratingsPath: string): Promise<RatingEntry[]> {
  const entries: RatingEntry[] = [];
  if (!existsSync(ratingsPath)) return entries;

  const content = await Bun.file(ratingsPath).text();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj.rating === "number") {
        entries.push({
          timestamp: obj.timestamp ?? "",
          rating: obj.rating,
          sentimentSummary: obj.sentiment_summary ?? obj.sentimentSummary,
          sentimentDetail: obj.sentiment_detail ?? obj.sentimentDetail,
          responsePreview: obj.response_preview ?? obj.responsePreview,
          sessionId: obj.session_id ?? obj.sessionId,
          comment: obj.comment,
        });
      }
    } catch { /* skip malformed */ }
  }
  return entries;
}

// ── Greedy Clustering ──

const SIMILARITY_THRESHOLD = 0.4;
const MIN_PATTERN_SIZE = 3;
const MAX_AVG_RATING = 4;
const SEVERE_MIN_PATTERN_SIZE = 2;
const SEVERE_AVG_RATING = 2;

interface ClusterInfo {
  entries: RatingEntry[];
  summaries: string[];
  avgRating: number;
  qualifiedViaSevere: boolean;
}

function clusterBySimilarity(entries: RatingEntry[]): ClusterInfo[] {
  const withSummary = entries.filter((e) => e.sentimentSummary);
  const clusters: RatingEntry[][] = [];
  const assigned = new Set<number>();

  for (let i = 0; i < withSummary.length; i++) {
    if (assigned.has(i)) continue;
    const cluster: RatingEntry[] = [withSummary[i]];
    assigned.add(i);

    for (let j = i + 1; j < withSummary.length; j++) {
      if (assigned.has(j)) continue;
      const sim = wordOverlap(
        withSummary[i].sentimentSummary!,
        withSummary[j].sentimentSummary!,
      );
      if (sim >= SIMILARITY_THRESHOLD) {
        cluster.push(withSummary[j]);
        assigned.add(j);
      }
    }
    clusters.push(cluster);
  }

  const results: ClusterInfo[] = [];
  for (const cluster of clusters) {
    const avgRating = cluster.reduce((s, e) => s + e.rating, 0) / cluster.length;
    const qualifiesNormal = cluster.length >= MIN_PATTERN_SIZE && avgRating <= MAX_AVG_RATING;
    const qualifiesSevere = cluster.length >= SEVERE_MIN_PATTERN_SIZE && avgRating <= SEVERE_AVG_RATING;

    if (!qualifiesNormal && !qualifiesSevere) continue;

    results.push({
      entries: cluster,
      summaries: cluster.map((e) => e.sentimentSummary!),
      avgRating,
      qualifiedViaSevere: !qualifiesNormal && qualifiesSevere,
    });
  }

  return results;
}

// ── Generate Rule Text ──

function generateRuleText(cluster: ClusterInfo, dateStr: string): string {
  const summaryList = cluster.summaries
    .slice(0, 5)
    .map((s) => `"${s}"`)
    .join(", ");

  const tokens = tokenize(cluster.summaries.join(" "));
  const stopwords = new Set([
    "the", "is", "at", "of", "on", "in", "to", "a", "an", "and", "or",
    "for", "was", "not", "but", "with", "this", "that", "from", "by",
  ]);
  const actionWords = tokens.filter((w) => !stopwords.has(w));
  const topAction = [...new Set(actionWords)].slice(0, 6).join(" ");

  return `When patterns around "${topAction}" appear, verify facts before responding. ` +
    `${cluster.entries.length} entries with avg rating ${cluster.avgRating.toFixed(1)} ` +
    `matched summaries: ${summaryList}`;
}

// ── Core: runReview ──

export async function runReview(
  signalDir: string,
  stateDir: string,
): Promise<ReviewResult> {
  const ratingsPath = join(signalDir, "ratings.jsonl");
  const entries = await loadRatings(ratingsPath);
  const scoreTrend = computeTrend(entries);

  // Cluster by similarity and filter to qualifying patterns
  const qualifiedClusters = clusterBySimilarity(entries);
  const allClusters = entries.filter((e) => e.sentimentSummary);

  // Count all clusters (including non-qualifying) for patternsFound
  const withSummary = entries.filter((e) => e.sentimentSummary);
  const rawClusters: RatingEntry[][] = [];
  const assigned = new Set<number>();
  for (let i = 0; i < withSummary.length; i++) {
    if (assigned.has(i)) continue;
    const cluster: RatingEntry[] = [withSummary[i]];
    assigned.add(i);
    for (let j = i + 1; j < withSummary.length; j++) {
      if (assigned.has(j)) continue;
      if (wordOverlap(withSummary[i].sentimentSummary!, withSummary[j].sentimentSummary!) >= SIMILARITY_THRESHOLD) {
        cluster.push(withSummary[j]);
        assigned.add(j);
      }
    }
    rawClusters.push(cluster);
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const candidates: Pattern[] = [];
  let skipped = 0;

  for (const cluster of qualifiedClusters) {
    const ruleName = deriveRuleName(cluster.summaries);
    const ruleText = generateRuleText(cluster, dateStr);
    const sessions = cluster.entries.map((e) => e.timestamp);

    candidates.push({
      id: `review-${ruleName}-${Date.now()}`,
      type: cluster.qualifiedViaSevere ? "severe-cluster" : "failure-cluster",
      frequency: cluster.entries.length,
      sessions,
      severity: Math.round((MAX_AVG_RATING - cluster.avgRating + 1) * 2),
      candidateRule: ruleText,
      firstSeen: sessions[sessions.length - 1],
      lastSeen: sessions[0],
    });
  }

  // Count non-qualifying clusters as skipped
  skipped = rawClusters.length - qualifiedClusters.length;

  return {
    patternsFound: rawClusters.length,
    candidatesProposed: candidates.length,
    skipped,
    candidates,
    scoreTrend,
  };
}

// ── Contradiction Detection (from LearningReview.ts) ──

const CONTRADICTION_SYSTEM_PROMPT = `You are a behavioral rule quality checker. Given a proposed rule and a list of existing rules, determine:
1. Does the proposed rule logically CONTRADICT any existing rule?
2. Is the proposed rule REDUNDANT with any existing rule?

Return JSON: { "contradicts": boolean, "redundant": boolean, "reason": string }
If redundant, name the existing rule it overlaps with.`;

/**
 * Check whether a proposed rule contradicts or duplicates existing rules.
 * Fails open: if inference errors, returns { contradicts: false, redundant: false }.
 */
export async function checkContradiction(
  proposedRule: string,
  existingRules: string[],
  infer: InferenceFn,
): Promise<ContradictionResult> {
  try {
    const result = await infer({
      systemPrompt: CONTRADICTION_SYSTEM_PROMPT,
      userPrompt: `Proposed rule:\n${proposedRule}\n\nExisting rules:\n${existingRules.join("\n")}`,
      expectJson: true,
    });

    if (!result.success || !result.parsed) {
      return { contradicts: false, redundant: false, reason: "check failed -- allowing promotion" };
    }

    const parsed = result.parsed as { contradicts?: boolean; redundant?: boolean; reason?: string };
    return {
      contradicts: parsed.contradicts === true,
      redundant: parsed.redundant === true,
      reason: typeof parsed.reason === "string" ? parsed.reason : "no reason provided",
    };
  } catch {
    return { contradicts: false, redundant: false, reason: "check failed -- allowing promotion" };
  }
}

// ── Eviction Candidates (from LearningReview.ts) ──

const EVICTION_AVG_THRESHOLD = 4.5;
const EVICTION_MIN_COUNT = 10;
const DEFAULT_STALE_DAYS = 60;

/**
 * Find rules that are candidates for eviction based on low correlated ratings
 * or staleness (not seen in recent sessions).
 */
export function findEvictionCandidates(
  ruleStats: RuleStats[],
  staleDays = DEFAULT_STALE_DAYS,
): EvictionCandidate[] {
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - staleDays * 24 * 60 * 60 * 1000);
  const candidates: EvictionCandidate[] = [];

  for (const stats of ruleStats) {
    if (stats.injectionCount > EVICTION_MIN_COUNT && stats.avgCorrelatedRating < EVICTION_AVG_THRESHOLD) {
      candidates.push({
        ruleId: stats.ruleId,
        reason: "low-rated",
        avgRating: stats.avgCorrelatedRating,
        injectionCount: stats.injectionCount,
        preview: stats.ruleId,
      });
    }

    if (stats.lastSeen) {
      const lastSeen = new Date(stats.lastSeen);
      if (lastSeen < staleCutoff) {
        // Don't double-count rules already flagged as low-rated
        if (!candidates.some((c) => c.ruleId === stats.ruleId)) {
          candidates.push({
            ruleId: stats.ruleId,
            reason: "stale",
            lastSeen: stats.lastSeen,
            preview: stats.ruleId,
          });
        }
      }
    }
  }

  return candidates;
}

// ── Proposed Rule Promotion (from LearningReview.ts) ──

export interface ProposedRule {
  slug: string;
  date: string;
  ruleText: string;
  body: string;
}

const PROMOTE_AFTER_DAYS = 7;

/**
 * Parse proposed rules from pending-rules content (## [PROPOSED - DATE] slug sections).
 * Returns entries eligible for promotion (aged past the gate and not rejected).
 */
export function findPromotableRules(
  pendingContent: string,
  existingContent: string,
): ProposedRule[] {
  const now = new Date();
  const re = /^## \[PROPOSED - (\d{4}-\d{2}-\d{2})\] ([^\n]+)\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm;
  const results: ProposedRule[] = [];

  let match: RegExpExecArray | null;
  while ((match = re.exec(pendingContent)) !== null) {
    const [, date, slug, body] = match;

    if (body.includes("[REJECTED]")) continue;

    const proposedDate = new Date(date);
    const ageDays = (now.getTime() - proposedDate.getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays < PROMOTE_AFTER_DAYS) continue;

    const ruleLineMatch = body.match(/\*\*Proposed rule:\*\*\s*(.+?)(?:\n|$)/);
    if (!ruleLineMatch) continue;

    const ruleText = ruleLineMatch[1].trim();

    // Skip if rule text already appears in existing content
    if (existingContent.includes(ruleText.slice(0, 40))) continue;

    results.push({ slug, date, ruleText, body });
  }

  return results;
}

// ── Episodic Consolidation (from EpisodicConsolidator.ts) ──

interface EpisodeEntry {
  index: number;
  rating: number;
  summary: string;
  detail: string;
}

interface PatternDescriptor {
  name: string;
  episodes: number[];
  failure: string;
}

function formatEpisodeBundle(episodes: EpisodeEntry[]): string {
  return episodes
    .map((e) => `[${e.index}] Rating: ${e.rating}/10\nSummary: ${e.summary}\nDetail: ${e.detail}`)
    .join("\n\n");
}

function graphSimilarity(pattern: string, node: GraphNode): number {
  const patternTokens = pattern
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
  if (patternTokens.length === 0) return 0;

  const haystack = `${node.name} ${node.description}`.toLowerCase();
  let hits = 0;
  for (const tok of patternTokens) {
    if (haystack.includes(tok)) hits++;
  }
  return hits / patternTokens.length;
}

/**
 * Run episodic consolidation: bundle low-rated episodes, use LLM to identify
 * meta-patterns, propose rules with graph-aware deduplication.
 *
 * maxEpisodes: how many recent low-rated entries to analyze (default 60)
 * maxRating: maximum rating to include (default 4)
 * minPatternSize: minimum episodes per pattern (default 3)
 */
export async function consolidateEpisodes(
  signalDir: string,
  existingNodes: GraphNode[],
  existingPendingContent: string,
  infer: InferenceFn,
  opts: { maxEpisodes?: number; maxRating?: number; minPatternSize?: number } = {},
): Promise<ConsolidationResult> {
  const { maxEpisodes = 60, maxRating = 4, minPatternSize = 3 } = opts;

  const ratingsPath = join(signalDir, "ratings.jsonl");
  const allEntries = await loadRatings(ratingsPath);

  // Filter to low-rated episodes with text
  const episodes: EpisodeEntry[] = allEntries
    .filter((e) => e.rating <= maxRating && (e.sentimentSummary || e.sentimentDetail))
    .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""))
    .slice(0, maxEpisodes)
    .map((e, i) => ({
      index: i + 1,
      rating: e.rating,
      summary: e.sentimentSummary ?? "no summary",
      detail: (e.sentimentDetail?.slice(0, 300) ?? e.responsePreview?.slice(0, 200) ?? "no detail"),
    }));

  if (episodes.length === 0) {
    return { patternsFound: 0, rulesProposed: 0, duplicatesSkipped: 0, proposals: [] };
  }

  // Step 1: Critique -- ask LLM to find meta-patterns
  const critiqueResult = await infer({
    systemPrompt: "You are analyzing failure patterns in an AI assistant's sessions. Find recurring failure themes.",
    userPrompt:
      `Below are ${episodes.length} low-rated sessions (rating <= ${maxRating}/10).\n\n` +
      `${formatEpisodeBundle(episodes)}\n\n` +
      `Identify 3-6 meta-patterns where similar failures appear across multiple episodes.\n` +
      `For each pattern:\n` +
      `- Give it a short name (snake_case, under 5 words)\n` +
      `- List the episode indices that belong to it\n` +
      `- Write 1 sentence: what behavior consistently failed\n\n` +
      `Only include patterns with ${minPatternSize}+ episodes. Return JSON:\n` +
      `[{"name":"pattern_name","episodes":[1,4,7],"failure":"The assistant did X when Y"}]`,
    expectJson: true,
  });

  if (!critiqueResult.success || !Array.isArray(critiqueResult.parsed)) {
    return { patternsFound: 0, rulesProposed: 0, duplicatesSkipped: 0, proposals: [] };
  }

  const patterns: PatternDescriptor[] = [];
  for (const item of critiqueResult.parsed as Array<Record<string, unknown>>) {
    const name = typeof item.name === "string" ? item.name : null;
    const eps = Array.isArray(item.episodes)
      ? (item.episodes as unknown[]).filter((x): x is number => typeof x === "number")
      : null;
    const failure = typeof item.failure === "string" ? item.failure : null;
    if (!name || !eps || !failure) continue;
    if (eps.length < minPatternSize) continue;
    patterns.push({ name, episodes: eps, failure });
  }

  // Step 2: Propose rules for each pattern
  const proposals: ConsolidationResult["proposals"] = [];
  let duplicatesSkipped = 0;

  for (const pattern of patterns) {
    // Dedup: skip if pattern name already in pending content
    if (existingPendingContent.includes(pattern.name)) {
      duplicatesSkipped++;
      continue;
    }

    // Find top similar existing graph nodes for context
    const similarNodes = existingNodes
      .map((n) => ({ node: n, score: graphSimilarity(pattern.failure, n) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((x) => x.node);

    const existingList = similarNodes.length > 0
      ? similarNodes.map((n) => `- ${n.name}: ${n.description}`).join("\n")
      : "- (none similar found)";

    const proposeResult = await infer({
      systemPrompt: "You are drafting behavioral rules to prevent recurring AI assistant failures.",
      userPrompt:
        `Failure pattern: "${pattern.failure}"\n` +
        `Supporting episodes (${pattern.episodes.length})\n\n` +
        `Existing similar rules (do NOT duplicate these):\n${existingList}\n\n` +
        `Write ONE behavioral rule to prevent this failure. Requirements:\n` +
        `- Imperative voice, starts with a verb\n` +
        `- Under 30 words\n` +
        `- If already covered by an existing rule, output NONE\n\n` +
        `Output ONLY the rule text or NONE.`,
      expectJson: false,
    });

    if (!proposeResult.success) continue;

    // proposeResult.parsed might be undefined for non-JSON, use a fallback
    const rawText = typeof proposeResult.parsed === "string"
      ? proposeResult.parsed
      : "";
    const cleaned = rawText
      .replace(/^```[a-z]*\n?/i, "")
      .replace(/```$/, "")
      .trim();

    if (!cleaned || /^none\b/i.test(cleaned)) continue;

    const firstLine = cleaned.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
    if (!firstLine) continue;

    proposals.push({
      patternName: pattern.name,
      failure: pattern.failure,
      episodes: pattern.episodes.length,
      proposedRule: firstLine,
    });
  }

  return {
    patternsFound: patterns.length,
    rulesProposed: proposals.length,
    duplicatesSkipped,
    proposals,
  };
}
