# PAI → AgentGrit Migration Spec

Maps every file from PAI's learning loop infrastructure to its AgentGrit destination.

**Source directories:**
- `~/.claude/PAI/Tools/*.ts` — 98 tool files + 4 in subdirectories
- `~/.claude/hooks/` — 39 hook files + 6 handlers + 13 lib utilities
- `~/.claude/MEMORY/LEARNING/SIGNALS/` — 16 signal files
- `~/.claude/MEMORY/LEARNING/STATE/` — 45 state files

**Total: 221 files** (197 in scope per brief + 24 additional handler/lib/subdir files discovered during scan)

## Disposition Key

| Code | Meaning |
|------|---------|
| **keep** | Direct port to AgentGrit module with new kebab-case name |
| **merge** | Combine with another file into a single AgentGrit module |
| **drop** | PAI-specific, not part of the learning loop — do not migrate |
| **defer** | Useful but out of scope for v1 — revisit after core ships |

## AgentGrit Module Key

| Module | PRD Section | Purpose |
|--------|-------------|---------|
| `capture/` | Signal Capture | Hooks that write signals to JSONL |
| `evaluate/` | Scoring/Judging | LLM judge, session scoring, recall eval |
| `detect/` | Pattern Detection | Failure pattern mining, trajectory store |
| `promote/` | Rule Management | Rule routing, budget, review, memory bridge |
| `optimize/` | Hill-Climbing | Prompt tuner, skill optimizer, benchmarks |
| `graph/` | Knowledge Graph | Builder, query, retrieval, embeddings |
| `adapters/` | Data Adapters | Langfuse, JSONL, Claude Code integration |
| `daemon/` | Automation | Daemon loop, health check, scheduler |
| `bin/` | CLI | Entry point, subcommand dispatch |

---

## Section 1: PAI/Tools/*.ts (98 files)

