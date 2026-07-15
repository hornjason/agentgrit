/**
 * @agentgrit/core — Public API surface
 *
 * Re-exports key functions and types from all 7 subsystems:
 * capture, detect, promote, graph, evaluate, optimize, daemon
 *
 * Plus core types from adapters/types and adapters/inference.
 */

// ────────────────────────────────────────────
// Core types (adapters)
// ────────────────────────────────────────────
export {
  SCHEMA_VERSION,
  Tier,
  type Signal,
  type RatingSignal,
  type CorrectionSignal,
  type SentimentSignal,
  type SkillInvocationSignal,
  type AnySignal,
  type Score,
  type Rule,
  type Pattern,
  type EdgeType,
  type EdgeSource,
  type GraphNode,
  type GraphEdge,
  type Trajectory,
  type Dimension,
  type RubricConfig,
  type PromotionRecord,
  type EmbeddingProvider,
  type AgentGritConfig,
  type SignalReader,
  type SignalWriter,
  type SignalAdapter,
} from "./adapters/types";

export {
  type InferenceOptions,
  type InferenceResult,
  type InferenceLevel,
  type InferenceProvider,
  inference,
} from "./adapters/inference";

export { loadConfig, getBaseDir, signalsDir, stateDir } from "./adapters/paths";

export { appendSignal, readSignals, createJsonlAdapter } from "./adapters/jsonl";

// ────────────────────────────────────────────
// 1. Capture
// ────────────────────────────────────────────
export {
  // Rating
  captureRating,
  parseRating,
  scoreSentiment,
  computeComposite,
  scoreSession,
  captureSessionSentiment,
  wordOverlapRatio,
  type RatingParseResult,
  type Turn,
  type SessionScoreResult,

  // Corrections
  detectCorrection,
  captureFailure,
  auditAssertions,
  extractWorkLearnings,
  type FailureContext,
  type FailureSignal,
  type AssertionViolation,
  type AssertionAuditResult,
  type WorkLearning,

  // Skills
  captureSkillInvocation,
  classifyOutcome,
  captureSkillSequence,
  buildCoOccurrencePairs,
  analyzeSkillSequence,
  type SkillOutcome,
  type SkillSequenceEntry,
  type SkillSequenceResult,

  // Debrief
  extractDebrief,
  type RuleCandidate,
  type DebriefResult,
  type ApprovalSignal,

  // Tool audit
  captureToolUse,
  categorizeToolName,
  buildMinimalAudit,
  type ToolCategory,
  type ToolAuditEntry,
  type MinimalToolAudit,

  // Change detection
  categorizeChange,
  parseToolUseBlocks,
  isSignificantChange,
  type ChangeCategory,
  type FileChange,

  // Learning
  classifyLearning,
  isLearningCapture,
  type LearningCategory,

  // Hook config
  generateHookConfig,
  type HookConfig,
} from "./capture/index";

export {
  harvest,
  harvestFromTranscript,
  formatLearningFile,
  type HarvestedLearning,
  type HarvestResult,
} from "./capture/harvester";

export {
  detectError,
  recordIncident,
  monitorToolOutput,
  analyzeSessionPatterns,
  type IncidentRecord,
  type IncidentDetectResult,
} from "./capture/incidents";

// ────────────────────────────────────────────
// 2. Detect
// ────────────────────────────────────────────
export { minePatterns, type MinePatternsOptions } from "./detect/patterns";
export { detectFailurePatterns } from "./detect/failures";
export {
  addTrajectory,
  queryTrajectories,
  queryTrajectoriesSync,
  gcTrajectories,
} from "./detect/trajectories";
export {
  convertPatternReports,
  readProcessedReports,
  parseNewGapPatterns,
  getExistingFeedbackSlugs,
  writeFeedbackMemory,
  type NewGapPattern,
  type ConversionResult,
} from "./detect/pattern-converter";
export {
  buildCohorts,
  generateAntiRationalizations,
  type ThemeCohort,
  type AntiRationalization,
} from "./detect/theme-cohorts";

// ────────────────────────────────────────────
// 3. Promote
// ────────────────────────────────────────────
export {
  checkBudget,
  checkLearnedBudget,
  pruneLearnedRules,
  type BudgetLevel,
  type BudgetStatus,
} from "./promote/budget";

export {
  promoteRule,
  removeRule,
  type PromoteResult,
  type PromoteStatus,
} from "./promote/bridge";

export {
  evictRules,
  findEvictionCandidates,
  findDuplicates,
  enforceBudget,
  expirePendingRules,
  type EvictionCandidate,
  type DuplicateCandidate,
  type EvictionResult,
} from "./promote/evict";

export {
  attributeRulesToCorrections,
  type RuleAttribution,
} from "./promote/attribution";

export {
  reviewDomains,
  runDomainReview,
  type DomainReviewResult,
} from "./promote/domain-review";

export { routeRule, type RouteResult } from "./promote/router";
export {
  checkContradiction,
  extractExistingRules,
  type ContradictionResult,
} from "./promote/contradiction";
export {
  trackRule,
  correlateRules,
  getEvictionCandidates as getRuleEvictionCandidates,
  type RuleStats,
} from "./promote/rules";
export { runReview, type ReviewResult } from "./promote/review";
export { recordPromotion, getPromotionHistory, undoPromotions } from "./promote/ledger";

