import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { stateDir } from "../adapters/paths";
import { loadConfig } from "../adapters/paths";
import type { Rule } from "../adapters/types";

const MAX_SESSION_RATINGS = 20;
const RULE_STATS_FILE = "rule-stats.json";
const _rulesCfg = loadConfig();
const DEFAULT_DECAY_HALF_LIFE = _rulesCfg.thresholds?.decayHalfLife ?? 10;

export interface RuleStats {
  ruleId: string;
  injectionCount: number;
  avgCorrelatedRating: number;
  sessionRatings: number[];
  highRatingActivations: number;
  lowRatingActivations: number;
  lastSeen: string;
  noisePenalty?: number;
  rawAvgRating?: number;
  decayedRating?: number;
}

export function computeDecayedAverage(ratings: number[], halfLife: number = DEFAULT_DECAY_HALF_LIFE): number {
  if (ratings.length === 0) return 0;
  const lambda = Math.log(2) / halfLife;
  let weightedSum = 0;
  let totalWeight = 0;
  for (let i = 0; i < ratings.length; i++) {
    const ageIndex = ratings.length - 1 - i;
    const weight = Math.exp(-lambda * ageIndex);
    weightedSum += ratings[i] * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

export function trackRule(rule: Rule, sessionRating: number): Rule {
  const now = new Date().toISOString();
  const ratings = [...(rule.sessionRatings ?? []), sessionRating].slice(
    -MAX_SESSION_RATINGS,
  );
  const decayed = computeDecayedAverage(ratings);
  const rawAvg = ratings.reduce((sum, r) => sum + r, 0) / ratings.length;

  return {
    ...rule,
    injectionCount: (rule.injectionCount ?? 0) + 1,
    avgCorrelatedRating: decayed,
    rawAvgRating: Math.round(rawAvg * 100) / 100,
    decayedRating: Math.round(decayed * 100) / 100,
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
  const STALE_DAYS = 60;
  const now = Date.now();

  function isStale(r: Rule): boolean {
    if (!r.lastSeen) return false;
    const daysSince = (now - new Date(r.lastSeen).getTime()) / (1000 * 60 * 60 * 24);
    return daysSince > STALE_DAYS;
  }

  return rules
    .filter((r) => (r.injectionCount ?? 0) > MIN_INJECTION_COUNT)
    .sort((a, b) => {
      const aStale = isStale(a);
      const bStale = isStale(b);
      if (aStale !== bStale) return aStale ? -1 : 1;
      const ratingDiff =
        (a.avgCorrelatedRating ?? 0) - (b.avgCorrelatedRating ?? 0);
      if (ratingDiff !== 0) return ratingDiff;
      const lowDiff =
        (b.lowRatingActivations ?? 0) - (a.lowRatingActivations ?? 0);
      if (lowDiff !== 0) return lowDiff;
      return (b.injectionCount ?? 0) - (a.injectionCount ?? 0);
    })
    .slice(0, topN);
}

export function trackAttributedRules(
  rules: Rule[],
  attributedRuleIds: string[],
  sessionRating: number,
): Rule[] {
  const idSet = new Set(attributedRuleIds);
  return rules.map((rule) =>
    idSet.has(rule.id) ? trackRule(rule, sessionRating) : rule,
  );
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
    ...(r.rawAvgRating !== undefined && { rawAvgRating: r.rawAvgRating }),
    ...(r.decayedRating !== undefined && { decayedRating: r.decayedRating }),
  }));
}

export function ruleStatsPath(dir?: string): string {
  return join(dir ?? stateDir(), RULE_STATS_FILE);
}

export function loadRuleStats(dir?: string): Map<string, RuleStats> {
  const filePath = ruleStatsPath(dir);
  if (!existsSync(filePath)) return new Map();
  try {
    const entries = JSON.parse(readFileSync(filePath, "utf-8")) as RuleStats[];
    return new Map(entries.map((s) => [s.ruleId, s]));
  } catch {
    return new Map();
  }
}