| # | PAI Source File | Description | Module | Disposition | AgentGrit Name |
|---|----------------|-------------|--------|-------------|----------------|
| 1 | `ActivityParser.ts` | Parse session activity for repo update docs | — | drop | — |
| 2 | `AddBg.ts` | Add background color to PNG images | — | drop | — |
| 3 | `AIResearchFetcher.ts` | Daily AI research brief fetcher | — | drop | — |
| 4 | `algorithm.ts` | Algorithm CLI for PRD-driven sessions | — | drop | — |
| 5 | `AlgorithmPhaseReport.ts` | Write algorithm state to phase JSON | — | drop | — |
| 6 | `AntiRationalizationGen.ts` | Auto-generate anti-rationalization table from failure data | `detect/` | keep | `anti-rationalization.ts` |
| 7 | `AppendTestHistory.ts` | Append test results to history file | — | drop | — |
| 8 | `AutoFeedback.ts` | Auto-generate feedback memories from low-rating learnings | `promote/` | keep | `auto-feedback.ts` |
| 9 | `AutoGoldLabeler.ts` | Retroactively label sessions against graph rules for gold set | `evaluate/` | keep | `auto-gold-labeler.ts` |
| 10 | `AutoMemoryBridge.ts` | Promote Claude Code auto-memory to curated memory | `promote/` | keep | `bridge.ts` |
| 11 | `AutoSuccess.ts` | Auto-generate success memories from high-rating sessions | `promote/` | keep | `auto-success.ts` |
| 12 | `BackfillFailureFields.ts` | One-time backfill for failure entry fields | — | drop | — |
| 13 | `BackfillRuleIds.ts` | One-time backfill to add rule_ids to historical ratings | — | drop | — |
| 14 | `Banner.ts` | Dynamic multi-design neofetch banner | — | drop | — |
| 15 | `BannerMatrix.ts` | Matrix digital rain banner | — | drop | — |
| 16 | `BannerNeofetch.ts` | Modern neofetch-style banner | — | drop | — |
| 17 | `BannerPrototypes.ts` | Banner prototype designs | — | drop | — |
| 18 | `BannerRetro.ts` | Retro BBS/DOS terminal banner | — | drop | — |
| 19 | `BannerTokyo.ts` | Tokyo Night theme banner | — | drop | — |
| 20 | `BM25Index.ts` | BM25 full-text index over memory files | `graph/` | keep | `bm25.ts` |
| 21 | `BuildCLAUDE.ts` | Generate CLAUDE.md from template + settings | `adapters/` | keep | `claude-code.ts` |
| 22 | `ContextualEmbedder.ts` | Contextual retrieval embeddings for memory files | `graph/` | keep | `contextual-embedder.ts` |
| 23 | `EmailOptimizer.ts` | Self-optimization loop for sales email templates | — | drop | — |
| 24 | `EpisodicConsolidator.ts` | LLM-based episodic-to-semantic memory consolidation | `promote/` | keep | `consolidator.ts` |
| 25 | `ExtractTranscript.ts` | CLI for extracting transcripts from audio/video | — | drop | — |
| 26 | `FailureCapture.ts` | Full context failure analysis for low-sentiment events | `capture/` | keep | `failure.ts` |
| 27 | `FailurePatternDetector.ts` | Nightly failure pattern analysis and skill-text patching | `detect/` | keep | `failures.ts` |
| 28 | `FeatureRegistry.ts` | JSON-based feature tracking CLI | — | drop | — |
| 29 | `GetCounts.ts` | Single source of truth for system metric counts | — | drop | — |
| 30 | `GetTranscript.ts` | Extract transcript from YouTube video | — | drop | — |
| 31 | `GraphBuilder.ts` | Build behavioral knowledge graph (incremental) | `graph/` | keep | `builder.ts` |
| 32 | `GraphEmbedder.ts` | Embedding-based edge generation via Voyage AI | `graph/` | keep | `embedder.ts` |
| 33 | `GraphMaintenance.ts` | Knowledge graph auto-maintenance and repair | `graph/` | keep | `maintenance.ts` |
| 34 | `GraphQuery.ts` | Query graph for contextually relevant rule clusters | `graph/` | keep | `query.ts` |
| 35 | `GraphReport.ts` | Human-readable graph effectiveness report | `graph/` | keep | `report.ts` |
| 36 | `GraphUpdater.ts` | Incrementally update graph with new nodes/edges | `graph/` | keep | `updater.ts` |
| 37 | `GraphVisualizer.ts` | D3-based interactive graph visualization | `graph/` | defer | `visualizer.ts` |
| 38 | `HybridRetrieval.ts` | BM25 + GraphQuery + RRF + optional reranking | `graph/` | keep | `retrieval.ts` |
| 39 | `ImpactAnalyzer.ts` | Measure actual impact of self-improvement system | `evaluate/` | keep | `impact.ts` |
| 40 | `Inference.ts` | Unified LLM inference with three run levels | `adapters/` | keep | `inference.ts` |
| 41 | `IntegrityMaintenance.ts` | Background system integrity and update docs | `daemon/` | keep | `integrity.ts` |
| 42 | `IntelFetcher.ts` | Intelligence data fetcher | — | drop | — |
| 43 | `KnowledgeGraph.ts` | Shared types and utilities for graph memory layer | `graph/` | keep | `types.ts` |
| 44 | `langfuse-instrumentation.ts` | OpenTelemetry + Langfuse span processor setup | `adapters/` | merge | `langfuse.ts` |
| 45 | `LangfuseContentEvaluator.ts` | Evaluate trace content quality via LLM judge | `evaluate/` | keep | `content.ts` |
| 46 | `LangfusePromptTuner.ts` | Hill-climbing prompt optimizer using Langfuse traces | `optimize/` | keep | `prompt-tuner.ts` |
| 47 | `LangfuseScoreAnalysis.ts` | Aggregate and analyze Langfuse scores | `evaluate/` | keep | `score-analysis.ts` |
| 48 | `LangfuseScoreSync.ts` | Batch-sync evaluator scores to Langfuse | `adapters/` | keep | `langfuse-sync.ts` |
| 49 | `LangfuseTraceCache.ts` | Download Langfuse traces to local JSON cache | `adapters/` | keep | `langfuse-cache.ts` |
| 50 | `LearningPatternSynthesis.ts` | Aggregate ratings into actionable patterns | `detect/` | keep | `synthesis.ts` |
| 51 | `LearningReview.ts` | Weekly self-learning review and rule promotion | `promote/` | keep | `review.ts` |
| 52 | `LoadSkillConfig.ts` | Shared utility for loading skill configurations | `adapters/` | keep | `skill-config.ts` |
| 53 | `MemoryConsolidator.ts` | Near-duplicate detection for memory entries | `graph/` | keep | `consolidator.ts` |
| 54 | `MemoryDashboard.ts` | Parse named rules from CLAUDE.md, display dashboard | `daemon/` | defer | `dashboard.ts` |
| 55 | `MemoryTagger.ts` | Classify memory files and add type frontmatter | `graph/` | keep | `memory-tagger.ts` |
| 56 | `MinePatterns.ts` | AI-powered learning signal pattern miner | `detect/` | keep | `patterns.ts` |
| 57 | `NeofetchBanner.ts` | Neofetch-style system banner | — | drop | — |
| 58 | `OpinionTracker.ts` | Track and evolve confidence-based opinions | — | drop | — |
| 59 | `pai.ts` | Personal AI CLI tool | `bin/` | keep | `agentgrit.ts` |
| 60 | `PAILogo.ts` | Figlet-style ASCII art logo | — | drop | — |
| 61 | `PatternReportConverter.ts` | Convert gap patterns from reports to memory files | `detect/` | keep | `pattern-converter.ts` |
| 62 | `PipelineMonitor.ts` | Real-time WebSocket pipeline monitor server | `daemon/` | defer | `monitor.ts` |
| 63 | `PipelineOrchestrator.ts` | Run pipelines with progress monitoring | `daemon/` | defer | `orchestrator.ts` |
| 64 | `PreviewMarkdown.ts` | Preview markdown in browser | — | drop | — |
| 65 | `RebuildPAI.ts` | Assemble SKILL.md from components | — | drop | — |
| 66 | `RecallEvaluator.ts` | Measure recall accuracy of behavioral rule graph | `evaluate/` | keep | `recall.ts` |
| 67 | `RelationshipReflect.ts` | Periodic reflection on relationship growth | — | drop | — |
| 68 | `RemoveBg.ts` | Background removal CLI via remove.bg API | — | drop | — |
| 69 | `RuleBudget.ts` | Monitor critical rules section size in CLAUDE.md | `promote/` | keep | `budget.ts` |
| 70 | `RuleTracker.ts` | Track rule injection and correlate with ratings | `promote/` | keep | `rules.ts` |
| 71 | `SecretScan.ts` | Secret scanning CLI via TruffleHog | — | drop | — |
| 72 | `SessionCompressor.ts` | Graduated memory compression for session history | `daemon/` | keep | `compressor.ts` |
| 73 | `SessionHarvester.ts` | Extract learnings from session transcripts | `capture/` | keep | `harvester.ts` |
| 74 | `SessionProgress.ts` | Manage session continuity files | — | drop | — |
| 75 | `SessionQualityScorer.ts` | LLM-as-judge automated session quality signal | `evaluate/` | keep | `session.ts` |
| 76 | `SkillAccuracy.ts` | Measure skill selection accuracy | `optimize/` | keep | `skill-accuracy.ts` |
| 77 | `SkillBenchmark.ts` | Build frozen benchmark corpus from high-rated reflections | `optimize/` | keep | `skill-benchmark.ts` |
| 78 | `SkillConversionMetric.ts` | Suggestion-to-invocation conversion rate | `optimize/` | keep | `skill-conversion.ts` |
| 79 | `SkillCooccurrence.ts` | Build skill co-occurrence matrix | `optimize/` | keep | `skill-cooccurrence.ts` |
| 80 | `SkillEvaluator.ts` | Behavioral scoring for skill files against benchmark | `evaluate/` | keep | `skill-evaluator.ts` |
| 81 | `SkillEvaluatorFast.ts` | Deterministic regex scoring, zero LLM judge variance | `evaluate/` | keep | `skill-evaluator-fast.ts` |
| 82 | `SkillForge.ts` | Auto-propose skill scaffolds from recurring themes | `optimize/` | defer | `skill-forge.ts` |
| 83 | `SkillOptimizer.ts` | Hill-climbing skill optimizer with behavioral evaluator | `optimize/` | keep | `hill-climb.ts` |
| 84 | `SkillSynthesizer.ts` | Synthesize SKILL.md content from algorithm reflections | `optimize/` | defer | `skill-synthesizer.ts` |
| 85 | `SkillUsageAnalyzer.ts` | Correlate skill invocations with session ratings | `optimize/` | keep | `skill-usage.ts` |
| 86 | `SplitAndTranscribe.ts` | Split large audio files and transcribe | — | drop | — |
| 87 | `SyntheticGoldGenerator.ts` | Generate synthetic gold sessions for recall evaluator | `evaluate/` | keep | `synthetic-gold.ts` |
| 88 | `test-inference-bare.ts` | Regression test: inference bare flag | `evaluate/` | keep | `__tests__/inference-bare.test.ts` |
| 89 | `test-proposal-timeout.ts` | Regression test: proposal generation timeout | `optimize/` | keep | `__tests__/proposal-timeout.test.ts` |
| 90 | `ThemeCohorts.ts` | Define and analyze rule theme cohorts for ablation | `detect/` | keep | `theme-cohorts.ts` |
| 91 | `ToolAuditAnalyzer.ts` | Weekly tool-use audit report from JSONL | `evaluate/` | keep | `tool-audit-analyzer.ts` |
| 92 | `TrajectoryStore.ts` | Episodic memory of what worked in high-rated sessions | `detect/` | keep | `trajectories.ts` |
| 93 | `TranscriptParser.ts` | Claude transcript parsing utilities | `adapters/` | keep | `transcript-parser.ts` |
| 94 | `VoyageReranker.ts` | Reranking for retrieval pipeline (Voyage AI / Gemini) | `graph/` | keep | `reranker.ts` |
| 95 | `WisdomCrossFrameSynthesizer.ts` | Extract shared principles across wisdom frames | — | drop | — |
| 96 | `WisdomDomainClassifier.ts` | Route requests to relevant wisdom frames | — | drop | — |
| 97 | `WisdomFrameUpdater.ts` | Update wisdom frames with new observations | — | drop | — |
| 98 | `YouTubeApi.ts` | YouTube Data API v3 client | — | drop | — |

