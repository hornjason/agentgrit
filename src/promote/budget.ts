import { existsSync, readFileSync, writeFileSync } from "fs";
import { Tier } from "../adapters/types";
import { loadConfig } from "../adapters/paths";
import { loadRuleStats } from "./rules";

const DEFAULT_CAPS: Record<Tier, number> = {
  [Tier.Global]: 25,
  [Tier.Project]: 25,
  [Tier.Graph]: Infinity,
};

const DEFAULT_LEARNED_CAP = 50;

export type BudgetLevel = "OK" | "WARNING" | "OVER_BUDGET";

export interface BudgetStatus {
  level: BudgetLevel;
  ruleCount: number;
  cap: number;
  remaining: number;
}

export function checkBudget(
  tier: Tier,
  ruleCount: number,
  cap?: number,
): BudgetStatus {
  const effectiveCap = cap ?? DEFAULT_CAPS[tier];

  if (!Number.isFinite(effectiveCap)) {
    return { level: "OK", ruleCount, cap: effectiveCap, remaining: Infinity };
  }

  const remaining = effectiveCap - ruleCount;

  if (ruleCount > effectiveCap) {
    return { level: "OVER_BUDGET", ruleCount, cap: effectiveCap, remaining };
  }

  const warningThreshold = effectiveCap - 5;
  if (ruleCount > warningThreshold) {
    return { level: "WARNING", ruleCount, cap: effectiveCap, remaining };
  }

  return { level: "OK", ruleCount, cap: effectiveCap, remaining };
}

export function checkLearnedBudget(
  count: number,
  cap?: number,
): BudgetStatus {
  const cfg = loadConfig();
  const effectiveCap = cap ?? cfg.rules?.learnedBudget ?? DEFAULT_LEARNED_CAP;

  const remaining = effectiveCap - count;

  if (count > effectiveCap) {
    return { level: "OVER_BUDGET", ruleCount: count, cap: effectiveCap, remaining };
  }

  const warningThreshold = effectiveCap - 5;
  if (count > warningThreshold) {
    return { level: "WARNING", ruleCount: count, cap: effectiveCap, remaining };
  }

  return { level: "OK", ruleCount: count, cap: effectiveCap, remaining };
}

export interface LearnedRule {
  id: string;
  line: string;
  correlationScore: number;
}

export interface PruneResult {
  pruned: string[];
  kept: number;
  total: number;
}

export function parseLearnedRules(content: string): LearnedRule[] {
  const lines = content.split("\n");
  const rules: LearnedRule[] = [];

  for (const line of lines) {
    const match = line.match(/^- \*\*(.+?)\*\*/);
    if (!match) continue;
    const id = match[1].replace(/:$/, "");
    rules.push({ id, line, correlationScore: 0 });
  }

  return rules;
}

export function pruneLearnedRules(
  learnedMdPath: string,
  cap: number,
  stateDir?: string,
): PruneResult {
  if (!existsSync(learnedMdPath)) {
    return { pruned: [], kept: 0, total: 0 };
  }

  const content = readFileSync(learnedMdPath, "utf-8");
  const rules = parseLearnedRules(content);
  const total = rules.length;

  if (total <= cap) {
    return { pruned: [], kept: total, total };
  }

  const statsMap = loadRuleStats(stateDir);

  for (const rule of rules) {
    const stats = statsMap.get(rule.id);
    if (stats) {
      rule.correlationScore = stats.avgCorrelatedRating;
    }
  }

  rules.sort((a, b) => a.correlationScore - b.correlationScore);

  const excess = total - cap;
  const toPrune = rules.slice(0, excess);
  const prunedIds = toPrune.map((r) => r.id);
  const pruneLines = new Set(toPrune.map((r) => r.line));

  const lines = content.split("\n");
  const filtered = lines.filter((line) => !pruneLines.has(line));
  writeFileSync(learnedMdPath, filtered.join("\n"), "utf-8");

  return { pruned: prunedIds, kept: total - excess, total };
}
