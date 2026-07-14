import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { getBaseDir, loadConfig } from "../adapters/paths";
import type { AgentGritConfig } from "../adapters/types";
import type { Graph, BM25Index } from "../graph/types";
import type { GoldSet } from "../evaluate/gold";
import { getContextRules } from "../graph/context";
import { precisionAtK } from "../evaluate/recall";

export interface WeightOptResult {
  bestWeights: { bm25: number; graph: number; vector: number };
  bestScore: number;
  iterations: number;
  history: Array<{ weights: { bm25: number; graph: number; vector: number }; score: number }>;
}

const BASELINE_FLOOR = 0.76;
const STEP = 0.25;
const STALL_LIMIT = 5;
const WEIGHT_KEYS = ["bm25", "graph", "vector"] as const;

async function evaluateWeights(
  weights: { bm25: number; graph: number; vector: number },
  goldSet: GoldSet,
  graph: Graph,
  index: BM25Index,
): Promise<number> {
  let totalPrecision = 0;
  let count = 0;

  for (const session of Object.values(goldSet.labeled)) {
    const relevantRules = session.relevantRules ?? [];
    if (relevantRules.length === 0) continue;

    const domains = session.domains ?? [];
    const queryText = session.task_context ?? session.description ?? "";
    const retrieved = await getContextRules(graph, index, domains, 5, undefined, queryText);
    const retrievedIds = retrieved.map(r => r.id);
    totalPrecision += precisionAtK(relevantRules, retrievedIds, 5);
    count++;
  }

  return count > 0 ? totalPrecision / count : 0;
}

export async function optimizeRRFWeights(opts: {
  goldSetPath: string;
  graph: Graph;
  index: BM25Index;
  maxIterations?: number;
  stateDir?: string;
}): Promise<WeightOptResult> {
  const maxIterations = opts.maxIterations ?? 20;
  const goldRaw = readFileSync(opts.goldSetPath, "utf-8");
  const goldSet = JSON.parse(goldRaw) as GoldSet;

  const current = { bm25: 2, graph: 0.5, vector: 1 };
  let bestWeights = { ...current };
  let bestScore = await evaluateWeights(current, goldSet, opts.graph, opts.index);
  const baselineScore = bestScore;

  const history: Array<{ weights: { bm25: number; graph: number; vector: number }; score: number }> = [
    { weights: { ...current }, score: bestScore },
  ];

  let stall = 0;

  for (let i = 0; i < maxIterations && stall < STALL_LIMIT; i++) {
    let improved = false;

    for (const key of WEIGHT_KEYS) {
      for (const delta of [STEP, -STEP]) {
        const candidate = { ...bestWeights };
        candidate[key] = Math.max(0, candidate[key] + delta);

        if (candidate[key] === bestWeights[key]) continue;

        const score = await evaluateWeights(candidate, goldSet, opts.graph, opts.index);
        history.push({ weights: { ...candidate }, score });

        if (score > bestScore) {
          bestWeights = { ...candidate };
          bestScore = score;
          improved = true;
        }
      }
    }

    if (!improved) {
      stall++;
    } else {
      stall = 0;
    }
  }

  if (bestScore < baselineScore || bestScore < BASELINE_FLOOR) {
    return {
      bestWeights: { bm25: 2, graph: 0.5, vector: 1 },
      bestScore: baselineScore,
      iterations: history.length - 1,
      history,
    };
  }

  if (opts.stateDir) {
    const logPath = join(opts.stateDir, "weight-opt.json");
    const dir = dirname(logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(logPath, JSON.stringify({ bestWeights, bestScore, history }, null, 2));
  }

  return { bestWeights, bestScore, iterations: history.length - 1, history };
}

export function writeOptimalWeights(weights: { bm25: number; graph: number; vector: number }): void {
  const configPath = join(getBaseDir(), "config.json");
  let config: AgentGritConfig;

  if (existsSync(configPath)) {
    config = JSON.parse(readFileSync(configPath, "utf-8")) as AgentGritConfig;
  } else {
    const dir = dirname(configPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    config = { signalDir: join(getBaseDir(), "signals") } as AgentGritConfig;
  }

  config.rrfWeights = { bm25: weights.bm25, graph: weights.graph, vector: weights.vector };
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}