### PAI/Tools subdirectory files (4 files)

| # | PAI Source File | Description | Module | Disposition | AgentGrit Name |
|---|----------------|-------------|--------|-------------|----------------|
| 99 | `__tests__/AntiRationalizationGen.test.ts` | Unit test for anti-rationalization generator | `detect/` | keep | `__tests__/anti-rationalization.test.ts` |
| 100 | `pipeline-monitor-ui/src/lib/utils.ts` | Pipeline monitor UI utilities | `daemon/` | defer | — |
| 101 | `pipeline-monitor-ui/src/vite-env.d.ts` | Vite environment type declarations | `daemon/` | defer | — |
| 102 | `pipeline-monitor-ui/vite.config.ts` | Vite configuration for pipeline monitor UI | `daemon/` | defer | — |

---

## Section 2: hooks/*.hook.ts and *.hook.sh (39 files)

| # | PAI Source File | Description | Module | Disposition | AgentGrit Name |
|---|----------------|-------------|--------|-------------|----------------|
| 103 | `ActionVerificationGate.hook.ts` | Post-deploy verification reminder | — | drop | — |
| 104 | `AgentBriefGuard.hook.ts` | Validate agent spawn briefs | — | drop | — |
| 105 | `AgentExecutionGuard.hook.ts` | Enforce background agent execution | — | drop | — |
| 106 | `AutoDebrief.hook.ts` | Auto-capture correction/approval signals from transcripts | `capture/` | keep | `debrief.ts` |
| 107 | `CompactRecovery.hook.sh` | Re-inject ship workflow state after compaction | `adapters/` | keep | `compact-recovery.sh` |
| 108 | `DocHygiene.hook.ts` | Validate and auto-stamp doc headers on .md writes | — | drop | — |
| 109 | `DocIntegrity.hook.ts` | Check cross-refs if system docs modified | — | drop | — |
| 110 | `GateEnforcement.hook.ts` | PreToolUse gate for harness gate failures | — | drop | — |
| 111 | `GraphContext.hook.ts` | Inject relevant graph context at session start | `graph/` | keep | `context-hook.ts` |
| 112 | `HarnessAFKGate.hook.ts` | Block AskUserQuestion during AFK harness runs | — | drop | — |
| 113 | `HarnessFailureSurfacing.hook.ts` | Inject step-specific failure patterns on skill invoke | — | drop | — |
| 114 | `IncidentMonitor.hook.ts` | Real-time tool failure detection to incidents JSONL | `capture/` | keep | `incident-monitor.ts` |
| 115 | `IncidentPatternAnalyzer.hook.ts` | Session-end incident pattern analysis and rule proposals | `detect/` | keep | `incident-analyzer.ts` |
| 116 | `IntegrityCheck.hook.ts` | Session-end system integrity check | `daemon/` | keep | `integrity-check.ts` |
| 117 | `IssueCloseGuard.hook.ts` | Block gh issue close without gates | — | drop | — |
| 118 | `KittyEnvPersist.hook.ts` | Kitty terminal env persistence + tab reset | — | drop | — |
| 119 | `LastResponseCache.hook.ts` | Cache last response for rating capture bridge | `capture/` | keep | `response-cache.ts` |
| 120 | `LoadContext.hook.ts` | Inject dynamic context at session start | `adapters/` | keep | `load-context.ts` |
| 121 | `NegativeAssertionAudit.hook.ts` | Detect unverified negative assertions | `capture/` | keep | `assertion-audit.ts` |
| 122 | `PRDSync.hook.ts` | PRD-to-work.json sync on write/edit | — | drop | — |
| 123 | `QuestionAnswered.hook.ts` | Reset tab after question answered | — | drop | — |
| 124 | `RatingCapture.hook.ts` | Unified rating and sentiment capture | `capture/` | keep | `rating.ts` |
| 125 | `RelationshipMemory.hook.ts` | Extract relationship notes from sessions | — | drop | — |
| 126 | `ResponseTabReset.hook.ts` | Reset Kitty tab title/color after response | — | drop | — |
| 127 | `SecurityValidator.hook.ts` | Security validation for tool calls | — | drop | — |
| 128 | `SentimentScorer.hook.ts` | Auto-score sessions from transcript analysis | `capture/` | keep | `sentiment.ts` |
| 129 | `SessionAutoName.hook.ts` | Auto-generate concise session names | — | drop | — |
| 130 | `SessionCleanup.hook.ts` | Mark work complete and clear state | `daemon/` | keep | `session-cleanup.ts` |
| 131 | `SetQuestionTab.hook.ts` | Tab color change for user input | — | drop | — |
| 132 | `SkillEnforcement.hook.ts` | PreToolUse gate for required skill suggestions | — | drop | — |
| 133 | `SkillGuard.hook.ts` | Block false-positive skill invocations | — | drop | — |
| 134 | `SkillInvocation.hook.ts` | Track skill invocations to JSONL | `capture/` | keep | `skill-invocation.ts` |
| 135 | `SkillRouter.hook.ts` | Suggest skills via keyword routing | — | drop | — |
| 136 | `SkillSequenceLogger.hook.ts` | Log skill invocation sequences per session | `capture/` | keep | `skill-sequence.ts` |
| 137 | `ToolAudit.hook.ts` | Tool-use audit log (every tool call to JSONL) | `capture/` | keep | `tool-audit.ts` |
| 138 | `UpdateCounts.hook.ts` | Session-end system counts update | `daemon/` | merge | `update-counts.ts` |
| 139 | `UpdateTabTitle.hook.ts` | Tab title on prompt receipt | — | drop | — |
| 140 | `VoiceCompletion.hook.ts` | Send completion voice line to TTS server | — | drop | — |
| 141 | `WorkCompletionLearning.hook.ts` | Extract learnings from completed work | `capture/` | keep | `work-completion.ts` |

