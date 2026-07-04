import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { Pattern, Rule } from "../adapters/types";
import { SCHEMA_VERSION } from "../adapters/types";

export interface ReviewResult {
  patternsFound: number;
  candidatesProposed: number;
  skipped: number;
  candidates: Pattern[];
  scoreTrend: { avg: number; count: number; direction: "up" | "down" | "flat" };
}

interface RatingEntry {
  timestamp: string;
  rating: number;
  sentimentSummary?: string;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

function wordOverlap(a: string, b: string): number {
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

export async function runReview(
  signalDir: string,
  stateDir: string,
): Promise<ReviewResult> {
  const ratingsPath = join(signalDir, "ratings.jsonl");

  const entries: RatingEntry[] = [];
  if (existsSync(ratingsPath)) {
    const content = readFileSync(ratingsPath, "utf-8");
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
          });
        }
      } catch { /* skip malformed */ }
    }
  }

  const scoreTrend = computeTrend(entries);
  const SIMILARITY_THRESHOLD = 0.4;
  const MIN_PATTERN_SIZE = 3;
  const MAX_AVG_RATING = 4;

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

  const candidates: Pattern[] = [];
  let skipped = 0;

  for (const cluster of clusters) {
    const avgRating = cluster.reduce((s, e) => s + e.rating, 0) / cluster.length;
    if (cluster.length < MIN_PATTERN_SIZE || avgRating > MAX_AVG_RATING) {
      skipped++;
      continue;
    }

    const summaries = cluster.map((e) => e.sentimentSummary!);
    const ruleName = deriveRuleName(summaries);
    const sessions = cluster.map((e) => e.timestamp);

    candidates.push({
      id: `review-${ruleName}-${Date.now()}`,
      type: "failure-cluster",
      frequency: cluster.length,
      sessions,
      severity: Math.round((MAX_AVG_RATING - avgRating + 1) * 2),
      candidateRule: `When patterns around "${ruleName}" appear, verify facts before responding.`,
      firstSeen: sessions[sessions.length - 1],
      lastSeen: sessions[0],
    });
  }

  return {
    patternsFound: clusters.length,
    candidatesProposed: candidates.length,
    skipped,
    candidates,
    scoreTrend,
  };
}
