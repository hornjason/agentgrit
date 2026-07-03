# Consolidation Plan — PAI Files → AgentGrit Modules

The migration spec (migration-spec.md) maps 145 PAI files as keep/merge. Of those, 85 are source code and 60 are runtime data files (benchmarks, experiment logs, state JSON, signal JSONL).

85 source files is too many. This plan consolidates them to ~35-40 by merging files that serve the same concern.

**Rule:** Don't 1:1 port. Read the original, understand what it does, write new consolidated code.

---

## capture/ (14 → 6 files)

| AgentGrit File | PAI Sources Consolidated | Why |
|----------------|-------------------------|-----|
| `rating.ts` | RatingCapture.hook.ts + SentimentScorer.hook.ts + LastResponseCache.hook.ts | Rating already captures sentiment; response cache is a rating dependency |
| `corrections.ts` | FailureCapture.ts + NegativeAssertionAudit.hook.ts + WorkCompletionLearning.hook.ts | All detect "something went wrong" signals — different triggers, same output schema |
| `skills.ts` | SkillInvocation.hook.ts + SkillSequenceLogger.hook.ts | Invocation + sequence are the same event at different granularity |
| `debrief.ts` | AutoDebrief.hook.ts | Standalone — session-end extraction is its own concern |
| `tool-audit.ts` | ToolAudit.hook.ts | Standalone — high-volume, needs its own rotation |
| `index.ts` | (new) + change-detection.ts + learning-utils.ts | Hook registration + shared capture utilities |

**Dropped from capture:** `incident-monitor.ts` and `harvester.ts` — fold incident detection into corrections.ts (same pattern), fold harvester into debrief.ts (both extract from transcripts).

---

## evaluate/ (11 → 5 files)

| AgentGrit File | PAI Sources Consolidated | Why |
|----------------|-------------------------|-----|
| `judge.ts` | LangfuseContentEvaluator.ts | Core LLM-as-judge — rename to generic (not Langfuse-specific) |
| `session.ts` | SessionQualityScorer.ts | Standalone — composite session score from signals |
| `recall.ts` | RecallEvaluator.ts | Standalone — did right rules/skills fire? |
| `gold.ts` | AutoGoldLabeler.ts + SyntheticGoldGenerator.ts | Both produce gold-standard datasets for evaluation |
| `analysis.ts` | LangfuseScoreAnalysis.ts + ImpactAnalyzer.ts + ToolAuditAnalyzer.ts | All aggregate scores and produce reports |