---

## Section 3: hooks/handlers/*.ts (6 files)

| # | PAI Source File | Description | Module | Disposition | AgentGrit Name |
|---|----------------|-------------|--------|-------------|----------------|
| 142 | `handlers/BuildCLAUDE.ts` | SessionStart hook: rebuild CLAUDE.md if needed | `adapters/` | merge | `claude-code.ts` |
| 143 | `handlers/DocCrossRefIntegrity.ts` | Hybrid doc integrity checker (deterministic + inference) | — | drop | — |
| 144 | `handlers/SystemIntegrity.ts` | Detect system changes, spawn integrity maintenance | `daemon/` | merge | `integrity.ts` |
| 145 | `handlers/TabState.ts` | Terminal tab state manager | — | drop | — |
| 146 | `handlers/UpdateCounts.ts` | Update settings.json with fresh system counts | `daemon/` | merge | `update-counts.ts` |
| 147 | `handlers/VoiceNotification.ts` | Voice notification handler for TTS playback | — | drop | — |

---

## Section 4: hooks/lib/*.ts (13 files)

| # | PAI Source File | Description | Module | Disposition | AgentGrit Name |
|---|----------------|-------------|--------|-------------|----------------|
| 148 | `lib/change-detection.ts` | Utilities for detecting system file changes | `capture/` | keep | `change-detection.ts` |
| 149 | `lib/hook-io.ts` | Shared stdin reader for hooks | `adapters/` | keep | `hook-io.ts` |
| 150 | `lib/identity.ts` | Central identity loader for DA and principal | `adapters/` | keep | `identity.ts` |
| 151 | `lib/learning-readback.ts` | Read learnings back into session context | `graph/` | keep | `learning-readback.ts` |
| 152 | `lib/learning-utils.ts` | Shared learning categorization logic | `capture/` | keep | `learning-utils.ts` |
| 153 | `lib/notifications.ts` | Session timing + ntfy push notifications | `daemon/` | keep | `notifications.ts` |
| 154 | `lib/output-validators.ts` | Validation for voice and tab title outputs | — | drop | — |
| 155 | `lib/paths.ts` | Centralized path resolution with env expansion | `adapters/` | keep | `paths.ts` |
| 156 | `lib/prd-template.ts` | PRD template generator | — | drop | — |
| 157 | `lib/prd-utils.ts` | Shared PRD functions for hooks | — | drop | — |
| 158 | `lib/tab-constants.ts` | Tab title colors and state constants | — | drop | — |
| 159 | `lib/tab-setter.ts` | Unified tab state setter for Kitty terminal | — | drop | — |
| 160 | `lib/time.ts` | Shared time utilities with timezone support | `adapters/` | keep | `time.ts` |

