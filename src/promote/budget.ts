import { Tier } from "../adapters/types";

const DEFAULT_CAPS: Record<Tier, number> = {
  [Tier.Global]: 25,
  [Tier.Project]: 25,
  [Tier.Graph]: Infinity,
};

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
