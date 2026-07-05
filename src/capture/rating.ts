/**
 * rating.ts - Unified rating, sentiment, and response cache capture
 *
 * Consolidates:
 * - RatingCapture.hook.ts: Dimension parsing (M:N S:N Q:N), composite score,
 *   response preview truncation, rule_ids attachment
 * - SentimentScorer.hook.ts: Session-level algorithmic scoring from transcript
 *   analysis — approval/correction/reprompt counting, word overlap detection,
 *   confidence by turn count
 * - LastResponseCache.hook.ts: Response cache for rating bridge
 */

import { randomUUID } from "crypto";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { appendSignal } from "../adapters/jsonl";
import { signalPath, resolveSignalDir } from "../adapters/paths";
import { readSessionContext } from "../graph/context";
import type { RatingSignal, SentimentSignal } from "../adapters/types";
import { SCHEMA_VERSION } from "../adapters/types";

const RATINGS_FILE = "ratings.jsonl";
const RESPONSE_CACHE_FILE = "last-response.txt";
const MAX_RESPONSE_PREVIEW = 500;
const MAX_CACHE_SIZE = 2000;

// ── Dimension rating pattern ──

const RATE_PATTERN = /^\/rate\s+M:(\d+)\s+S:(\d+)\s+Q:(\d+)(?:\s+(.+))?$/i;

// ── Sentiment keyword sets ──

const POSITIVE_KEYWORDS = new Set([
  "excellent", "amazing", "brilliant", "fantastic", "wonderful",
  "incredible", "awesome", "perfect", "great", "nice", "superb",
  "outstanding", "terrific", "love it", "nailed it", "well done",
  "good job", "great job", "nice work", "stellar", "phenomenal",
  "remarkable", "splendid", "beautiful", "magnificent",
]);

const NEGATIVE_KEYWORDS = new Set([
  "wrong", "broken", "terrible", "awful", "horrible", "bad",
  "frustrated", "annoying", "useless", "disappointed", "fail",
  "failure", "disaster", "mess", "garbage", "waste",
]);

// ── Session scoring phrase lists (from SentimentScorer) ──

const CORRECTION_PHRASES = [
  "no ", "wrong", "stop ", "not like that", "i didn't ask",
  "that's not", "incorrect", "fix that", "that's wrong",
];

const APPROVAL_PHRASES = [
  "yes", "perfect", "exactly", "great", "good",
  "go for it", "that's right", "correct", "nice", "love it",
];

// ── Exports: Types ──

export interface RatingParseResult {
  mode: number;
  scope: number;
  quality: number;
  comment?: string;
}

export interface Turn {
  role: "user" | "assistant";
  text: string;
  charCount: number;
}

export interface SessionScoreResult {
  score: number;
  confidence: number;
  corrections: number;
  approvals: number;
  reprompts: number;
  summary: string;
}

// ── Parse explicit /rate command ──

export function parseRating(message: string): RatingParseResult | null {
  const match = message.trim().match(RATE_PATTERN);
  if (!match) return null;

  const mode = parseInt(match[1], 10);
  const scope = parseInt(match[2], 10);
  const quality = parseInt(match[3], 10);

  if ([mode, scope, quality].some((v) => v < 1 || v > 10)) return null;

  return {
    mode,
    scope,
    quality,
    comment: match[4]?.trim() || undefined,
  };
}

// ── Keyword-based sentiment scoring ──