---

## Section 5: MEMORY/LEARNING/SIGNALS/ (16 files)

These are data files created and consumed by AgentGrit modules. They define the signal schema.

| # | PAI Source File | Description | Module | Disposition | AgentGrit Name |
|---|----------------|-------------|--------|-------------|----------------|
| 161 | `ratings.jsonl` | User ratings (1-10) with sentiment summary | `capture/` | keep | `signals/ratings.jsonl` |
| 162 | `correction-captures.jsonl` | Correction language detections | `capture/` | keep | `signals/corrections.jsonl` |
| 163 | `sessions.jsonl` | Session metadata and summary | `capture/` | keep | `signals/sessions.jsonl` |
| 164 | `quality-scores.jsonl` | LLM judge quality scores | `evaluate/` | keep | `signals/quality-scores.jsonl` |
| 165 | `skill-invocations.jsonl` | Skill invocation records | `capture/` | keep | `signals/skill-invocations.jsonl` |
| 166 | `skill-sequences.jsonl` | Skill invocation sequences per session | `capture/` | keep | `signals/skill-sequences.jsonl` |
| 167 | `skill-router-suggestions.jsonl` | Skill router suggestion events | `capture/` | keep | `signals/skill-suggestions.jsonl` |
| 168 | `skillrouter-events.jsonl` | Skill router event log (legacy) | `capture/` | merge | `signals/skill-suggestions.jsonl` |
| 169 | `tool-audit.jsonl` | Tool call audit log | `capture/` | keep | `signals/tool-audit.jsonl` |
| 170 | `assertion-violations.jsonl` | Unverified negative assertion violations | `capture/` | keep | `signals/assertion-violations.jsonl` |
| 171 | `marcus-learnings.jsonl` | Agent-specific learning captures | `capture/` | keep | `signals/agent-learnings.jsonl` |
| 172 | `failure-patterns.json` | Detected failure pattern clusters | `detect/` | keep | `signals/failure-patterns.json` |
| 173 | `learning-review.log` | Learning review execution log | `promote/` | keep | `signals/learning-review.log` |
| 174 | `loop-summary.log` | Daemon loop summary log | `daemon/` | keep | `signals/loop-summary.log` |
| 175 | `skill-optimizer.log` | Skill optimizer execution log | `optimize/` | keep | `signals/skill-optimizer.log` |
| 176 | `SCHEMA.md` | Signal file schema documentation | `adapters/` | keep | `signals/SCHEMA.md` |

