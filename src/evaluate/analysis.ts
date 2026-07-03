import type { Score } from "../adapters/types";

export interface DimensionAnalysis {
  dimension: string;
  avg: number;
  min: number;
  max: number;
  stddev: number;
  count: number;
}

export interface TrendResult {
  dimension: string;
  direction: "improving" | "declining" | "stable";
  recentAvg: number;
  priorAvg: number;
  delta: number;
}

export function analyzeScores(scores: Score[]): DimensionAnalysis[] {
  const byDimension = new Map<string, number[]>();

  for (const s of scores) {
    if (!byDimension.has(s.dimension)) byDimension.set(s.dimension, []);
    byDimension.get(s.dimension)!.push(s.value);
  }

  const results: DimensionAnalysis[] = [];

  for (const [dimension, values] of byDimension) {
    if (values.length === 0) continue;

    const sum = values.reduce((a, b) => a + b, 0);
    const avg = sum / values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const variance = values.reduce((acc, v) => acc + (v - avg) ** 2, 0) / values.length;
    const stddev = Math.sqrt(variance);

    results.push({
      dimension,
      avg: Math.round(avg * 100) / 100,
      min,
      max,
      stddev: Math.round(stddev * 100) / 100,
      count: values.length,
    });
  }

  return results.sort((a, b) => a.avg - b.avg);
}

export function detectTrends(scores: Score[], windowDays = 7): TrendResult[] {
  if (scores.length === 0) return [];

  const now = Date.now();
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const cutoff = now - windowMs;

  const byDimension = new Map<string, { recent: number[]; prior: number[] }>();

  for (const s of scores) {
    const ts = new Date(s.timestamp).getTime();
    if (!byDimension.has(s.dimension)) {
      byDimension.set(s.dimension, { recent: [], prior: [] });
    }
    const bucket = byDimension.get(s.dimension)!;
    if (ts >= cutoff) {
      bucket.recent.push(s.value);
    } else {
      bucket.prior.push(s.value);
    }
  }

  const results: TrendResult[] = [];

  for (const [dimension, { recent, prior }] of byDimension) {
    if (recent.length === 0 || prior.length === 0) continue;

    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const priorAvg = prior.reduce((a, b) => a + b, 0) / prior.length;
    const delta = recentAvg - priorAvg;

    const threshold = 0.3;
    let direction: "improving" | "declining" | "stable";
    if (delta > threshold) direction = "improving";
    else if (delta < -threshold) direction = "declining";
    else direction = "stable";

    results.push({
      dimension,
      direction,
      recentAvg: Math.round(recentAvg * 100) / 100,
      priorAvg: Math.round(priorAvg * 100) / 100,
      delta: Math.round(delta * 100) / 100,
    });
  }

  return results;
}
