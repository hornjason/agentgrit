import type { Score, RubricConfig, Dimension } from "../adapters/types";
import type { JudgeConfig, Trace } from "../evaluate/judge";
import { judgeTrace } from "../evaluate/judge";
import { hillClimb } from "./hill-climb";
import type { HillClimbResult } from "./hill-climb";

export interface TraceFetcher {
  fetchLowestScoring(dimension: string, count: number): Promise<TraceWithScore[]>;
}

export interface TraceWithScore {
  trace: Trace;
  score: number;
  systemPrompt: string;
  userPrompt: string;
}

export interface PromptProposer {
  propose(currentPrompt: string, targetDimension: Dimension, badOutputs: string[]): Promise<string>;
}

export interface ContentGenerator {
  generate(systemPrompt: string, userPrompt: string): Promise<string | null>;
}

export interface PromptTuneConfig {
  dimension: string;
  rubric: RubricConfig;
  judgeConfig: JudgeConfig;
  fetcher: TraceFetcher;
  proposer: PromptProposer;
  generator: ContentGenerator;
  testSize: number;
  rounds: number;
  stateDir: string;
}

export interface PromptTuneResult {
  originalPrompt: string;
  bestPrompt: string;
  baselineScores: Record<string, number>;
  finalScores: Record<string, number>;
  baselineWeighted: number;
  finalWeighted: number;
  totalDelta: number;
  roundsKept: number;
  hillClimbResult: HillClimbResult;
}

function weightedAverage(scores: Record<string, number>, dimensions: Dimension[]): number {
  let totalWeight = 0;
  let weightedSum = 0;
  for (const dim of dimensions) {
    const val = scores[dim.name];
    if (typeof val === "number") {
      weightedSum += val * dim.weight;
      totalWeight += dim.weight;
    }
  }
  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

function averageDimensionScores(
  allScores: Record<string, number>[],
  dimensions: Dimension[],
): Record<string, number> {
  const sums: Record<string, number> = {};
  const counts: Record<string, number> = {};
  for (const scores of allScores) {
    for (const dim of dimensions) {
      const val = scores[dim.name];
      if (typeof val === "number") {
        sums[dim.name] = (sums[dim.name] || 0) + val;
        counts[dim.name] = (counts[dim.name] || 0) + 1;
      }
    }
  }
  const avgs: Record<string, number> = {};
  for (const dim of dimensions) {
    if (counts[dim.name]) {
      avgs[dim.name] = sums[dim.name] / counts[dim.name];
    }
  }
  return avgs;
}

async function scorePromptAgainstTraces(
  systemPrompt: string,
  testCases: TraceWithScore[],
  rubric: RubricConfig,
  judgeConfig: JudgeConfig,
  generator: ContentGenerator,
): Promise<Record<string, number>> {
  const allScores: Record<string, number>[] = [];

  for (const tc of testCases) {
    const output = await generator.generate(systemPrompt, tc.userPrompt);
    if (!output) continue;

    const scores = await judgeTrace(
      { input: tc.userPrompt, output, id: tc.trace.id },
      rubric,
      judgeConfig,
    );

    if (scores.length > 0) {
      const perDim: Record<string, number> = {};
      for (const s of scores) {
        perDim[s.dimension] = s.value;
      }
      allScores.push(perDim);
    }
  }

  return averageDimensionScores(allScores, rubric.dimensions);
}

export async function tunePrompt(config: PromptTuneConfig): Promise<PromptTuneResult> {
  const targetDimension = config.rubric.dimensions.find((d) => d.name === config.dimension);
  if (!targetDimension) {
    throw new Error(`Unknown dimension "${config.dimension}". Available: ${config.rubric.dimensions.map((d) => d.name).join(", ")}`);
  }

  const testCases = await config.fetcher.fetchLowestScoring(config.dimension, config.testSize);
  if (testCases.length === 0) {
    throw new Error(`No traces found for dimension "${config.dimension}"`);
  }

  const promptCounts = new Map<string, number>();
  for (const tc of testCases) {
    promptCounts.set(tc.systemPrompt, (promptCounts.get(tc.systemPrompt) || 0) + 1);
  }
  let originalPrompt = "";
  let maxCount = 0;
  for (const [prompt, count] of promptCounts) {
    if (count > maxCount) {
      originalPrompt = prompt;
      maxCount = count;
    }
  }

  const baselineScores = await scorePromptAgainstTraces(
    originalPrompt,
    testCases,
    config.rubric,
    config.judgeConfig,
    config.generator,
  );
  const baselineWeighted = weightedAverage(baselineScores, config.rubric.dimensions);

  const hillClimbResult = await hillClimb({
    current: originalPrompt,
    rounds: config.rounds,
    stateDir: config.stateDir,
    weakDimension: config.dimension,
    evaluate: async (promptText: string) => {
      const scores = await scorePromptAgainstTraces(
        promptText,
        testCases,
        config.rubric,
        config.judgeConfig,
        config.generator,
      );
      return weightedAverage(scores, config.rubric.dimensions);
    },
    propose: async (currentPrompt: string) => {
      const badOutputs: string[] = [];
      for (const tc of testCases.slice(0, 3)) {
        const out = await config.generator.generate(currentPrompt, tc.userPrompt);
        if (out) badOutputs.push(out);
      }
      return config.proposer.propose(currentPrompt, targetDimension, badOutputs);
    },
  });

  const finalScores = await scorePromptAgainstTraces(
    hillClimbResult.finalText,
    testCases,
    config.rubric,
    config.judgeConfig,
    config.generator,
  );
  const finalWeighted = weightedAverage(finalScores, config.rubric.dimensions);

  return {
    originalPrompt,
    bestPrompt: hillClimbResult.finalText,
    baselineScores,
    finalScores,
    baselineWeighted,
    finalWeighted,
    totalDelta: finalWeighted - baselineWeighted,
    roundsKept: hillClimbResult.kept,
    hillClimbResult,
  };
}