---

## Section 6: MEMORY/LEARNING/STATE/ (45 files)

These are state files that persist between daemon cycles. They define the state schema.

| # | PAI Source File | Description | Module | Disposition | AgentGrit Name |
|---|----------------|-------------|--------|-------------|----------------|
| 177 | `knowledge-graph.json` | Behavioral knowledge graph (nodes + edges) | `graph/` | keep | `state/knowledge-graph.json` |
| 178 | `bm25-index.json` | BM25 full-text search index | `graph/` | keep | `state/bm25-index.json` |
| 179 | `embeddings-cache.json` | Cached Voyage AI embeddings | `graph/` | keep | `state/embeddings-cache.json` |
| 180 | `domain_overrides.json` | Manual domain tag overrides | `graph/` | keep | `state/domain-overrides.json` |
| 181 | `edge_overrides.json` | Manual edge overrides | `graph/` | keep | `state/edge-overrides.json` |
| 182 | `graph-gold.json` | Gold-labeled sessions for recall evaluation | `evaluate/` | keep | `state/graph-gold.json` |
| 183 | `graph-node-stats.json` | Per-node usage statistics | `graph/` | keep | `state/graph-node-stats.json` |
| 184 | `patterns.json` | Mined failure pattern state | `detect/` | keep | `state/patterns.json` |
| 185 | `recall-scores.json` | Recall evaluation scores | `evaluate/` | keep | `state/recall-scores.json` |
| 186 | `rule-stats.json` | Rule correlation statistics | `promote/` | keep | `state/rule-stats.json` |
| 187 | `trajectories.json` | High-rated session trajectories | `detect/` | keep | `state/trajectories.json` |
| 188 | `processed-learnings.json` | Tracking for processed learning files | `promote/` | keep | `state/processed-learnings.json` |
| 189 | `processed-reports.json` | Tracking for processed report files | `promote/` | keep | `state/processed-reports.json` |
| 190 | `processed-successes.json` | Tracking for processed success files | `promote/` | keep | `state/processed-successes.json` |
| 191 | `session-digests.json` | Compressed session digest archive | `daemon/` | keep | `state/session-digests.json` |
| 192 | `reflections.jsonl` | General reflections log | `detect/` | keep | `state/reflections.jsonl` |
| 193 | `algorithm-reflections.jsonl` | Algorithm session reflections | `detect/` | keep | `state/algorithm-reflections.jsonl` |
| 194 | `synthetic-gold.json` | Generated synthetic gold sessions | `evaluate/` | keep | `state/synthetic-gold.json` |
| 195 | `theme-cohorts.json` | Theme cohort definitions and analysis | `detect/` | keep | `state/theme-cohorts.json` |
| 196 | `ai-research-brief.json` | AI research brief data | — | drop | — |
| 197 | `skill-benchmark.json` | Frozen skill benchmark corpus | `optimize/` | keep | `state/skill-benchmark.json` |
| 198 | `skill-benchmark-devloop.json` | Benchmark: dev-loop skill | `optimize/` | keep | `state/skill-benchmark-devloop.json` |
| 199 | `skill-benchmark-docs.json` | Benchmark: docs skill | `optimize/` | keep | `state/skill-benchmark-docs.json` |
| 200 | `skill-benchmark-documentation-and-guides.json` | Benchmark: documentation-and-guides skill | `optimize/` | keep | `state/skill-benchmark-documentation-and-guides.json` |
| 201 | `skill-benchmark-infrastructure-and-devops.json` | Benchmark: infrastructure-and-devops skill | `optimize/` | keep | `state/skill-benchmark-infrastructure-and-devops.json` |
| 202 | `skill-benchmark-pai-memory-and-learning.json` | Benchmark: pai-memory-and-learning skill | `optimize/` | keep | `state/skill-benchmark-pai-memory-and-learning.json` |
| 203 | `skill-benchmark-product-feature-development.json` | Benchmark: product-feature-development skill | `optimize/` | keep | `state/skill-benchmark-product-feature-development.json` |
| 204 | `skill-benchmark-qa.json` | Benchmark: qa skill | `optimize/` | keep | `state/skill-benchmark-qa.json` |
| 205 | `skill-benchmark-research-and-api-investigation.json` | Benchmark: research-and-api-investigation skill | `optimize/` | keep | `state/skill-benchmark-research-and-api-investigation.json` |
| 206 | `skill-benchmark-ship.json` | Benchmark: ship skill | `optimize/` | keep | `state/skill-benchmark-ship.json` |
| 207 | `skill-optimizer-experiments.jsonl` | Optimizer experiment log (general) | `optimize/` | keep | `state/experiments.jsonl` |
| 208 | `skill-optimizer-experiments-debugging-and-bug-fixes.jsonl` | Optimizer experiments: debugging skill | `optimize/` | keep | `state/experiments-debugging-and-bug-fixes.jsonl` |
| 209 | `skill-optimizer-experiments-dev-loop.jsonl` | Optimizer experiments: dev-loop skill | `optimize/` | keep | `state/experiments-dev-loop.jsonl` |
| 210 | `skill-optimizer-experiments-documentation-and-guides.jsonl` | Optimizer experiments: documentation skill | `optimize/` | keep | `state/experiments-documentation-and-guides.jsonl` |
| 211 | `skill-optimizer-experiments-infrastructure-and-devops.jsonl` | Optimizer experiments: infra skill | `optimize/` | keep | `state/experiments-infrastructure-and-devops.jsonl` |
| 212 | `skill-optimizer-experiments-pai-memory-and-learning.jsonl` | Optimizer experiments: memory skill | `optimize/` | keep | `state/experiments-pai-memory-and-learning.jsonl` |
| 213 | `skill-optimizer-experiments-product-feature-development.jsonl` | Optimizer experiments: product skill | `optimize/` | keep | `state/experiments-product-feature-development.jsonl` |
| 214 | `skill-optimizer-experiments-research-and-api-investigation.jsonl` | Optimizer experiments: research skill | `optimize/` | keep | `state/experiments-research-and-api-investigation.jsonl` |
| 215 | `skill-optimizer-experiments-Research.jsonl` | Optimizer experiments: Research skill | `optimize/` | keep | `state/experiments-research.jsonl` |
| 216 | `skill-optimizer-experiments-Security.jsonl` | Optimizer experiments: Security skill | `optimize/` | keep | `state/experiments-security.jsonl` |
| 217 | `skill-optimizer-experiments-ship.jsonl` | Optimizer experiments: ship skill | `optimize/` | keep | `state/experiments-ship.jsonl` |
| 218 | `skill-optimizer-experiments-testing-and-qa-validation.jsonl` | Optimizer experiments: testing skill | `optimize/` | keep | `state/experiments-testing-and-qa-validation.jsonl` |
| 219 | `skill-optimizer-experiments-Thinking.jsonl` | Optimizer experiments: Thinking skill | `optimize/` | keep | `state/experiments-thinking.jsonl` |
| 220 | `skill-review-queue.jsonl` | Skill review queue for manual inspection | `optimize/` | keep | `state/skill-review-queue.jsonl` |
| 221 | `skill-routing-baseline-2026-04-27.json` | Historical skill routing baseline snapshot | — | drop | — |

