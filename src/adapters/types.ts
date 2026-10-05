export const SCHEMA_VERSION = 1;

// ── Tier ──

export enum Tier {
  Global = "global",
  Project = "project",
  Graph = "graph",
}

// ── Signals ──

export interface Signal {
  id?: string;
  timestamp: string;
  session_id: string;
  schemaVersion?: number;
}

export interface RatingSignal extends Signal {
  type: "rating";
  rating: number;
  source: "explicit" | "implicit" | "praise" | "thumbs";
  comment?: string;
  sentimentSummary?: string;
  confidence?: number;
  response_preview?: string;
  rule_ids?: string[];
  scorer_version?: string;
  source_weight?: number;
}

export interface CorrectionSignal extends Signal {
  type: "correction";
  correction_phrase: string;
  context: string;
  turn_index?: number;
}

export interface SentimentSignal extends Signal {
  type: "sentiment";
  rating: number;
  source: "transcript-analysis";
  confidence: number;
  corrections: number;
  approvals: number;
  reprompts: number;
  scorer_version?: string;
  source_weight?: number;
}

export interface SkillInvocationSignal extends Signal {
  type: "skill-invocation";
  skill: string;
  workflow?: string;
}

export type AnySignal =
  | RatingSignal
  | CorrectionSignal
  | SentimentSignal
  | SkillInvocationSignal;

// ── Scores ──

export interface Score {
  traceId: string;
  dimension: string;
  value: number;
  rubric: string;
  judgeModel: string;
  reasoning?: string;
  timestamp: string;
  schemaVersion: number;
}

// ── Rules ──

export interface Rule {
  id: string;
  text: string;
  tier: Tier;
  tags: string[];
  created: string;
  correlationScore: number;
  sourceSignals: string[];
  schemaVersion: number;
  domainSource?: "propagation" | "bm25" | "keyword" | "ai" | "override";
  injectionCount?: number;
  avgCorrelatedRating?: number;
  highRatingActivations?: number;
  lowRatingActivations?: number;
  sessionRatings?: number[];
  lastSeen?: string;
  rawAvgRating?: number;
  decayedRating?: number;
  proposedAt?: string;
  signals?: {
    bm25Rank?: number;
    vectorRank?: number;
    graphExpansionRank?: number;
    coOccurrenceBoost?: number;
  };
}

// ── Patterns ──

export interface Pattern {
  id: string;
  type: string;
  frequency: number;
  sessions: string[];
  severity: number;
  candidateRule?: string;
  firstSeen?: string;
  lastSeen?: string;
}

// ── Graph ──

export type EdgeType =
  | "reinforces"
  | "sibling"
  | "caused_by_same_root"
  | "applies_when"
  | "conflicts_with"
  | "supersedes"
  | "same_domain"
  | "co_occurred"
  | "co_occurred_in_failure"
  | "contradicts"
  | "caused_by";

export type EdgeSource = "inferred" | "explicit" | "manual" | "embedding";

export interface GraphNode {
  id: string;
  file: string;
  type: string;
  name: string;
  description: string;
  domains: string[];
  domainSource?: "propagation" | "bm25" | "keyword" | "ai" | "override";
  severity: number;
  occurrence_count: number;
  last_updated: string;
  content_hash: string;
  memoryType: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  relationship: EdgeType;
  strength: number;
  source?: EdgeSource;
}

// ── Trajectories ──

export interface Trajectory {
  id: string;
  task: string;
  domains: string[];
  summary: string;
  rating: number;
  steps?: string[];
  timestamp: string;
  agentId?: string;
}

// ── Rubrics ──

export interface Dimension {
  name: string;
  description: string;
  weight: number;
  rubric: string;
}

export interface RubricConfig {
  version: string;
  schemaVersion: number;
  dimensions: Dimension[];
  judgeModel: string;
}

// ── Learning Artifact Stats (Phase 3 — #211) ──

export interface LearningArtifactStats {
  artifactId: string;
  firingCount: number;
  lastFired: string;
  createdAt: string;
  destination: string;
}

// ── Promotion ──

export interface PromotionRecord {
  id: string;
  ruleId: string;
  tier: Tier;
  timestamp: string;
  beforeSnapshot: string;
  afterSnapshot: string;
  approved: boolean;
}

