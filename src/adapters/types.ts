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
  source: "explicit" | "implicit";
  comment?: string;
  sentimentSummary?: string;
  confidence?: number;
  response_preview?: string;
  rule_ids?: string[];
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
  injectionCount?: number;
  avgCorrelatedRating?: number;
  highRatingActivations?: number;
  lowRatingActivations?: number;
  sessionRatings?: number[];
  lastSeen?: string;
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

export interface AgentGritConfig {
  signalDir: string;
  memoryDir?: string;
  transcriptDir?: string;
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
  };
  daemon: {
    interval: string;
    weeklyDay: string;
  };
  thresholds?: {
    coolingPeriodDays?: number;
    ratingLowThreshold?: number;
    correlationThreshold?: number;
    similarityThreshold?: number;
    defaultEvictionBudget?: number;
    expansionDecay?: number;
    defaultDomains?: string[];
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