---

## Summary

| Disposition | Count | Percentage |
|-------------|-------|------------|
| **keep** | 138 | 62% |
| **merge** | 7 | 3% |
| **drop** | 65 | 29% |
| **defer** | 11 | 5% |
| **Total** | **221** | 100% |

### By Module (keep + merge only)

| Module | Files | Key Components |
|--------|-------|----------------|
| `capture/` | 23 | Rating, sentiment, debrief, skill invocation, tool audit, incident monitor |
| `evaluate/` | 17 | LLM judge, session scorer, recall evaluator, content evaluator, gold sets |
| `detect/` | 17 | Failure patterns, pattern mining, trajectories, theme cohorts, incident analysis |
| `promote/` | 14 | Rule tracker, budget, learning review, memory bridge, auto-feedback/success |
| `optimize/` | 30 | Hill-climb engine, prompt tuner, skill optimizer, benchmarks, experiments |
| `graph/` | 19 | Builder, query, retrieval, BM25, embedder, reranker, context hook |
| `adapters/` | 16 | Langfuse, JSONL, Claude Code, inference, hook-io, identity, paths, time |
| `daemon/` | 12 | Integrity, cleanup, counts, compressor, notifications, session digests |
| `bin/` | 1 | CLI entry point |

### Merge Plan

