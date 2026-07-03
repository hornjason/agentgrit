/**
 * rules.ts -- Rule tracking, correlation, and auto-memory generation
 *
 * Consolidates:
 *   RuleTracker.ts   -- track rule injection counts, correlate with ratings,
 *                       compute correlation scores, identify eviction candidates,
 *                       stable ID generation, circuit breaker for anomalous nodes
 *   AutoFeedback.ts  -- generate feedback memories from low-rating patterns
 *   AutoSuccess.ts   -- generate success memories from high-rating sessions
 */

import type { Rule, GraphNode, RatingSignal } from "../adapters/types";

// ── Constants ──

const MAX_SESSION_RATINGS = 20;
const CIRCUIT_BREAKER_STD_DEV = 2.0;
const CIRCUIT_BREAKER_MIN_RATINGS = 5;

// ── Exported Interfaces ──

export interface RuleStats {
  ruleId: string;
  injectionCount: number;
  avgCorrelatedRating: number;
  sessionRatings: number[];
  highRatingActivations: number;
  lowRatingActivations: number;
  lastSeen: string;
}

export interface ExtractedRule {
  id: string;
  preview: string;
  fullText: string;
}

export interface CircuitBreakerResult {
  nodeId: string;
  allTimeAvg: number;
  recentAvg: number;
  stdDev: number;
}

export interface FeedbackDecision {
  alreadyCovered: boolean;
  existingMemory: string | null;
  feedbackName: string;
  description: string;
  rule: string;
  why: string;
  howToApply: string;
}

export interface SuccessDecision {
  alreadyCovered: boolean;
  existingMemory: string | null;
  successName: string;
  description: string;
  pattern: string;
  whyItWorked: string;
  reuseGuidance: string;
}

/** Generic inference function signature -- callers provide their own LLM adapter */
export type InferenceFn = (opts: {
  systemPrompt: string;
  userPrompt: string;
  expectJson: boolean;
}) => Promise<{ success: boolean; parsed?: unknown; error?: string }>;

// ── Rule Tracking (from RuleTracker.ts) ──

export function trackRule(rule: Rule, sessionRating: number): Rule {
  const now = new Date().toISOString();
  const ratings = [...(rule.sessionRatings ?? []), sessionRating].slice(
    -MAX_SESSION_RATINGS,
  );
  const avg =
    ratings.length > 0
      ? ratings.reduce((a, b) => a + b, 0) / ratings.length
      : 0;

  return {
    ...rule,
    injectionCount: (rule.injectionCount ?? 0) + 1,
    avgCorrelatedRating: avg,
    sessionRatings: ratings,
    highRatingActivations:
      (rule.highRatingActivations ?? 0) + (sessionRating >= 7 ? 1 : 0),
    lowRatingActivations:
      (rule.lowRatingActivations ?? 0) + (sessionRating <= 4 ? 1 : 0),
    lastSeen: now,
  };
}

export function getEvictionCandidates(
  rules: Rule[],
  topN = 5,
): Rule[] {
  const MIN_INJECTION_COUNT = 5;

  return rules
    .filter((r) => (r.injectionCount ?? 0) > MIN_INJECTION_COUNT)
    .sort((a, b) => {
      const ratingDiff =
        (a.avgCorrelatedRating ?? 0) - (b.avgCorrelatedRating ?? 0);
      if (ratingDiff !== 0) return ratingDiff;
      return (b.injectionCount ?? 0) - (a.injectionCount ?? 0);
    })
    .slice(0, topN);
}

export function correlateRules(rules: Rule[]): RuleStats[] {
  return rules.map((r) => ({
    ruleId: r.id,
    injectionCount: r.injectionCount ?? 0,
    avgCorrelatedRating: r.avgCorrelatedRating ?? 0,
    sessionRatings: r.sessionRatings ?? [],
    highRatingActivations: r.highRatingActivations ?? 0,
    lowRatingActivations: r.lowRatingActivations ?? 0,
    lastSeen: r.lastSeen ?? "",
  }));
}

// ── Stable ID Generation (from RuleTracker.ts) ──

/**
 * Generate a stable 7-char ID from the first 60 chars of a rule bullet.
 * Uses djb2-style hash for consistency across runs.
 */
