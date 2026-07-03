import type { Rule } from "../adapters/types";

export interface RecallResult {
  ruleRecall: number;
  skillRecall: number;
  ruleHits: string[];
  ruleMisses: string[];
  skillHits: string[];
  skillMisses: string[];
  totalExpectedRules: number;
  totalInjectedRules: number;
  totalExpectedSkills: number;
  totalInvokedSkills: number;
}

export function evaluateRecall(
  activeDomains: string[],
  injectedRules: Rule[],
  invokedSkills: string[],
  expectedSkills: string[],
  availableRules?: Rule[],
): RecallResult {
  const domainSet = new Set(activeDomains);

  const pool = availableRules ?? injectedRules;
  const expectedRules = pool.filter((r) =>
    r.tags.some((t) => domainSet.has(t)),
  );

  const injectedIds = new Set(injectedRules.map((r) => r.id));
  const ruleHits: string[] = [];
  const ruleMisses: string[] = [];

  for (const rule of expectedRules) {
    if (injectedIds.has(rule.id)) {
      ruleHits.push(rule.id);
    } else {
      ruleMisses.push(rule.id);
    }
  }

  const invokedSet = new Set(invokedSkills);
  const skillHits: string[] = [];
  const skillMisses: string[] = [];

  for (const skill of expectedSkills) {
    if (invokedSet.has(skill)) {
      skillHits.push(skill);
    } else {
      skillMisses.push(skill);
    }
  }

  const ruleRecall = expectedRules.length > 0 ? ruleHits.length / expectedRules.length : 1;
  const skillRecall = expectedSkills.length > 0 ? skillHits.length / expectedSkills.length : 1;

  return {
    ruleRecall: Math.round(ruleRecall * 1000) / 1000,
    skillRecall: Math.round(skillRecall * 1000) / 1000,
    ruleHits,
    ruleMisses,
    skillHits,
    skillMisses,
    totalExpectedRules: expectedRules.length,
    totalInjectedRules: injectedRules.length,
    totalExpectedSkills: expectedSkills.length,
    totalInvokedSkills: invokedSkills.length,
  };
}