// ────────────────────────────────────────────
// 4. Graph
// ────────────────────────────────────────────
export {
  // Types
  type Graph,
  type RankedCluster,
  type ConnectedNode,
  type BM25Index,
  type DocEntry,
  type VocabEntry,
  type SearchResult,
  type RetrievalResult,
  type EmbedConfig,
  type Embedding,

  // Builder
  buildGraph,
  updateGraph,
  readGraph,
  writeGraphFile,
  pruneStaleNodes,
  keywordClassify,
  parseFrontmatter,
  inferSeverity,
  loadRuleDomains,
  defaultRuleDomainsPath,

  // Query
  queryGraph,

  // BM25
  buildIndex,
  buildIndexFromDir,
  searchIndex,
  tokenize,

  // Retrieval
  hybridRetrieve,

  // Embedder
  embedRules,
  semanticSearch,
  cosine,
  findEmbeddingEdges,

  // Context
  getContextRules,
  detectDomains,
  parseLearnedRules,
  filterLearnedRules,
} from "./graph/index";

export { propagateDomains } from "./graph/domain-propagation";
export { classifyIsolatedNodes, type ClassifyResult } from "./graph/classify-isolated";
export { generateReport, formatReportMarkdown, type GraphReport, type GraphHealthMetrics } from "./graph/report";
export {
  type RRFWeights,
  RRF_WEIGHTS,
  rrfMerge,
} from "./graph/retrieval";
export {
  writeSessionContext,
  readSessionContext,
  readSessionHistory,
  createReranker,
  getContextRulesWithReranking,
  type SessionContext,
  type Reranker,
} from "./graph/context";
export {
  splitDocSections,
  buildDocSectionCache,
  loadDocSectionCache,
  retrieveRelevantSections,
  type DocSection,
  type DocSectionCache,
} from "./graph/doc-sections";

// ────────────────────────────────────────────
// 5. Evaluate
// ────────────────────────────────────────────
export {
  evaluateRecall,
  recallAtK,
  precisionAtK,
  reciprocalRank,
  bootstrapCI,
  evaluateSessionRecall,
  aggregateRecallScores,
  type RecallResult,
  type SessionRecallScore,
  type RecallEvalResult,
} from "./evaluate/recall";

export {
  judgeTrace,
  judgeBatch,
  scoresToJsonl,
  jsonlToScores,
  type JudgeConfig,
  type Trace,
  type BatchResult,
} from "./evaluate/judge";

export {
  autoLabel,
  generateSynthetic,
  buildRuleList,
  inferDomains,
  domainFallback,
  selectTargets,
  type GoldSession,
  type GoldSet,
  type AutoLabelConfig,
  type AutoLabelResult,
  type SyntheticConfig,
  type SyntheticResult,
} from "./evaluate/gold";

// Alias to avoid collision with capture's scoreSession
export {
  scoreSession as scoreSessionSignals,
  scoreTranscript,
  compositeQuality,
  scoreTranscriptBatch,
  buildQualityJudgePrompt,
  type TranscriptQualityResult,
  type TranscriptScoreConfig,
  type QualityDimension,
} from "./evaluate/session";

export {
  analyzeScores,
  detectTrends,
  type DimensionAnalysis,
  type TrendResult,
} from "./evaluate/analysis";

export {
  checkEvalRegression,
  type EvalRegressionResult,
} from "./evaluate/regression";

// ────────────────────────────────────────────
// 6. Optimize
// ────────────────────────────────────────────
export {
  hillClimb,
  type HillClimbConfig,
  type HillClimbResult,
  type RoundResult,
} from "./optimize/hill-climb";

export {
  tuneSkill,
  fastEvaluate,
  evaluateSkill,
  scoreDeterministic,
  getCriteriaForSkill,
  type SkillTuneConfig,
  type SkillTuneResult,
  type SkillEvalResult,
  type FastEvalConfig,
  type FastEvalResult,
  type Criterion,
} from "./optimize/skill-tuner";

export {
  tunePrompt,
  type PromptTuneConfig,
  type PromptTuneResult,
} from "./optimize/prompt-tuner";

export {
  computeSkillMetrics,
  type SkillMetrics,
  type UsageStats,
  type AccuracyResult,
} from "./optimize/skill-metrics";

export {
  buildBenchmark,
  loadBenchmark,
  saveBenchmark,
  verifyBenchmark,
  type Benchmark,
  type BenchmarkTask,
} from "./optimize/benchmark";

// ────────────────────────────────────────────
// 7. Daemon
// ────────────────────────────────────────────
export {
  runDaemonCycle,
  runWeeklyReview,
  isWeeklyDay,
  type CycleResult,
  type WeeklyReviewResult,
} from "./daemon/daemon";

export {
  runDoctor,
  type DoctorReport,
  type DoctorSection,
  type CheckResult,
  type CheckStatus,
} from "./daemon/doctor";

export {
  installScheduler,
  uninstallScheduler,
  getSchedulerStatus,
  generatePlist,
  generateSystemdService,
  type SchedulerConfig,
  type SchedulerStatus,
} from "./daemon/scheduler";

export {
  cleanupSession,
  rotateSignals,
  compressSession,
  updateCounts,
  type CleanupResult,
  type CompressResult,
  type CountsResult,
} from "./daemon/cleanup";

export {
  generateFeedback,
  generateSuccess,
  type FeedbackResult,
} from "./daemon/feedback";

export {
  recordSessionStart,
  getSessionDurationMinutes,
  getSessionStartTime,
} from "./daemon/timing";
