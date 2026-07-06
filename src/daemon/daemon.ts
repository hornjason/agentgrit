import type { AgentGritConfig, Pattern, Score } from "../adapters/types";
import type { ReviewResult } from "../promote/review";

export interface CleanupStats {
  staleFilesRemoved: number;
  sessionStatesCleared: number;
  signalsRotated: number;
  sessionsCompressed: number;
  counts: { signalFiles: number; ruleFiles: number; graphNodes: number } | null;
}

export interface CycleResult {
  timestamp: string;
  scores: Score[];
  patterns: Pattern[];
  promoted: number;
  synced: boolean;
  optimized: boolean;
  feedbackGenerated: number;
  successGenerated: number;
  workInsightsGenerated: number;
  cleanup: CleanupStats;
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
    feedbackGenerated: 0,
    successGenerated: 0,
    workInsightsGenerated: 0,
    cleanup: {
      staleFilesRemoved: 0,
      sessionStatesCleared: 0,
      signalsRotated: 0,
      sessionsCompressed: 0,
      counts: null,
    },
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
          if (!("response_preview" in signal) || !signal.response_preview) continue;

          const scores = await judgeTrace(
            { input: signal.session_id, output: signal.response_preview },
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

  // 3. AutoFeedback + AutoSuccess — extract lessons from extreme sessions
  try {
    const { generateFeedback, generateSuccess } = await import("./feedback");
    const { readSignals } = await import("../adapters/jsonl");
    const { resolveMemoryDir } = await import("../adapters/paths");
    const { join } = await import("path");

    const ratingsPath = join(config.signalDir, "ratings.jsonl");
    const allSignals = await readSignals(ratingsPath);
    const ratingSignals = allSignals.filter(
      (s): s is import("../adapters/types").RatingSignal => "type" in s && s.type === "rating",
    );

    if (ratingSignals.length > 0) {
      const memoryDir = resolveMemoryDir();

      const feedbackResult = await generateFeedback(ratingSignals, memoryDir);
      result.feedbackGenerated = feedbackResult.filesWritten.length;
      result.errors.push(...feedbackResult.errors);

      const successResult = await generateSuccess(ratingSignals, memoryDir);
      result.successGenerated = successResult.filesWritten.length;
      result.errors.push(...successResult.errors);

      // Rebuild graph if any feedback/success files were generated
      if (feedbackResult.filesWritten.length > 0 || successResult.filesWritten.length > 0) {
        try {
          const { buildGraph } = await import("../graph/builder");
          const { stateDir } = await import("../adapters/paths");
          await buildGraph(memoryDir, stateDir());
        } catch (err) {
          result.errors.push(
            `graph-rebuild-after-feedback: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  } catch (err) {
    result.errors.push(`auto-feedback: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3b. Work insights — enrich work completion learnings via LLM
  try {
    const { extractWorkLearnings } = await import("../capture/corrections");
    const { generateWorkInsights } = await import("../capture/work");
    const { readSignals } = await import("../adapters/jsonl");
    const { resolveMemoryDir } = await import("../adapters/paths");
    const { join } = await import("path");

    const toolAuditPath = join(config.signalDir, "tool-audit.jsonl");
    const toolSignals = await readSignals(toolAuditPath, { limit: 200 });

    const sessionTools = new Map<string, string[]>();
    for (const sig of toolSignals) {
      if ("session_id" in sig && "tool_name" in sig) {
        const tools = sessionTools.get(sig.session_id as string) || [];
        tools.push((sig as Record<string, unknown>).tool_name as string);
        sessionTools.set(sig.session_id as string, tools);
      }
    }

    const learnings = [];
    for (const [sessionId, tools] of sessionTools) {
      const learning = extractWorkLearnings({
        title: `Session ${sessionId}`,
        filesChanged: [],
        toolsUsed: tools,
        agentsSpawned: [],
        sessionId,
      });
      if (learning) learnings.push(learning);
    }

    if (learnings.length > 0) {
      const memoryDir = resolveMemoryDir();
      const workResult = await generateWorkInsights(learnings, memoryDir);
      result.workInsightsGenerated = workResult.filesWritten.length;
      result.errors.push(...workResult.errors);

      if (workResult.filesWritten.length > 0) {
        try {
          const { buildGraph } = await import("../graph/builder");
          const { stateDir } = await import("../adapters/paths");
          await buildGraph(memoryDir, stateDir());
        } catch (err) {
          result.errors.push(
            `graph-rebuild-after-work-insights: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  } catch (err) {
    result.errors.push(`work-insights: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. Promote — route detected patterns to rules if they cross threshold
  try {
    const { routeRule } = await import("../promote/router");
    const { checkBudget } = await import("../promote/budget");
    const { promoteRule } = await import("../promote/bridge");
    const { recordPromotion } = await import("../promote/ledger");
    const { trackRule, getEvictionCandidates } = await import("../promote/rules");
    const { stateDir } = await import("../adapters/paths");
    const { join } = await import("path");
    const { existsSync, readFileSync, readdirSync } = await import("fs");
    const { randomUUID } = await import("crypto");
    const { SCHEMA_VERSION, Tier } = await import("../adapters/types");
    const MAX_PROMOTIONS_PER_CYCLE = 3;

    let promoted = 0;
    for (const pattern of result.patterns) {
      if (!pattern.candidateRule || pattern.frequency < 3) continue;
      if (promoted >= MAX_PROMOTIONS_PER_CYCLE) break;

      const routeResult = routeRule(pattern, pattern.sessions);
      const budgetStatus = checkBudget(routeResult.tier, 0);

      if (budgetStatus.level === "OVER_BUDGET") {
        const rulesDir = join(config.signalDir, "..", "rules");
        if (existsSync(rulesDir)) {
          const ruleFiles = readdirSync(rulesDir).filter((f: string) => f.endsWith(".md"));
          const existingRules = ruleFiles.map((f: string) => ({
            id: f.replace(/\.md$/, ""),
            text: readFileSync(join(rulesDir, f), "utf-8"),
            tier: routeResult.tier,
            tags: [],
            created: "",
            correlationScore: 0,
            sourceSignals: [],
            schemaVersion: SCHEMA_VERSION,
          }));
          const evictionCandidates = getEvictionCandidates(existingRules);
          if (evictionCandidates.length > 0) {
            result.errors.push(
              `promote: over budget for ${routeResult.tier}, ${evictionCandidates.length} eviction candidate(s): ${evictionCandidates.map((r) => r.id).join(", ")}`,
            );
          }
        }
        continue;
      }

      if (config.rules.autoPromote) {
        const rule = {
          id: `agentgrit-${pattern.id}`,
          text: pattern.candidateRule,
          tier: routeResult.tier,
          tags: [pattern.type],
          created: new Date().toISOString(),
          correlationScore: 0,
          sourceSignals: pattern.sessions.slice(0, 5),
          schemaVersion: SCHEMA_VERSION,
        };

        const claudeMdPath = join(process.env.HOME ?? "", ".claude", "CLAUDE.md");
        if (routeResult.tier === Tier.Global && existsSync(claudeMdPath)) {
          await promoteRule(rule, claudeMdPath);
        }

        await recordPromotion(
          {
            id: randomUUID(),
            ruleId: rule.id,
            tier: routeResult.tier,
            timestamp: new Date().toISOString(),
            beforeSnapshot: "",
            afterSnapshot: "",
            approved: true,
          },
          stateDir(),
        );

        trackRule(rule, pattern.severity);
        promoted++;
      }
    }
    result.promoted = promoted;
  } catch (err) {
    result.errors.push(`promote: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 5. Sync — push scores to Langfuse if configured
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

  // 6. Optimize — run hill-climb if dimension below threshold
  try {
    const lowScores = result.scores.filter((s) => s.value <= 2);
    if (lowScores.length > 0) {
      const { inference } = await import("../adapters/inference");
      const testResult = await inference({
        systemPrompt: "Reply with OK",
        userPrompt: "ping",
        level: "fast",
        timeout: 5000,
      });

      if (testResult.success) {
        const { tunePrompt } = await import("../optimize/prompt-tuner");
        const { loadRubric } = await import("../evaluate/rubric");
        const { readSignals } = await import("../adapters/jsonl");
        const { resolveSignalFile } = await import("../adapters/paths");
        const { join } = await import("path");
        const { existsSync, readFileSync, readdirSync } = await import("fs");

        const dimCounts = new Map<string, number>();
        for (const s of lowScores) {
          dimCounts.set(s.dimension, (dimCounts.get(s.dimension) || 0) + 1);
        }
        let worstDim = "";
        let worstCount = 0;
        for (const [dim, count] of dimCounts) {
          if (count > worstCount) {
            worstDim = dim;
            worstCount = count;
          }
        }

        if (worstDim && config.rubrics.length > 0) {
          let rubric;
          try {
            rubric = loadRubric(config.rubrics[0]);
          } catch { /* skip */ }

          if (rubric) {
            const signalDir = config.signalDir;
            const scoresFile = resolveSignalFile(signalDir, "quality-scores.jsonl");
            const reflFile = resolveSignalFile(signalDir, "algorithm-reflections.jsonl");

            const fetcher = {
              async fetchLowestScoring(dimension: string, count: number) {
                const scores: Array<{ traceId: string; dimension: string; value: number }> = [];
                if (existsSync(scoresFile)) {
                  for (const line of readFileSync(scoresFile, "utf-8").split("\n")) {
                    if (!line.trim()) continue;
                    try { scores.push(JSON.parse(line)); } catch {}
                  }
                }
                const traces: Array<{ id: string; input: string; output: string; systemPrompt: string }> = [];
                if (existsSync(reflFile)) {
                  for (const line of readFileSync(reflFile, "utf-8").split("\n")) {
                    if (!line.trim()) continue;
                    try {
                      const e = JSON.parse(line);
                      traces.push({
                        id: e.session_id ?? `trace-${traces.length}`,
                        input: e.task_description ?? "",
                        output: e.reflection_q1 ?? "",
                        systemPrompt: e.system_prompt ?? "You are a helpful assistant.",
                      });
                    } catch {}
                  }
                }
                if (traces.length === 0) return [];
                const scoreMap = new Map<string, number>();
                for (const s of scores) {
                  if (s.dimension === dimension) scoreMap.set(s.traceId, s.value);
                }
                const withScores = traces.map((t) => ({
                  trace: { input: t.input, output: t.output, id: t.id },
                  score: scoreMap.get(t.id) ?? 2.5,
                  systemPrompt: t.systemPrompt,
                  userPrompt: t.input,
                }));
                withScores.sort((a, b) => a.score - b.score);
                return withScores.slice(0, count);
              },
            };

            const proposer = {
              async propose(currentPrompt: string, targetDimension: { name: string; rubric: string }, badOutputs: string[]) {
                const r = await inference({
                  systemPrompt: "You are a prompt engineer. Given a system prompt and examples of poor outputs, propose an improved version. Return ONLY the improved prompt text.",
                  userPrompt: `Current prompt:\n${currentPrompt}\n\nWeak dimension: ${targetDimension.name} — ${targetDimension.rubric}\n\nPoor outputs:\n${badOutputs.slice(0, 3).join("\n---\n")}\n\nImproved prompt:`,
                  level: "standard",
                });
                return r.success ? r.output.trim() : currentPrompt;
              },
            };

            const generator = {
              async generate(systemPrompt: string, userPrompt: string) {
                const r = await inference({ systemPrompt, userPrompt, level: "fast" });
                return r.success ? r.output : null;
              },
            };

            const optimizeStateDir = join(config.signalDir, "..", "state", "optimize");
            const judgeConfig = config.judge ? {
              provider: config.judge.provider,
              model: config.judge.model,
              apiKey: config.judge.apiKey,
            } : undefined;

            if (judgeConfig) {
              try {
                await tunePrompt({
                  dimension: worstDim,
                  rubric,
                  judgeConfig,
                  fetcher,
                  proposer,
                  generator,
                  testSize: 5,
                  rounds: 2,
                  stateDir: optimizeStateDir,
                });
                result.optimized = true;
              } catch (tuneErr) {
                result.errors.push(`optimize-tune: ${tuneErr instanceof Error ? tuneErr.message : String(tuneErr)}`);
                result.optimized = false;
              }
            } else {
              result.optimized = false;
            }
          } else {
            result.optimized = false;
          }
        } else {
          result.optimized = false;
        }
      } else {
        result.optimized = false;
      }
    }
  } catch (err) {
    result.errors.push(`optimize: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 7. Cleanup — session cleanup, signal rotation, compression, counts
  try {
    const { cleanupSession, rotateSignals, compressSession, updateCounts } = await import("./cleanup");
    const { stateDir } = await import("../adapters/paths");
    const { join } = await import("path");

    const state = stateDir();
    const baseDir = join(config.signalDir, "..");

    try {
      const cleanResult = await cleanupSession(config.signalDir, state);
      result.cleanup.staleFilesRemoved = cleanResult.staleFilesRemoved;
      result.cleanup.sessionStatesCleared = cleanResult.sessionStatesCleared;
      result.errors.push(...cleanResult.errors);
    } catch (err) {
      result.errors.push(`cleanup-session: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      result.cleanup.signalsRotated = await rotateSignals(config.signalDir);
    } catch (err) {
      result.errors.push(`cleanup-rotate: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const ratingsPath = join(config.signalDir, "ratings.jsonl");
      const digestsPath = join(state, "session-digests.json");
      const compressResult = await compressSession(ratingsPath, digestsPath);
      result.cleanup.sessionsCompressed = compressResult.sessionsCompressed;
    } catch (err) {
      result.errors.push(`cleanup-compress: ${err instanceof Error ? err.message : String(err)}`);
    }

    result.cleanup.counts = updateCounts(baseDir);
  } catch (err) {
    result.errors.push(`cleanup: ${err instanceof Error ? err.message : String(err)}`);
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
