import type { Rule } from "../adapters/types";

// ── IR Metric Functions ──

export function recallAtK(goldIds: string[], retrieved: string[], k: number): number {
  if (goldIds.length === 0) return 0;
  const topK = retrieved.slice(0, k);
  const goldSet = new Set(goldIds);
  return topK.filter((id) => goldSet.has(id)).length / goldIds.length;
}

export function precisionAtK(goldIds: string[], retrieved: string[], k: number): number {
  if (k === 0) return 0;
  const topK = retrieved.slice(0, k);
  const goldSet = new Set(goldIds);
  return topK.filter((id) => goldSet.has(id)).length / k;
}

export function reciprocalRank(goldIds: string[], retrieved: string[]): number {
  const goldSet = new Set(goldIds);
  for (let i = 0; i < retrieved.length; i++) {
    if (goldSet.has(retrieved[i])) return 1 / (i + 1);
  }
  return 0;
}

export function bootstrapCI(scores: number[], iterations = 1000): [number, number] {
  if (scores.length === 0) return [0, 0];
  const means: number[] = [];
  const n = scores.length;
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += scores[Math.floor(Math.random() * n)];
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(iterations * 0.025)], means[Math.floor(iterations * 0.975)]];
}

// ── Domain-Aware Recall ──

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
  activeDomains: string[], injectedRules: Rule[], invokedSkills: string[],
  expectedSkills: string[], availableRules?: Rule[],
): RecallResult {
  const domainSet = new Set(activeDomains);
  const pool = availableRules ?? injectedRules;
  const expectedRules = pool.filter((r) => r.tags.some((t) => domainSet.has(t)));
  const injectedIds = new Set(injectedRules.map((r) => r.id));
  const ruleHits: string[] = [];
  const ruleMisses: string[] = [];
  for (const rule of expectedRules) {
    (injectedIds.has(rule.id) ? ruleHits : ruleMisses).push(rule.id);
  }
  const invokedSet = new Set(invokedSkills);
  const skillHits: string[] = [];
  const skillMisses: string[] = [];
  for (const skill of expectedSkills) {
    (invokedSet.has(skill) ? skillHits : skillMisses).push(skill);
  }
  const ruleRecall = expectedRules.length > 0 ? ruleHits.length / expectedRules.length : 1;
  const skillRecall = expectedSkills.length > 0 ? skillHits.length / expectedSkills.length : 1;
  return {
    ruleRecall: Math.round(ruleRecall * 1000) / 1000,
    skillRecall: Math.round(skillRecall * 1000) / 1000,
    ruleHits, ruleMisses, skillHits, skillMisses,
    totalExpectedRules: expectedRules.length, totalInjectedRules: injectedRules.length,
    totalExpectedSkills: expectedSkills.length, totalInvokedSkills: invokedSkills.length,
  };
}

// ── Session-Level Evaluation ──

export interface SessionRecallScore {
  sessionId: string; description: string; goldCount: number; retrievedIds: string[];
  recall3: number; recall5: number; recall10: number; recall15: number;
  precision5: number; mrr: number;
}

export interface RecallEvalResult {
  evaluatedAt: string; sessionsEvaluated: number; sessionsSkipped: number;
  meanRecall3: number; meanRecall5: number; meanRecall10: number; meanRecall15: number;
  meanPrecision5: number; meanMrr: number;
  ci95Recall15: [number, number]; ci95Recall5: [number, number];
  perSession: SessionRecallScore[];
}

function clusterRecallK(goldIds: string[], ranks: Map<string, number>, k: number): number {
  if (goldIds.length === 0) return 0;
  return goldIds.filter((id) => (ranks.get(id) ?? Infinity) < k).length / goldIds.length;
}

function clusterMRR(goldIds: string[], ranks: Map<string, number>): number {
  let best = Infinity;
  for (const id of goldIds) { const r = ranks.get(id) ?? Infinity; if (r < best) best = r; }
  return best === Infinity ? 0 : 1 / (best + 1);
}

export function evaluateSessionRecall(
  sessionId: string, description: string, goldRuleIds: string[],
  retrievedIds: string[], clusterNeighbors?: Map<string, string[]>,
): SessionRecallScore {
  const ranks = new Map<string, number>();
  retrievedIds.forEach((id, i) => {
    if (!ranks.has(id)) ranks.set(id, i);
    if (clusterNeighbors) {
      for (const n of clusterNeighbors.get(id) ?? []) { if (!ranks.has(n)) ranks.set(n, i); }
    }
  });
  return {
    sessionId, description, goldCount: goldRuleIds.length, retrievedIds,
    recall3: clusterRecallK(goldRuleIds, ranks, 3), recall5: clusterRecallK(goldRuleIds, ranks, 5),
    recall10: clusterRecallK(goldRuleIds, ranks, 10), recall15: clusterRecallK(goldRuleIds, ranks, 15),
    precision5: precisionAtK(goldRuleIds, retrievedIds, 5), mrr: clusterMRR(goldRuleIds, ranks),
  };
}

function mean(v: number[]): number { return v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length; }

export function aggregateRecallScores(sessions: SessionRecallScore[], skipped = 0): RecallEvalResult {
  const r5 = sessions.map((s) => s.recall5);
  const r15 = sessions.map((s) => s.recall15);
  return {
    evaluatedAt: new Date().toISOString(), sessionsEvaluated: sessions.length, sessionsSkipped: skipped,
    meanRecall3: mean(sessions.map((s) => s.recall3)), meanRecall5: mean(r5),
    meanRecall10: mean(sessions.map((s) => s.recall10)), meanRecall15: mean(r15),
    meanPrecision5: mean(sessions.map((s) => s.precision5)), meanMrr: mean(sessions.map((s) => s.mrr)),
    ci95Recall15: bootstrapCI(r15), ci95Recall5: bootstrapCI(r5), perSession: sessions,
  };
}