| Target AgentGrit File | PAI Sources Merged |
|-----------------------|-------------------|
| `adapters/claude-code.ts` | `BuildCLAUDE.ts` + `handlers/BuildCLAUDE.ts` |
| `adapters/langfuse.ts` | `langfuse-instrumentation.ts` (OTel setup merged into adapter) |
| `daemon/update-counts.ts` | `UpdateCounts.hook.ts` + `handlers/UpdateCounts.ts` |
| `daemon/integrity.ts` | `IntegrityMaintenance.ts` + `handlers/SystemIntegrity.ts` |
| `signals/skill-suggestions.jsonl` | `skill-router-suggestions.jsonl` + `skillrouter-events.jsonl` |

### Drop Rationale

65 files dropped across these categories:

| Category | Count | Examples |
|----------|-------|---------|
| Banner/UI cosmetics | 8 | Banner*.ts, PAILogo.ts, NeofetchBanner.ts |
| Terminal/tab management | 8 | TabState.ts, tab-setter.ts, *Tab*.hook.ts |
| Voice/TTS | 3 | VoiceCompletion.hook.ts, VoiceNotification.ts |
| PAI workflow enforcement | 8 | AgentBriefGuard, HarnessAFKGate, IssueCloseGuard |
| Content/media tools | 6 | ExtractTranscript, YouTubeApi, AddBg, RemoveBg |
| PRD/doc management | 5 | PRDSync, DocHygiene, DocIntegrity, prd-*.ts |
| One-time migrations | 2 | BackfillFailureFields, BackfillRuleIds |
| PAI-specific utilities | 10 | Algorithm, SessionProgress, FeatureRegistry, etc. |
| Relationship/opinion | 3 | RelationshipReflect, OpinionTracker, RelationshipMemory |
| PAI-specific data | 2 | ai-research-brief.json, skill-routing-baseline |
| Wisdom frames | 3 | WisdomCrossFrame*, WisdomDomain*, WisdomFrame* |
| Other PAI-specific | 7 | SecurityValidator, SessionAutoName, SkillRouter, etc. |