export function stableId(text: string): string {
  const preview = text.slice(0, 60);
  let hash = 5381;
  for (let i = 0; i < preview.length; i++) {
    hash = ((hash << 5) + hash) + preview.charCodeAt(i);
    hash = hash & 0x7fffffff;
  }
  return "rule-" + hash.toString(36).slice(-6).padStart(6, "0");
}

// ── Rule Extraction from Markdown (from RuleTracker.ts) ──

/**
 * Parse rules from a markdown document's rules section.
 * Looks for bullets starting with `- **` under the specified marker heading.
 */
export function extractRulesFromContent(
  content: string,
  marker = "### Critical Rules",
): ExtractedRule[] {
  const markerIdx = content.indexOf(marker);
  if (markerIdx === -1) return [];

  const afterMarker = content.slice(markerIdx + marker.length);
  const lines = afterMarker.split("\n");
  const rules: ExtractedRule[] = [];
  let currentRule = "";

  for (const line of lines) {
    if (line.startsWith("## ") || line.startsWith("---")) break;

    if (line.startsWith("- **")) {
      if (currentRule) {
        const preview = currentRule.slice(0, 80).replace(/\*\*/g, "").trim();
        rules.push({ id: stableId(currentRule), preview, fullText: currentRule });
      }
      currentRule = line;
    } else if (currentRule && line.trim()) {
      currentRule += " " + line.trim();
    }
  }

  if (currentRule) {
    const preview = currentRule.slice(0, 80).replace(/\*\*/g, "").trim();
    rules.push({ id: stableId(currentRule), preview, fullText: currentRule });
  }

  return rules;
}

// ── Circuit Breaker for Graph Node Attribution (from RuleTracker.ts) ──

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Check if a rule/node's recent ratings deviate anomalously from its all-time average.
 * Returns the frozen node info if the circuit breaker trips, null otherwise.
 */
export function checkCircuitBreaker(
  ratings: number[],
  nodeId: string,
  recentWindow = 3,
): CircuitBreakerResult | null {
  if (ratings.length < CIRCUIT_BREAKER_MIN_RATINGS) return null;

  const allAvg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
  const sd = stdDev(ratings);
  const recent = ratings.slice(-recentWindow);
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;

  if (sd > 0 && (allAvg - recentAvg) / sd > CIRCUIT_BREAKER_STD_DEV) {
    return { nodeId, allTimeAvg: allAvg, recentAvg, stdDev: sd };
  }

  return null;
}

/**
 * Process attributed ratings: for each rating entry with rule_ids, update
 * a per-node stats map and detect circuit breaker trips.
 */
export function processAttributedRatings(
  entries: Array<{ rating: number; rule_ids?: string[] }>,
  existing: Record<string, RuleStats>,
  frozenNodes: Set<string>,
): { stats: Record<string, RuleStats>; newlyFrozen: CircuitBreakerResult[] } {
  const stats = { ...existing };
  const newlyFrozen: CircuitBreakerResult[] = [];
  const now = new Date().toISOString();

  for (const entry of entries) {
    if (!entry.rule_ids?.length || typeof entry.rating !== "number") continue;

    for (const nodeId of entry.rule_ids) {
      if (frozenNodes.has(nodeId)) continue;

      const prev = stats[nodeId];
      const newRatings = prev
        ? [...prev.sessionRatings, entry.rating].slice(-MAX_SESSION_RATINGS)
        : [entry.rating];

      stats[nodeId] = {
        ruleId: nodeId,
        injectionCount: (prev?.injectionCount ?? 0) + 1,
        avgCorrelatedRating:
          newRatings.reduce((a, b) => a + b, 0) / newRatings.length,
        sessionRatings: newRatings,
        highRatingActivations:
          (prev?.highRatingActivations ?? 0) + (entry.rating >= 7 ? 1 : 0),
        lowRatingActivations:
          (prev?.lowRatingActivations ?? 0) + (entry.rating <= 4 ? 1 : 0),
        lastSeen: now,
      };
    }
  }

  // Circuit breaker check on updated stats
  for (const [nodeId, nodeStats] of Object.entries(stats)) {
    if (frozenNodes.has(nodeId)) continue;
    const trip = checkCircuitBreaker(nodeStats.sessionRatings, nodeId);
    if (trip) {
      frozenNodes.add(nodeId);
      newlyFrozen.push(trip);
    }
  }

  return { stats, newlyFrozen };
}

// ── Auto-Feedback Generation (from AutoFeedback.ts) ──

