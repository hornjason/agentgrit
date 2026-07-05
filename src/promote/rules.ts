import type { Rule } from "../adapters/types";

const MAX_SESSION_RATINGS = 20;

export interface RuleStats {
  ruleId: string;
  injectionCount: number;
  avgCorrelatedRating: number;
  sessionRatings: number[];
  highRatingActivations: number;
  lowRatingActivations: number;
  lastSeen: string;
}

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
  }));
}
