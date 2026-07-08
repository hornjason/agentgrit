/**
 * @agentgrit/core - Programmatic API
 *
 * Self-learning engine that makes AI agents smarter over time.
 * Exports core functions for graph building, signal capture, and rule management.
 */

// ── Graph & Context ──

export { buildGraph, updateGraph, readGraph, writeGraphFile, pruneStaleNodes, keywordClassify, parseFrontmatter, inferSeverity } from "./graph/builder";
export { buildIndex, buildIndexFromDir, searchIndex, tokenize } from "./graph/bm25";
export { queryGraph } from "./graph/query";
export { hybridRetrieve } from "./graph/retrieval";
export { embedRules, semanticSearch, cosine, findEmbeddingEdges } from "./graph/embedder";
export { getContextRules, detectDomains, bm25InferDomains } from "./graph/context";

// ── Signal Capture ──

export { captureRating, parseRating, scoreSentiment, computeComposite, cacheLastResponse, writeLastResponse, scoreSession, captureSessionSentiment, wordOverlapRatio } from "./capture/rating";
export { detectCorrection, captureFailure, auditAssertions, extractWorkLearnings } from "./capture/corrections";
export { captureSkillInvocation, classifyOutcome, captureSkillSequence, buildCoOccurrencePairs, analyzeSkillSequence } from "./capture/skills";
export { extractDebrief } from "./capture/debrief";
export { captureToolUse, categorizeToolName, buildMinimalAudit } from "./capture/tool-audit";
export { parseToolUseBlocks, categorizeChange, isSignificantChange, classifyLearning, isLearningCapture, generateHookConfig } from "./capture/index";

// ── Rule Management ──

export { promoteRule, removeRule } from "./promote/bridge";
export { checkBudget } from "./promote/budget";
export { trackRule, getEvictionCandidates, trackAttributedRules, correlateRules, ruleStatsPath, loadRuleStats, persistRuleStats } from "./promote/rules";

// ── Pattern Detection ──

export { detectFailurePatterns } from "./detect/failures";
export { minePatterns } from "./detect/patterns";
export { addTrajectory, queryTrajectoriesSync } from "./detect/trajectories";

// ── Types ──

export type { Rule, Tier, Pattern, Trajectory, CorrectionSignal, RatingSignal, SkillInvocationSignal } from "./adapters/types";
export type { Graph, BM25Index, RankedCluster, ConnectedNode, DocEntry, VocabEntry, SearchResult, RetrievalResult, EmbedConfig, Embedding } from "./graph/types";
export type { RatingParseResult, Turn, SessionScoreResult } from "./capture/rating";
export type { FailureContext, FailureSignal, AssertionViolation, AssertionAuditResult, WorkLearning } from "./capture/corrections";
export type { SkillOutcome, SkillSequenceEntry, SkillSequenceResult } from "./capture/skills";
export type { RuleCandidate, DebriefResult, ApprovalSignal } from "./capture/debrief";
export type { ToolCategory, ToolAuditEntry, MinimalToolAudit } from "./capture/tool-audit";
export type { ChangeCategory, FileChange, LearningCategory } from "./capture/index";
export type { HookConfig } from "./capture/index";
export type { BudgetLevel, BudgetStatus } from "./promote/budget";
export type { RuleStats } from "./promote/rules";