const FEEDBACK_SYSTEM_PROMPT = `You are a behavioral learning system for an AI assistant. Analyze a low-rating learning capture and determine whether it reveals a behavioral lesson that should become a persistent feedback memory.

A feedback memory is a short, actionable rule that changes future behavior. Good feedback memories are:
- Specific and behavioral (not vague)
- Actionable (the AI can apply them every session)
- Distinct from existing memories (no duplicates)

You will receive:
1. A learning capture (the incident that triggered a low rating)
2. A list of existing feedback memories

Respond with JSON only:
{
  "alreadyCovered": boolean,
  "existingMemory": "filename that covers this or null",
  "feedbackName": "short descriptive name, 3-6 words, kebab-case friendly",
  "description": "one-line description, under 15 words",
  "rule": "clear behavioral rule, 1-3 sentences",
  "why": "the incident that triggered this, 1-2 sentences",
  "howToApply": "when and where this guidance kicks in, 1-2 sentences"
}

Rules for alreadyCovered:
- Set true ONLY if an existing memory directly addresses the same behavior
- Different contexts = different memories
- If in doubt, set false`;

/**
 * Generate a feedback memory from a low-rating context.
 * Returns null if inference fails or the pattern is already covered.
 */
export async function generateFeedback(
  context: string,
  summary: string,
  rating: number,
  existingMemorySummaries: string,
  infer: InferenceFn,
): Promise<FeedbackDecision | null> {
  if (!context?.trim() && !summary?.trim()) return null;

  const userPrompt = `EXISTING FEEDBACK MEMORIES:
${existingMemorySummaries || "(none yet)"}

---

LEARNING CAPTURE TO ANALYZE:
Rating: ${rating}/10
Summary: ${summary}
Context:
${context}`;

  const result = await infer({
    systemPrompt: FEEDBACK_SYSTEM_PROMPT,
    userPrompt,
    expectJson: true,
  });

  if (!result.success || !result.parsed) return null;

  const decision = result.parsed as FeedbackDecision;
  if (decision.alreadyCovered) return null;
  if (!decision.feedbackName || !decision.rule || !decision.why) return null;

  return decision;
}

// ── Auto-Success Generation (from AutoSuccess.ts) ──

const SUCCESS_SYSTEM_PROMPT = `You are a behavioral success-pattern system for an AI assistant. Analyze a high-rating session capture and determine whether it reveals a successful approach that should become a persistent success memory.

A success memory captures what worked. Good success memories are:
- Specific to a task type or situation
- Describe the approach/pattern that drove the high rating
- Actionable as reuse guidance for similar future tasks

You will receive:
1. A success capture (context from a session rated >= 8)
2. A list of existing success memories

Respond with JSON only:
{
  "alreadyCovered": boolean,
  "existingMemory": "filename that covers this or null",
  "successName": "short descriptive name, 3-6 words, kebab-case friendly",
  "description": "one-line description, under 15 words",
  "pattern": "what approach drove the success, 1-3 sentences",
  "whyItWorked": "why this satisfied the user, 1-2 sentences",
  "reuseGuidance": "when to apply this pattern, 1-2 sentences"
}

Rules for alreadyCovered:
- Set true ONLY if an existing memory captures the same approach
- Similar task types with different execution = different memories
- If in doubt, set false`;

/**
 * Generate a success memory from a high-rating context.
 * Returns null if inference fails or the pattern is already covered.
 */
export async function generateSuccess(
  context: string,
  summary: string,
  rating: number,
  existingMemorySummaries: string,
  infer: InferenceFn,
): Promise<SuccessDecision | null> {
  if (rating < 8) return null;
  if (!context?.trim() && !summary?.trim()) return null;

  const userPrompt = `EXISTING SUCCESS MEMORIES:
${existingMemorySummaries || "(none yet)"}

---

SUCCESS CAPTURE TO ANALYZE:
Rating: ${rating}/10
Summary: ${summary}
Context:
${context}`;

  const result = await infer({
    systemPrompt: SUCCESS_SYSTEM_PROMPT,
    userPrompt,
    expectJson: true,
  });

  if (!result.success || !result.parsed) return null;

  const decision = result.parsed as SuccessDecision;
  if (decision.alreadyCovered) return null;
  if (!decision.successName || !decision.pattern) return null;

  return decision;
}

// ── Utility: kebab-case slug ──

export function toSlug(name: string, maxLen = 40): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLen);
}
