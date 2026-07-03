import type { CorrectionSignal, RatingSignal, SentimentSignal } from "../adapters/types";

export interface SessionSignals {
  ratings: RatingSignal[];
  corrections: CorrectionSignal[];
  sentiment: SentimentSignal[];
}

const WEIGHT_RATING = 0.4;
const WEIGHT_CORRECTION = 0.3;
const WEIGHT_SENTIMENT = 0.3;

function normalizeRating(ratings: RatingSignal[]): number {
  if (ratings.length === 0) return 0.5;
  const avg = ratings.reduce((s, r) => s + r.rating, 0) / ratings.length;
  return Math.max(0, Math.min(1, avg / 10));
}

function correctionPenalty(corrections: CorrectionSignal[]): number {
  if (corrections.length === 0) return 1.0;
  const penalty = corrections.reduce((s, c) => s + c.severity, 0);
  return Math.max(0, 1.0 - penalty * 0.1);
}

function normalizeSentiment(sentiment: SentimentSignal[]): number {
  if (sentiment.length === 0) return 0.5;
  const avg = sentiment.reduce((s, sig) => s + sig.rating, 0) / sentiment.length;
  return Math.max(0, Math.min(1, avg / 10));
}

export function scoreSession(signals: SessionSignals): number {
  const rating = normalizeRating(signals.ratings);
  const correction = correctionPenalty(signals.corrections);
  const sentiment = normalizeSentiment(signals.sentiment);

  const composite =
    WEIGHT_RATING * rating +
    WEIGHT_CORRECTION * correction +
    WEIGHT_SENTIMENT * sentiment;

  return Math.round(composite * 1000) / 1000;
}
