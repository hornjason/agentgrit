/**
 * skill-tuner.ts — Skill evaluation and tuning via hill-climb
 *
 * Consolidated from:
 *   - PAI Tools/SkillEvaluator.ts — behavioral scoring with LLM-as-judge
 *   - PAI Tools/SkillEvaluatorFast.ts — deterministic regex-based scoring
 *   - PAI Tools/SkillOptimizer.ts — skill-specific hill-climb logic
 *
 * Two evaluation modes:
 *   - evaluateSkill(): LLM-as-judge with per-criterion pass/fail
 *   - fastEvaluate(): Deterministic regex patterns, zero LLM variance
 *
 * Both feed into tuneSkill() which uses the hill-climb engine.
 */

import { hillClimb } from "./hill-climb";
import type { HillClimbResult } from "./hill-climb";

// ── Interfaces ──

export interface SkillEvaluator {
  evaluate(skillText: string): Promise<SkillEvalResult>;
}

export interface SkillEvalResult {
  compositeScore: number;
  behavioralScore: number;
  taskSuccessProxy: number;
  perCriteria: { name: string; passed: boolean }[];
}

export interface SkillProposer {
  propose(skillText: string, lowestCriteria: string[]): Promise<string>;
}

export interface SkillTuneConfig {
  skillText: string;
  evaluator: SkillEvaluator;
  proposer: SkillProposer;
  rounds: number;
  stateDir: string;
  maxChangeRatio?: number;
}

export interface SkillTuneResult {
  originalText: string;
  bestText: string;
  initialScore: number;
  finalScore: number;
  totalDelta: number;
  roundsKept: number;
  hillClimbResult: HillClimbResult;
  lowestCriteria: string[];
}

// ── Deterministic Criterion ──

export interface Criterion {
  label: string;
  patterns: RegExp[];
  minMatches: number;
  precedes?: {
    anchor: RegExp;
    target: RegExp;
  };
}

// ── Task Success Proxy (Pearson correlation) ──

function pearsonCorrelation(scores: number[], ratings: number[]): number {
  if (scores.length < 2) return 0;
  const n = scores.length;
  const meanScore = scores.reduce((a, b) => a + b, 0) / n;
  const meanRating = ratings.reduce((a, b) => a + b, 0) / n;
  let cov = 0, varScore = 0, varRating = 0;
  for (let i = 0; i < n; i++) {
    const ds = scores[i] - meanScore;
    const dr = ratings[i] - meanRating;
    cov += ds * dr;
    varScore += ds * ds;
    varRating += dr * dr;
  }
  if (varScore === 0 || varRating === 0) return 0;
  return (cov / Math.sqrt(varScore * varRating) + 1) / 2;
}

// ── Deterministic Scoring (regex-based) ──

export function scoreDeterministic(agentResponse: string, criteria: Criterion[]): boolean[] {
  return criteria.map((criterion) => {
    const matchCount = criterion.patterns.filter((p) => p.test(agentResponse)).length;
    const patternPass = matchCount >= criterion.minMatches;

    if (!criterion.precedes) return patternPass;

    // PRECEDES: anchor must appear before target in text
    const anchorMatch = criterion.precedes.anchor.exec(agentResponse);
    const targetMatch = criterion.precedes.target.exec(agentResponse);
    if (!anchorMatch || !targetMatch) return false;
    return patternPass && anchorMatch.index < targetMatch.index;
  });
}

// ── Fast Evaluate (deterministic, no LLM judge) ──

export interface FastEvalConfig {
  criteria: Criterion[];
  simulate: (skillText: string, taskPrompt: string) => Promise<string>;
  tasks: Array<{ id: string; task: string; rating: number }>;
  samples?: number;
}

export interface FastEvalResult {
  compositeScore: number;
  behavioralScore: number;
  taskSuccessProxy: number;
  perCriteria: { name: string; passed: boolean }[];
  taskResults: Array<{
    taskId: string;
    behavioralScore: number;
    criteriaAnswers: boolean[];
  }>;
}

export async function fastEvaluate(
  skillText: string,
  config: FastEvalConfig,
): Promise<FastEvalResult> {
  const { criteria, simulate, tasks, samples = 1 } = config;
  const taskResults: FastEvalResult["taskResults"] = [];

  for (const task of tasks) {
    const sampleAnswers: boolean[][] = [];

    for (let s = 0; s < samples; s++) {
      const response = await simulate(skillText, task.task);
      sampleAnswers.push(scoreDeterministic(response, criteria));
    }

    // Majority vote per criterion across samples
    const avgAnswers = criteria.map((_, ci) => {
      const trueCount = sampleAnswers.filter((a) => a[ci]).length;
      return trueCount > samples / 2;
    });

    const behavioralScore = avgAnswers.filter(Boolean).length / criteria.length;
    taskResults.push({ taskId: task.id, behavioralScore, criteriaAnswers: avgAnswers });
  }

  const behavioralScore = taskResults.reduce((sum, r) => sum + r.behavioralScore, 0) / taskResults.length;
  const taskSuccessProxy = pearsonCorrelation(
    taskResults.map((r) => r.behavioralScore),
    tasks.map((t) => t.rating),
  );

  // Aggregate per-criteria pass rates
  const perCriteria = criteria.map((c, ci) => {
    const passCount = taskResults.filter((r) => r.criteriaAnswers[ci]).length;
    return { name: c.label, passed: passCount > taskResults.length / 2 };
  });

  return {
    compositeScore: behavioralScore,
    behavioralScore,
    taskSuccessProxy,
    perCriteria,
    taskResults,
  };
}

// ── LLM-based Evaluate ──