**Dropped from evaluate:** `skill-evaluator.ts` + `skill-evaluator-fast.ts` → move to optimize/ as part of skill-tuner.ts (they're evaluation FOR optimization, not standalone scoring).

---

## detect/ (9 → 4 files)

| AgentGrit File | PAI Sources Consolidated | Why |
|----------------|-------------------------|-----|
| `failures.ts` | FailurePatternDetector.ts + IncidentPatternAnalyzer.hook.ts | Both detect failure patterns — one from signals, one from incidents |
| `patterns.ts` | MinePatterns.ts + LearningPatternSynthesis.ts + PatternReportConverter.ts | All mine and format patterns — different inputs, same output |
| `trajectories.ts` | TrajectoryStore.ts | Standalone — episodic "what worked" memory |
| `theme-cohorts.ts` | ThemeCohorts.ts + AntiRationalizationGen.ts | Both analyze rule themes — cohorts for ablation, anti-rat for shortcuts |

---

## promote/ (7 → 5 files)

| AgentGrit File | PAI Sources Consolidated | Why |
|----------------|-------------------------|-----|
| `router.ts` | (new) | Three-tier routing logic — new code, no PAI equivalent |
| `rules.ts` | RuleTracker.ts + AutoFeedback.ts + AutoSuccess.ts | All track/generate rules from signals |
| `budget.ts` | RuleBudget.ts | Standalone — per-tier cap enforcement |
| `review.ts` | LearningReview.ts + EpisodicConsolidator.ts | Both run weekly synthesis — review promotes rules, consolidator compresses |
| `bridge.ts` | AutoMemoryBridge.ts + BuildCLAUDE.ts | Both write to CLAUDE.md — merge into one atomic writer with ledger |

**Added:** `ledger.ts` — promotion ledger with before/after snapshots + undo. New code, no PAI equivalent.

---

## optimize/ (8 source files → 5 files)

Note: optimize/ had 30 total in migration spec, but 22 were benchmark/experiment DATA files. Only 8 are source code.

| AgentGrit File | PAI Sources Consolidated | Why |
|----------------|-------------------------|-----|
| `hill-climb.ts` | SkillOptimizer.ts (engine extracted) | Generic hill-climb loop — shared by prompt and skill tuners |
| `prompt-tuner.ts` | LangfusePromptTuner.ts | Prompt-specific optimization — uses hill-climb engine |
| `skill-tuner.ts` | SkillOptimizer.ts (skill logic) + SkillEvaluator.ts + SkillEvaluatorFast.ts | Skill-specific optimization — evaluation is part of tuning |
| `skill-metrics.ts` | SkillAccuracy.ts + SkillConversionMetric.ts + SkillCooccurrence.ts + SkillUsageAnalyzer.ts | All measure skill effectiveness — consolidate into one metrics module |
| `benchmark.ts` | SkillBenchmark.ts | Standalone — builds frozen benchmark corpus |

---

## graph/ (15 → 7 files)

| AgentGrit File | PAI Sources Consolidated | Why |
|----------------|-------------------------|-----|
| `types.ts` | KnowledgeGraph.ts | Shared graph types (GraphNode, GraphEdge) |
| `builder.ts` | GraphBuilder.ts + GraphUpdater.ts + GraphMaintenance.ts | Build = create + update + maintain — one lifecycle |
| `query.ts` | GraphQuery.ts + GraphReport.ts | Query + human-readable report are the same operation at different verbosity |
| `retrieval.ts` | HybridRetrieval.ts | Standalone — BM25 + graph + RRF fusion |
| `bm25.ts` | BM25Index.ts | Standalone — full-text index |
| `embedder.ts` | GraphEmbedder.ts + ContextualEmbedder.ts + MemoryConsolidator.ts + MemoryTagger.ts | All process memory files for graph ingestion |
| `context.ts` | GraphContext.hook.ts + learning-readback.ts + VoyageReranker.ts | Session-start context injection + reranking |

---

## adapters/ (14 → 7 files)

| AgentGrit File | PAI Sources Consolidated | Why |
|----------------|-------------------------|-----|
| `types.ts` | (new — shared interfaces) | Foundation types imported by all modules |
| `jsonl.ts` | hook-io.ts (JSONL parts) | Atomic JSONL read/write/append/rotate |
| `langfuse.ts` | langfuse-instrumentation.ts + LangfuseScoreSync.ts + LangfuseTraceCache.ts | One Langfuse adapter — connect, sync, cache |
| `claude-code.ts` | BuildCLAUDE.ts (handler) + identity.ts + LoadContext.hook.ts + CompactRecovery.hook.sh | Claude Code integration — hooks, CLAUDE.md, project detection |
| `paths.ts` | paths.ts | Standalone — path resolution |
| `time.ts` | time.ts | Standalone — time utilities |
| `inference.ts` | Inference.ts | Standalone — unified LLM inference |

**Dropped from adapters:** `skill-config.ts` (fold into optimize/), `transcript-parser.ts` (fold into capture/debrief.ts).

---

## daemon/ (7 → 4 files)

| AgentGrit File | PAI Sources Consolidated | Why |
|----------------|-------------------------|-----|
| `daemon.ts` | (new) | Main daemon loop — orchestrates score→detect→promote→sync→optimize |
| `doctor.ts` | IntegrityMaintenance.ts + SystemIntegrity.ts + IntegrityCheck.hook.ts | All check system health — consolidate into one diagnostic |
| `scheduler.ts` | (new) | LaunchAgent/systemd installer — new code |
| `cleanup.ts` | SessionCleanup.hook.ts + SessionCompressor.ts + UpdateCounts.hook.ts + notifications.ts | All run at session boundaries — consolidate lifecycle ops |

---

## bin/ (1 file)

| AgentGrit File | PAI Sources Consolidated | Why |
|----------------|-------------------------|-----|
| `agentgrit.ts` | pai.ts (structure only) | CLI dispatcher — new code with PAI's subcommand pattern |

---

## Summary

| Module | Migration spec (raw) | After consolidation | Reduction |
|--------|---------------------|-------------------|-----------|
| capture/ | 14 | 6 | -57% |
| evaluate/ | 11 | 5 | -55% |
| detect/ | 9 | 4 | -56% |
| promote/ | 7 | 5+1 | -14% |
| optimize/ | 8 | 5 | -38% |
| graph/ | 15 | 7 | -53% |
| adapters/ | 14 | 7 | -50% |
| daemon/ | 7 | 4 | -43% |
| bin/ | 1 | 1 | 0% |
| **Total** | **86** | **~45** | **-48%** |

Plus ~60 runtime data files (signals, state, benchmarks) that aren't source code — they get created by the modules at runtime.

---

## How to use this plan

When building each module:
1. Read this consolidation plan for the target module
2. Read the original PAI files listed in the "PAI Sources Consolidated" column
3. Write NEW code that combines the functionality — don't copy-paste
4. Use the AgentGrit naming convention (kebab-case files, see NAMING.md)
5. Each file should have a clear single responsibility after consolidation
