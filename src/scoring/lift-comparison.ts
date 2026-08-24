import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { computeOutcomeScore, type OutcomeEvent } from "../capture/outcomes";
import { loadRuleStats, computeDifferentialLift, type RuleStats } from "../promote/rules";
import { stateDir as defaultStateDir, resolveSignalDir } from "../adapters/paths";

export interface LiftComparison {
  ruleId: string;
  keywordLift: number;
  outcomeLift: number;
  delta: number;
  agreement: "agree" | "diverge" | "insufficient-data";
}

interface RatingEntry {
  session_id: string;
  rating: number;
  rule_ids?: string[];
}

function readAllRatings(signalDir: string): RatingEntry[] {
  const ratingsPath = join(signalDir, "ratings.jsonl");
  if (!existsSync(ratingsPath)) return [];

  const content = readFileSync(ratingsPath, "utf-8");
  const entries: RatingEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch { /* skip */ }
  }
  return entries;
}

function readAllOutcomes(dir: string): OutcomeEvent[] {
  const filePath = join(dir, "outcome-events.jsonl");
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, "utf-8");
  const events: OutcomeEvent[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as OutcomeEvent);
    } catch { /* skip */ }
  }
  return events;
}

function computeGlobalKeywordAvg(ratings: RatingEntry[]): number {
  if (ratings.length === 0) return 6.0;
  const sum = ratings.reduce((acc, r) => acc + r.rating, 0);
  return sum / ratings.length;
}

function computeOutcomeLiftForRule(
  ruleId: string,
  ratings: RatingEntry[],
  outcomesBySession: Map<string, OutcomeEvent[]>,
  globalOutcomeAvg: number,
): { lift: number; hasData: boolean } {
  const ruleSessionIds = new Set<string>();
  for (const r of ratings) {
    if (r.rule_ids?.includes(ruleId)) {
      ruleSessionIds.add(r.session_id);
    }
  }

  if (ruleSessionIds.size === 0) return { lift: 0, hasData: false };

  let hasAnyOutcomes = false;
  const outcomeScores: number[] = [];

  for (const sessionId of ruleSessionIds) {
    const events = outcomesBySession.get(sessionId) ?? [];
    if (events.length > 0) {
      hasAnyOutcomes = true;
      outcomeScores.push(computeOutcomeScore(events));
    }
  }

  if (!hasAnyOutcomes) return { lift: 0, hasData: false };

  const ruleOutcomeAvg = outcomeScores.reduce((a, b) => a + b, 0) / outcomeScores.length;
  return {
    lift: Math.round((ruleOutcomeAvg - globalOutcomeAvg) * 1000) / 1000,
    hasData: true,
  };
}

export function compareLiftMethods(
  stateOverride?: string,
  signalOverride?: string,
): LiftComparison[] {
  const sd = stateOverride ?? defaultStateDir();
  const sig = signalOverride ?? resolveSignalDir();

  const statsMap = loadRuleStats(sd);
  const ratings = readAllRatings(sig);
  const allOutcomes = readAllOutcomes(sd);

  const globalKeywordAvg = computeGlobalKeywordAvg(ratings);

  const outcomesBySession = new Map<string, OutcomeEvent[]>();
  for (const event of allOutcomes) {
    const existing = outcomesBySession.get(event.sessionId) ?? [];
    existing.push(event);
    outcomesBySession.set(event.sessionId, existing);
  }

  const allSessionOutcomeScores: number[] = [];
  for (const events of outcomesBySession.values()) {
    allSessionOutcomeScores.push(computeOutcomeScore(events));
  }
  const globalOutcomeAvg = allSessionOutcomeScores.length > 0
    ? allSessionOutcomeScores.reduce((a, b) => a + b, 0) / allSessionOutcomeScores.length
    : 5.0;

  const results: LiftComparison[] = [];

  for (const [ruleId, stats] of statsMap) {
    const rawLift = stats.differentialLift ?? computeDifferentialLift(
      stats.sessionRatings,
      globalKeywordAvg,
    );
    const keywordLift = Number.isNaN(rawLift) ? 0 : rawLift;

    const { lift: outcomeLift, hasData } = computeOutcomeLiftForRule(
      ruleId, ratings, outcomesBySession, globalOutcomeAvg,
    );

    let agreement: LiftComparison["agreement"];
    if (!hasData) {
      agreement = "insufficient-data";
    } else if ((keywordLift >= 0 && outcomeLift >= 0) || (keywordLift < 0 && outcomeLift < 0)) {
      agreement = "agree";
    } else {
      agreement = "diverge";
    }

    results.push({
      ruleId,
      keywordLift: Math.round(keywordLift * 1000) / 1000,
      outcomeLift: Math.round(outcomeLift * 1000) / 1000,
      delta: Math.round((outcomeLift - keywordLift) * 1000) / 1000,
      agreement,
    });
  }

  return results.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}