export interface LLMEvalConfig {
  criteria: string[];
  simulate: (skillText: string, taskPrompt: string) => Promise<string>;
  judge: (agentResponse: string, criteria: string[]) => Promise<boolean[]>;
  tasks: Array<{ id: string; task: string; rating: number }>;
}

export async function evaluateSkill(
  skillText: string,
  config: LLMEvalConfig,
): Promise<SkillEvalResult> {
  const { criteria, simulate, judge, tasks } = config;
  const allScores: number[] = [];
  const allRatings: number[] = [];
  const criteriaPassCounts = new Array(criteria.length).fill(0);

  for (const task of tasks) {
    const response = await simulate(skillText, task.task);
    const answers = await judge(response, criteria);
    const score = answers.filter(Boolean).length / criteria.length;
    allScores.push(score);
    allRatings.push(task.rating);
    answers.forEach((passed, i) => { if (passed) criteriaPassCounts[i]++; });
  }

  const behavioralScore = allScores.reduce((a, b) => a + b, 0) / allScores.length;
  const taskSuccessProxy = pearsonCorrelation(allScores, allRatings);
  const compositeScore = behavioralScore * 0.75 + taskSuccessProxy * 0.25;

  const perCriteria = criteria.map((name, i) => ({
    name,
    passed: criteriaPassCounts[i] > tasks.length / 2,
  }));

  return { compositeScore, behavioralScore, taskSuccessProxy, perCriteria };
}

// ── Criteria Registries ──

export const FAST_CRITERIA_DEBUGGING: Criterion[] = [
  {
    label: "Environment verification",
    patterns: [
      /\b(port|container|environment|env)\b.*\b(verify|confirm|check|which)\b/i,
      /\b(verify|confirm|check)\b.*\b(port|container|environment|env)\b/i,
      /\bwhich (port|environment|container)\b/i,
      /\benvironment verification\b/i,
    ],
    minMatches: 1,
  },
  {
    label: "Batch diagnostic reads",
    patterns: [
      /\b(batch|single pass|one pass)\b/i,
      /\b(logs|state|cache|source).{0,40}(together|simultaneously|one pass|batch|at once)\b/i,
      /\bread all.{0,30}(logs|files|sources|at once)\b/i,
    ],
    minMatches: 1,
  },
  {
    label: "Single hypothesis",
    patterns: [
      /\b(one|single|1)\s+hypothesis\b/i,
      /\bhypothes[ie][sz]\b/i,
    ],
    minMatches: 1,
  },
  {
    label: "Single change",
    patterns: [
      /\b(one|single|1)\s+(change|fix|modification|edit|patch)\b/i,
      /\bone change at a time\b/i,
    ],
    minMatches: 1,
  },
  {
    label: "Backlog logging",
    patterns: [
      /\bBKL-\w+/,
      /\bBACKLOG\.md\b/i,
      /\b(log|record|add|file).{0,20}(backlog|BACKLOG)\b/i,
    ],
    minMatches: 1,
  },
  {
    label: "Regression test",
    patterns: [
      /\bregression test\b/i,
      /\bwrite.{0,20}test\b/i,
      /\badd.{0,20}test\b/i,
    ],
    minMatches: 1,
  },
  {
    label: "Full test suite",
    patterns: [
      /\bfull test suite\b/i,
      /\ball tests\b/i,
      /\brun.{0,30}(all|full|complete).{0,30}test/i,
    ],
    minMatches: 1,
  },
  {
    label: "Actionable and specific",
    patterns: [
      /\bread\b/i, /\bcheck\b/i, /\brun\b/i, /\bwrite\b/i,
      /\blog\b/i, /\bverify\b/i, /\bconfirm\b/i, /\bgrep\b/i,
      /\binspect\b/i, /\btest\b/i, /\bfix\b/i, /\bapply\b/i,
    ],
    minMatches: 4,
  },
];

export const CRITERIA_REGISTRY: Record<string, Criterion[]> = {
  "debugging-and-bug-fixes": FAST_CRITERIA_DEBUGGING,
};

export function getCriteriaForSkill(skillName?: string): Criterion[] {
  if (!skillName) return FAST_CRITERIA_DEBUGGING;
  for (const [key, criteria] of Object.entries(CRITERIA_REGISTRY)) {
    if (skillName.includes(key) || key.includes(skillName)) return criteria;
  }
  return FAST_CRITERIA_DEBUGGING;
}

// ── Tune Skill ──

function extractLowestCriteria(evalResult: SkillEvalResult): string[] {
  const failing = evalResult.perCriteria.filter((c) => !c.passed);
  if (failing.length > 0) return failing.map((c) => c.name);
  return evalResult.perCriteria
    .slice()
    .sort(() => Math.random() - 0.5)
    .slice(0, 2)
    .map((c) => c.name);
}

export async function tuneSkill(config: SkillTuneConfig): Promise<SkillTuneResult> {
  const baselineEval = await config.evaluator.evaluate(config.skillText);
  let lowestCriteria = extractLowestCriteria(baselineEval);

  const hillClimbResult = await hillClimb({
    current: config.skillText,
    rounds: config.rounds,
    stateDir: config.stateDir,
    maxChangeRatio: config.maxChangeRatio,
    weakDimension: lowestCriteria[0] ?? "",
    evaluate: async (text: string) => {
      const result = await config.evaluator.evaluate(text);
      lowestCriteria = extractLowestCriteria(result);
      return result.compositeScore;
    },
    propose: async (text: string) => {
      return config.proposer.propose(text, lowestCriteria);
    },
  });

  return {
    originalText: config.skillText,
    bestText: hillClimbResult.finalText,
    initialScore: hillClimbResult.initialScore,
    finalScore: hillClimbResult.finalScore,
    totalDelta: hillClimbResult.totalDelta,
    roundsKept: hillClimbResult.kept,
    hillClimbResult,
    lowestCriteria,
  };
}
