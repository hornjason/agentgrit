import { hillClimb } from "./hill-climb";
import type { HillClimbResult } from "./hill-climb";

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