// ── Embedding Provider ──

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

// ── Config ──

/**
 * Filesystem locations AgentGrit reads or writes.
 *
 * Every key is optional — the defaults in src/adapters/paths.ts make a fresh
 * install self-contained under the base dir. Set a key only to pin a path
 * somewhere else, which is what an existing install needs during migration so
 * its accumulated history keeps resolving. Values may start with ~ or $HOME.
 */
export interface AgentGritPaths {
  /** The coding agent's config dir. Default: ~/.claude */
  hostDir?: string;
  /** The host's global rules file. Default: <hostDir>/CLAUDE.md */
  hostRulesFile?: string;
  /** The host's project registry. Default: <hostDir>.json, i.e. ~/.claude.json */
  hostRegistryFile?: string;
  /**
   * The per-project config folder the host looks for inside a repo.
   * A fixed convention of the host tool, independent of where its global
   * config dir lives. Default: .claude
   */
  hostProjectDirName?: string;
  /** Where the host stores session transcripts. Default: <hostDir>/projects */
  hostTranscriptsDir?: string;
  /** Generated rules file the host reads. Default: <hostDir>/CLAUDE-LEARNED.md */
  learnedRulesFile?: string;
  /** Default: <baseDir>/state/rule-domains.json */
  ruleDomainsFile?: string;
  /** Default: <baseDir>/rules */
  rulesDir?: string;
  /** Default: <baseDir>/PENDING-RULES.md */
  pendingRulesFile?: string;
  /** Default: <baseDir>/PENDING-RULES-ARCHIVE.md */
  pendingRulesArchiveFile?: string;
  /** Default: <baseDir>/context/GRAPH-CONTEXT.md */
  graphContextFile?: string;
  /** Default: <baseDir>/state/patterns.json */
  patternsFile?: string;
  /** Default: <baseDir>/state/recall-scores.json */
  recallScoresFile?: string;
  /** A prior system's signals to read alongside our own. Unset means none. */
  legacySignalDir?: string;
  /** Path fragments excluded from change capture as bookkeeping noise. */
  uncapturedFragments?: string[];
}

export interface AgentGritConfig {
  signalDir: string;
  memoryDir?: string;
  transcriptDir?: string;
  paths?: AgentGritPaths;
  adapter: "local" | "langfuse" | "both";
  langfuse?: {
    publicKey: string;
    secretKey: string;
    baseUrl: string;
  };
  judge?: {
    provider: "gemini" | "claude" | "openai";
    model: string;
    apiKey?: string;
  };
  rubrics: string[];
  rules: {
    globalBudget: number;
    projectBudget: number;
    learnedBudget?: number;
    pendingExpiryDays?: number;
    autoPromote: boolean;
    autoEvict?: boolean;
  };
  daemon: {
    interval: string;
    weeklyDay: string;
    autoPrune?: boolean;
  };
  thresholds?: {
    coolingPeriodDays?: number;
    ratingLowThreshold?: number;
    correlationThreshold?: number;
    similarityThreshold?: number;
    defaultEvictionBudget?: number;
    expansionDecay?: number;
    defaultDomains?: string[];
    scoringBase?: number;
    correctionWeight?: number;
    repromptWeight?: number;
    iterationWeight?: number;
    firstPassBonus?: number;
    uninterruptedBonus?: number;
    uninterruptedCap?: number;
    frustrationWeight?: number;
    thumbsUpScore?: number;
    thumbsDownScore?: number;
    praiseScore?: number;
    decayHalfLife?: number;
    qualityFloorThreshold?: number;
    qualityFloorMinSessions?: number;
  };
  rrfWeights?: {
    bm25?: number;
    graph?: number;
    vector?: number;
  };
}

// ── Adapter interfaces ──

export interface SignalReader {
  read(file: string, opts?: { offset?: number; limit?: number }): Promise<AnySignal[]>;
}

export interface SignalWriter {
  append(file: string, signal: AnySignal): Promise<void>;
}

export interface SignalAdapter extends SignalReader, SignalWriter {
  rotate(file: string, maxSizeBytes: number): Promise<{ rotated: boolean; archivePath?: string }>;
}
