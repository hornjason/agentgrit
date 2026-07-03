import { randomUUID } from "crypto";
import { appendSignal } from "../adapters/jsonl";
import { signalPath } from "../adapters/paths";
import type { RatingSignal } from "../adapters/types";
import { SCHEMA_VERSION } from "../adapters/types";

const RATINGS_FILE = "ratings.jsonl";

const RATE_PATTERN = /^\/rate\s+M:(\d+)\s+S:(\d+)\s+Q:(\d+)(?:\s+(.+))?$/i;

const POSITIVE_KEYWORDS = new Set([
  "excellent", "amazing", "brilliant", "fantastic", "wonderful",
  "incredible", "awesome", "perfect", "great", "nice", "superb",
  "outstanding", "terrific", "love it", "nailed it", "well done",
  "good job", "great job", "nice work",
]);

const NEGATIVE_KEYWORDS = new Set([
  "wrong", "broken", "terrible", "awful", "horrible", "bad",
  "frustrated", "annoying", "useless", "disappointed", "fail",
  "failure", "disaster", "mess", "garbage", "waste",
]);

export interface RatingParseResult {
  mode: number;
  scope: number;
  quality: number;
  comment?: string;
}

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

  const total = posCount + negCount;
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
    summary: `Mixed sentiment (${total} keywords)`,
    confidence: 0.4,
  };
}

export async function captureRating(
  message: string,
  sessionId: string,
): Promise<RatingSignal | null> {
  const parsed = parseRating(message);
  if (!parsed) return null;

  const composite = Math.round(
    (parsed.mode * 0.34 + parsed.scope * 0.33 + parsed.quality * 0.33) * 10,
  ) / 10;

  const sentiment = scoreSentiment(parsed.comment ?? "");

  const signal: RatingSignal = {
    id: randomUUID(),
    type: "rating",
    timestamp: new Date().toISOString(),
    sessionId,
    schemaVersion: SCHEMA_VERSION,
    rating: composite,
    source: "explicit",
    comment: parsed.comment,
    sentimentSummary: sentiment?.summary,
    confidence: sentiment?.confidence,
  };

  await appendSignal(signalPath(RATINGS_FILE), signal);
  return signal;
}
