export const SCHEMA_VERSION = 1;

// ── Tier ──

export enum Tier {
  Global = "global",
  Project = "project",
  Graph = "graph",
}

// ── Signals ──

export interface Signal {
  id: string;
  timestamp: string;
  sessionId: string;
  schemaVersion: number;
}

export interface RatingSignal extends Signal {
  type: "rating";
  rating: number;
  source: "explicit" | "implicit";
  comment?: string;
  sentimentSummary?: string;
  confidence?: number;
  responsePreview?: string;
  ruleIds?: string[];
}

export interface CorrectionSignal extends Signal {
  type: "correction";
  trigger: string;
  context: string;
  severity: number;
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
  skillName: string;
  trigger: string;
  duration?: number;
  success?: boolean;
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
  | "co_occurred_in_failure"
  | "contradicts"
  | "caused_by";

export type EdgeSource = "inferred" | "explicit" | "manual" | "embedding";

export interface GraphNode {
  id: string;
  name: string;
  domains: string[];
  ruleText?: string;
  hash?: string;
  stats: GraphNodeStats;
}

export interface GraphNodeStats {
  injectionCount: number;
  avgRating: number;
  highRatingActivations: number;
  lowRatingActivations: number;
  sessionRatings: number[];
  lastSeen: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: EdgeType;
  strength: number;
  edgeSource?: EdgeSource;
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

// ── Config ──

export interface AgentGritConfig {
  signalDir: string;
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
    autoPromote: boolean;
  };
  daemon: {
    interval: string;
    weeklyDay: string;
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