export function persistRuleStats(stats: RuleStats[], dir?: string): void {
  const filePath = ruleStatsPath(dir);
  const parent = dirname(filePath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  writeFileSync(filePath, JSON.stringify(stats, null, 2), "utf-8");
}

export interface BootstrapResult {
  rulesTracked: number;
  sessionsProcessed: number;
  ratingsMatched: number;
}

export function bootstrapRuleStats(
  sessionHistoryPath: string,
  ratingsPath: string,
  outputDir?: string,
): BootstrapResult {
  const result: BootstrapResult = { rulesTracked: 0, sessionsProcessed: 0, ratingsMatched: 0 };

  if (!existsSync(sessionHistoryPath)) return result;
  if (!existsSync(ratingsPath)) return result;

  // Parse ratings — build a lookup by timestamp (closest match)
  interface RatingEntry { timestamp: string; rating: number; rule_ids?: string[] }
  const ratings: RatingEntry[] = [];
  for (const line of readFileSync(ratingsPath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { ratings.push(JSON.parse(line)); } catch {}
  }

  // Parse session history — each entry has ruleIds and timestamp
  interface SessionEntry { ruleIds: string[]; timestamp: string }
  const sessions: SessionEntry[] = [];
  for (const line of readFileSync(sessionHistoryPath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { sessions.push(JSON.parse(line)); } catch {}
  }

  const statsMap = new Map<string, RuleStats>();

  // Strategy 1: ratings.jsonl entries that have rule_ids (direct attribution)
  for (const r of ratings) {
    if (!r.rule_ids || r.rule_ids.length === 0 || !r.rating) continue;
    if (r.rule_ids.every(id => id.startsWith("rule-"))) continue;
    result.ratingsMatched++;
    for (const ruleId of r.rule_ids) {
      const existing = statsMap.get(ruleId);
      const sessionRatings = [...(existing?.sessionRatings ?? []), r.rating].slice(-MAX_SESSION_RATINGS);
      const avg = computeDecayedAverage(sessionRatings);
      statsMap.set(ruleId, {
        ruleId,
        injectionCount: (existing?.injectionCount ?? 0) + 1,
        avgCorrelatedRating: avg,
        sessionRatings,
        highRatingActivations: (existing?.highRatingActivations ?? 0) + (r.rating >= 7 ? 1 : 0),
        lowRatingActivations: (existing?.lowRatingActivations ?? 0) + (r.rating <= 4 ? 1 : 0),
        lastSeen: r.timestamp ?? existing?.lastSeen ?? "",
      });
    }
  }

  // Strategy 2: match session-context-history entries to ratings by time proximity
  for (const session of sessions) {
    if (!session.ruleIds || session.ruleIds.length === 0) continue;
    result.sessionsProcessed++;

    const sessionTime = new Date(session.timestamp).getTime();
    // Find closest rating within 24h window
    let closestRating: RatingEntry | null = null;
    let closestDelta = Infinity;
    for (const r of ratings) {
      if (!r.rating) continue;
      const delta = Math.abs(new Date(r.timestamp).getTime() - sessionTime);
      if (delta < closestDelta && delta < 24 * 60 * 60 * 1000) {
        closestDelta = delta;
        closestRating = r;
      }
    }

    if (!closestRating) continue;
    // Skip if this rating was already processed via rule_ids in Strategy 1
    if (closestRating.rule_ids && closestRating.rule_ids.length > 0) continue;

    result.ratingsMatched++;
    for (const ruleId of session.ruleIds) {
      const existing = statsMap.get(ruleId);
      const sessionRatings = [...(existing?.sessionRatings ?? []), closestRating.rating].slice(-MAX_SESSION_RATINGS);
      const avg = computeDecayedAverage(sessionRatings);
      statsMap.set(ruleId, {
        ruleId,
        injectionCount: (existing?.injectionCount ?? 0) + 1,
        avgCorrelatedRating: avg,
        sessionRatings,
        highRatingActivations: (existing?.highRatingActivations ?? 0) + (closestRating.rating >= 7 ? 1 : 0),
        lowRatingActivations: (existing?.lowRatingActivations ?? 0) + (closestRating.rating <= 4 ? 1 : 0),
        lastSeen: session.timestamp ?? existing?.lastSeen ?? "",
      });
    }
  }

  result.rulesTracked = statsMap.size;
  if (statsMap.size > 0) {
    persistRuleStats(Array.from(statsMap.values()), outputDir);
  }

  return result;
}