export function scoreSentiment(text: string): {
  summary: string;
  confidence: number;
} | null {
  const lower = text.toLowerCase().replace(/[.!?,'"]/g, "");
  const words = lower.split(/\s+/);

  let posCount = 0;
  let negCount = 0;

  for (const word of words) {
    if (POSITIVE_KEYWORDS.has(word)) posCount++;
    if (NEGATIVE_KEYWORDS.has(word)) negCount++;
  }

  // Check two-word phrases
  for (let i = 0; i < words.length - 1; i++) {
    const phrase = `${words[i]} ${words[i + 1]}`;
    if (POSITIVE_KEYWORDS.has(phrase)) posCount++;
    if (NEGATIVE_KEYWORDS.has(phrase)) negCount++;
  }

  if (posCount === 0 && negCount === 0) return null;

  if (posCount > negCount) {
    return {
      summary: `Positive sentiment (${posCount} positive keyword${posCount > 1 ? "s" : ""})`,
      confidence: Math.min(0.5 + posCount * 0.15, 0.95),
    };
  }
  if (negCount > posCount) {
    return {
      summary: `Negative sentiment (${negCount} negative keyword${negCount > 1 ? "s" : ""})`,
      confidence: Math.min(0.5 + negCount * 0.15, 0.95),
    };
  }
  return {
    summary: `Mixed sentiment (${posCount + negCount} keywords)`,
    confidence: 0.4,
  };
}

// ── Composite score from dimensions ──

export function computeComposite(mode: number, scope: number, quality: number): number {
  return Math.round(
    (mode * 0.34 + scope * 0.33 + quality * 0.33) * 10,
  ) / 10;
}

// ── Response preview truncation ──

export function truncatePreview(response: string): string {
  if (!response) return "";
  return response.slice(0, MAX_RESPONSE_PREVIEW);
}

// ── Response cache (from LastResponseCache) ──

export function cacheLastResponse(response: string): string {
  return response.slice(0, MAX_CACHE_SIZE);
}

export function writeLastResponse(response: string, targetDir?: string): string {
  const dir = targetDir ?? resolveSignalDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const cached = cacheLastResponse(response);
  const filePath = join(dir, RESPONSE_CACHE_FILE);
  writeFileSync(filePath, cached);
  return filePath;
}

// ── Word overlap ratio for reprompt detection (from SentimentScorer) ──

export function wordOverlapRatio(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let overlap = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) overlap++;
  }

  return overlap / Math.min(wordsA.size, wordsB.size);
}

// ── Session-level algorithmic scoring (from SentimentScorer) ──

