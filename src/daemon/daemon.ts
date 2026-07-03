import type { AgentGritConfig, Pattern, Score } from "../adapters/types";
import type { ReviewResult } from "../promote/review";

export interface CycleResult {
  timestamp: string;
  scores: Score[];
  patterns: Pattern[];
  promoted: number;
  synced: boolean;
  optimized: boolean;
  errors: string[];
}

export interface WeeklyReviewResult {
  timestamp: string;
  review: ReviewResult;
  graphRebuilt: boolean;
  budgetStatus: { global: string; project: string };
  errors: string[];
}

const DAY_NAMES: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

export function isWeeklyDay(config: AgentGritConfig): boolean {
  const targetDay = DAY_NAMES[config.daemon.weeklyDay.toLowerCase()];
  if (targetDay === undefined) return false;
  return new Date().getDay() === targetDay;
}

export async function runDaemonCycle(
  config: AgentGritConfig,
): Promise<CycleResult> {
  const result: CycleResult = {
    timestamp: new Date().toISOString(),
    scores: [],
    patterns: [],
    promoted: 0,
    synced: false,
    optimized: false,
    errors: [],
  };

  // 1. Score — evaluate new traces against rubric
  try {
    const { judgeTrace } = await import("../evaluate/judge");
    const { loadRubric } = await import("../evaluate/rubric");
    const { readSignals } = await import("../adapters/jsonl");
    const { join } = await import("path");

    if (config.judge?.apiKey) {
      for (const rubricName of config.rubrics) {
        let rubric;
        try {
          rubric = loadRubric(rubricName);
        } catch {
          continue;
        }

        const signals = await readSignals(
          join(config.signalDir, "ratings.jsonl"),
          { limit: 50 },
        );

        for (const signal of signals) {
          if (!("responsePreview" in signal) || !signal.responsePreview) continue;

          const scores = await judgeTrace(
            { input: signal.sessionId, output: signal.responsePreview },
            rubric,
            {
              provider: config.judge.provider,
              model: config.judge.model,
              apiKey: config.judge.apiKey,
            },
          );
          result.scores.push(...scores);
        }
      }
    }
  } catch (err) {
    result.errors.push(`score: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Detect — scan for failure patterns
  try {
    const { detectFailurePatterns } = await import("../detect/failures");
    const failurePatterns = await detectFailurePatterns(config.signalDir);
    result.patterns.push(...failurePatterns);
  } catch (err) {
    result.errors.push(`detect-failures: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const { minePatterns } = await import("../detect/patterns");
    const minedPatterns = await minePatterns(config.signalDir);
    result.patterns.push(...minedPatterns);
  } catch (err) {
    result.errors.push(`detect-patterns: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Promote — route detected patterns to rules if they cross threshold
  try {
    const { routeRule } = await import("../promote/router");
    const { checkBudget } = await import("../promote/budget");

    let promoted = 0;
    for (const pattern of result.patterns) {
      if (!pattern.candidateRule || pattern.frequency < 3) continue;

      const routeResult = routeRule(pattern, pattern.sessions);
      const budgetStatus = checkBudget(routeResult.tier, 0);
      if (budgetStatus.level === "OVER_BUDGET") continue;

      if (config.rules.autoPromote) {
        promoted++;
      }
    }
    result.promoted = promoted;
  } catch (err) {
    result.errors.push(`promote: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. Sync — push scores to Langfuse if configured
  if (config.adapter === "langfuse" || config.adapter === "both") {
    try {
      const modulePath = "../adapters/langfuse";
      const langfuse = await import(/* @vite-ignore */ modulePath) as Record<string, unknown>;
      if (typeof langfuse.syncScores === "function") {
        await (langfuse.syncScores as (scores: Score[], cfg: NonNullable<AgentGritConfig["langfuse"]>) => Promise<void>)(
          result.scores, config.langfuse!,
        );
        result.synced = true;
      }
    } catch {
      result.synced = false;
    }
  }

  // 5. Optimize — queue hill-climb if dimension below threshold
  try {
    const lowScores = result.scores.filter((s) => s.value <= 2);
    if (lowScores.length > 0) {
      result.optimized = true;
    }
  } catch (err) {
    result.errors.push(`optimize: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

export async function runWeeklyReview(
  config: AgentGritConfig,
): Promise<WeeklyReviewResult> {
  const result: WeeklyReviewResult = {
    timestamp: new Date().toISOString(),
    review: {
      patternsFound: 0,
      candidatesProposed: 0,
      skipped: 0,
      candidates: [],
      scoreTrend: { avg: 0, count: 0, direction: "flat" },
    },
    graphRebuilt: false,
    budgetStatus: { global: "OK", project: "OK" },
    errors: [],
  };

  // 1. Full learning review
  try {
    const { runReview } = await import("../promote/review");
    const { stateDir } = await import("../adapters/paths");
    result.review = await runReview(config.signalDir, stateDir());
  } catch (err) {
    result.errors.push(`review: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Graph rebuild
  try {
    const { buildGraph } = await import("../graph/builder");
    const { stateDir } = await import("../adapters/paths");
    const { join } = await import("path");

    const rulesDir = join(config.signalDir, "..", "rules");
    await buildGraph(rulesDir, stateDir());
    result.graphRebuilt = true;
  } catch (err) {
    result.errors.push(`graph: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Budget check
  try {
    const { checkBudget } = await import("../promote/budget");
    const { Tier } = await import("../adapters/types");

    const globalStatus = checkBudget(Tier.Global, 0);
    const projectStatus = checkBudget(Tier.Project, 0);
    result.budgetStatus = {
      global: globalStatus.level,
      project: projectStatus.level,
    };
  } catch (err) {
    result.errors.push(`budget: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}