export function scoreSession(turns: Turn[]): SessionScoreResult {
  const humanTurns = turns.filter((t) => t.role === "user");
  const humanCount = humanTurns.length;

  // Confidence by turn count
  let confidence = 0.5;
  if (humanCount > 10) confidence = 0.9;
  else if (humanCount >= 5) confidence = 0.7;

  let score = 6.0;

  let correctionCount = 0;
  let repromptCount = 0;
  let frustrationCount = 0;
  let approvalCount = 0;
  let debriefBonus = false;

  let correctionPenalty = 0;
  let repromptPenalty = 0;
  let approvalBonus = 0;

  const humanTexts: string[] = [];
  let lastAssistantLen = 0;

  for (const turn of turns) {
    if (turn.role === "assistant") {
      lastAssistantLen = turn.charCount;
      continue;
    }

    const lowerText = turn.text.toLowerCase();
    const wordCount = turn.text.trim().split(/\s+/).length;

    // Correction phrase detection
    for (const phrase of CORRECTION_PHRASES) {
      if (lowerText.includes(phrase)) {
        correctionPenalty = Math.min(correctionPenalty + 0.5, 3.0);
        correctionCount++;
        break;
      }
    }

    // Short frustrated response after long AI turn
    if (wordCount < 5 && lastAssistantLen > 200) {
      const isApproval = APPROVAL_PHRASES.some((p) => lowerText.includes(p));
      if (!isApproval) {
        frustrationCount++;
      }
    }

    // Approval phrase detection
    for (const phrase of APPROVAL_PHRASES) {
      if (lowerText.includes(phrase)) {
        approvalBonus = Math.min(approvalBonus + 0.4, 2.0);
        approvalCount++;
        break;
      }
    }

    // /debrief detection
    if (lowerText.includes("/debrief")) {
      debriefBonus = true;
    }

    humanTexts.push(turn.text);
    lastAssistantLen = 0;
  }

  // Reprompt detection: consecutive human turns with >60% word overlap
  const maxPairs = Math.min(humanTexts.length - 1, 50);
  for (let i = 0; i < maxPairs; i++) {
    if (wordOverlapRatio(humanTexts[i], humanTexts[i + 1]) > 0.6) {
      repromptPenalty = Math.min(repromptPenalty + 0.7, 2.0);
      repromptCount++;
    }
  }

  // Long uninterrupted AI run bonus
  let consecutiveAI = 0;
  let longRunBonus = 0;
  for (const turn of turns) {
    if (turn.role === "assistant") {
      consecutiveAI++;
    } else {
      const isCorrection = CORRECTION_PHRASES.some((p) =>
        turn.text.toLowerCase().includes(p),
      );
      if (isCorrection) {
        consecutiveAI = 0;
      } else {
        if (consecutiveAI >= 5) longRunBonus = 0.5;
        consecutiveAI = 0;
      }
    }
  }
  if (consecutiveAI >= 5) longRunBonus = 0.5;

  // Apply signals
  score -= correctionPenalty;
  score -= repromptPenalty;
  score -= frustrationCount * 0.3;
  score += approvalBonus;
  if (debriefBonus) score += 1.0;
  score += longRunBonus;

  // Clamp and round
  score = Math.max(1, Math.min(10, score));
  score = Math.round(score * 10) / 10;

  // Build summary
  const parts: string[] = [];
  if (approvalCount > 0) parts.push(`${approvalCount} approval${approvalCount > 1 ? "s" : ""}`);
  if (correctionCount > 0) parts.push(`${correctionCount} correction${correctionCount > 1 ? "s" : ""}`);
  if (repromptCount > 0) parts.push(`${repromptCount} re-prompt${repromptCount > 1 ? "s" : ""}`);
  if (frustrationCount > 0) parts.push(`${frustrationCount} short-frustrated`);
  if (debriefBonus) parts.push("/debrief called");
  if (longRunBonus > 0) parts.push("long uninterrupted run");

  const summary = parts.length > 0
    ? `Auto-scored: ${parts.join(", ")}`
    : "Auto-scored: no strong signals detected";

  return {
    score,
    confidence,
    corrections: correctionCount,
    approvals: approvalCount,
    reprompts: repromptCount,
    summary,
  };
}

// ── Capture explicit rating (writes signal) ──

export async function captureRating(
  message: string,
  sessionId: string,
  opts?: { responsePreview?: string; ruleIds?: string[] },
): Promise<RatingSignal | null> {
  const parsed = parseRating(message);
  if (!parsed) return null;

  const composite = computeComposite(parsed.mode, parsed.scope, parsed.quality);
  const sentiment = scoreSentiment(parsed.comment ?? "");

  const ruleIds = opts?.ruleIds ?? readSessionContext()?.ruleIds;

  const signal: RatingSignal = {
    id: randomUUID(),
    type: "rating",
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    schemaVersion: SCHEMA_VERSION,
    rating: composite,
    source: "explicit",
    comment: parsed.comment,
    sentimentSummary: sentiment?.summary,
    confidence: sentiment?.confidence,
    response_preview: opts?.responsePreview
      ? truncatePreview(opts.responsePreview)
      : undefined,
    rule_ids: ruleIds,
  };

  await appendSignal(signalPath(RATINGS_FILE), signal);
  return signal;
}

// ── Capture session-level sentiment score ──

export async function captureSessionSentiment(
  turns: Turn[],
  sessionId: string,
  opts?: { ruleIds?: string[] },
): Promise<SentimentSignal | null> {
  if (turns.length === 0) return null;

  const result = scoreSession(turns);

  const signal: SentimentSignal = {
    id: randomUUID(),
    type: "sentiment",
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    schemaVersion: SCHEMA_VERSION,
    rating: result.score,
    source: "transcript-analysis",
    confidence: result.confidence,
    corrections: result.corrections,
    approvals: result.approvals,
    reprompts: result.reprompts,
  };

  await appendSignal(signalPath(RATINGS_FILE), signal);
  return signal;
}
