import {
  Tier,
  type Pattern,
  type RoutedLearning,
  type LearningRouteResult,
  type TrustTier,
  type LearningAction,
} from "../adapters/types";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { checkCapacity } from "./budget";
import { recordIncident } from "../capture/incidents";
import type { IncidentRecord } from "../capture/incidents";

const BEHAVIORAL_KEYWORDS = [
  "verify", "read", "check", "confirm", "validate", "test",
  "before", "always", "never", "must", "surgical", "evidence",
  "ask", "first", "ensure", "review", "inspect",
];

const PROCEDURAL_KEYWORDS = [
  "run", "spawn", "invoke", "execute", "after", "when",
  "trigger", "fire", "launch", "call", "deploy", "rebuild",
  "use", "apply", "switch", "route", "queue",
];

export interface RouteResult {
  tier: Tier;
  rationale: string;
}

function classifyBehavioral(text: string): number {
  const lower = text.toLowerCase();
  return BEHAVIORAL_KEYWORDS.filter((kw) => lower.includes(kw)).length;
}

function classifyProcedural(text: string): number {
  const lower = text.toLowerCase();
  return PROCEDURAL_KEYWORDS.filter((kw) => lower.includes(kw)).length;
}

export function routeRule(
  pattern: Pattern,
  projectHistory: string[],
): RouteResult {
  const uniqueProjects = [...new Set(projectHistory)];

  if (uniqueProjects.length <= 1) {
    return {
      tier: Tier.Project,
      rationale: `Pattern observed in ${uniqueProjects.length === 0 ? "no" : "single"} project: ${uniqueProjects[0] ?? "unknown"}`,
    };
  }

  const ruleText = pattern.candidateRule ?? "";
  const behavioralScore = classifyBehavioral(ruleText);
  const proceduralScore = classifyProcedural(ruleText);

  if (behavioralScore > proceduralScore) {
    return {
      tier: Tier.Global,
      rationale: `Multi-project (${uniqueProjects.length}) behavioral pattern: ${behavioralScore} behavioral vs ${proceduralScore} procedural keywords`,
    };
  }

  return {
    tier: Tier.Graph,
    rationale: `Multi-project (${uniqueProjects.length}) procedural pattern: ${proceduralScore} procedural vs ${behavioralScore} behavioral keywords`,
  };
}

// ── Learning Router ──

export interface LearningRouteOpts {
  shadowMode?: boolean;
  /** When provided, executes the routed action (write/queue/incident) */
  dataDir?: string;
}

function routeByType(signal: RoutedLearning): LearningRouteResult {
  switch (signal.type) {
    case "mechanical-fix": {
      const destination = signal.artifactType ?? "template";
      const trustTier: TrustTier =
        signal.artifactType === "gate" ? "high" : "low";
      const action: LearningAction =
        trustTier === "high" ? "queue-for-promotion" : "direct-write";
      return {
        destination,
        trustTier,
        action,
        rationale: `mechanical-fix (confidence=${signal.confidence}) → ${destination}`,
      };
    }
    case "process-rule":
      return {
        destination: "claude-md",
        trustTier: "high",
        action: "queue-for-promotion",
        rationale: `process-rule (confidence=${signal.confidence}) → claude-md`,
      };
    case "domain-knowledge":
      return {
        destination: "feedback-memory",
        trustTier: "low",
        action: "direct-write",
        rationale: `domain-knowledge (confidence=${signal.confidence}) → feedback-memory`,
      };
    case "judgment":
      return {
        destination: "questionnaire",
        trustTier: "low",
        action: "direct-write",
        rationale: `judgment (confidence=${signal.confidence}) → questionnaire`,
      };
  }
}

export function routeLearning(
  signal: RoutedLearning,
  opts?: LearningRouteOpts,
): LearningRouteResult {
  // Confidence gate — below threshold goes to incidents staging
  if (signal.confidence < 0.7) {
    const result: LearningRouteResult = {
      destination: "incidents",
      trustTier: "low",
      action: opts?.shadowMode ? "shadow-log" : "incident-log",
      rationale: `Low confidence (${signal.confidence} < 0.7) → incidents staging`,
    };
    if (opts?.shadowMode) {
      logShadow(signal, result);
    }
    // Execute: record incident with learning_type
    if (opts?.dataDir && !opts?.shadowMode) {
      const incPath = join(opts.dataDir, "learning-incidents.jsonl");
      const incRecord: IncidentRecord = {
        timestamp: signal.timestamp,
        session_id: signal.learnStepId,
        error_snippet: signal.content.slice(0, 200),
        error_type: "learning-routing",
        command_preview: `routeLearning(${signal.type})`,
        learning_type: signal.type,
        confidence: signal.confidence,
      };
      recordIncident(incPath, incRecord);
    }
    return result;
  }

  const result = routeByType(signal);

  // Shadow mode: log and override action
  if (opts?.shadowMode) {
    logShadow(signal, result);
    return { ...result, action: "shadow-log" };
  }

  // Execute: write or queue based on action
  if (opts?.dataDir) {
    if (result.action === "queue-for-promotion") {
      const queuePath = join(opts.dataDir, "promotions-queue.jsonl");
      queueLearning(signal, result, queuePath);
    } else if (result.action === "direct-write") {
      const writesPath = join(opts.dataDir, "learning-writes.jsonl");
      // Capacity check before write
      const currentCount = countDestinationEntries(writesPath, result.destination);
      const cap = checkCapacity(result.destination, currentCount);
      if (cap.overCap) {
        evictOldest(writesPath, result.destination);
      }
      directWriteLearning(signal, result, writesPath);
    }
  }

  return result;
}

function logShadow(
  signal: RoutedLearning,
  result: LearningRouteResult,
): void {
  try {
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      signal: { type: signal.type, confidence: signal.confidence, learnStepId: signal.learnStepId },
      result,
    });
    appendFileSync(
      join(process.cwd(), "shadow-routing.jsonl"),
      entry + "\n",
    );
  } catch {
    // Shadow logging is best-effort — never blocks routing
  }
}

// ── Promotion Queue (#209) ──

const QUEUE_ESCALATION_DAYS = 14;
const DIRECT_WRITE_TTL_DAYS = 90;

export interface QueuedPromotion {
  content: string;
  evidence: string;
  destination: string;
  trustTier: TrustTier;
  type: string;
  confidence: number;
  queuedAt: string;
  sourceIssue: number;
  learnStepId: string;
}

export interface DirectWriteRecord {
  content: string;
  evidence: string;
  destination: string;
  type: string;
  confidence: number;
  writtenAt: string;
  expiresAt: string;
  sourceIssue: number;
  learnStepId: string;
}

export interface ProcessQueueResult {
  kept: number;
  escalated: QueuedPromotion[];
  expired: QueuedPromotion[];
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readJsonl<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

/**
 * Queue a high-trust learning for promotion review.
 * Writes to promotions-queue.jsonl.
 */
export function queueLearning(
  signal: RoutedLearning,
  route: LearningRouteResult,
  queuePath: string,
): void {
  ensureDir(queuePath);
  const record: QueuedPromotion = {
    content: signal.content,
    evidence: signal.evidence,
    destination: route.destination,
    trustTier: route.trustTier,
    type: signal.type,
    confidence: signal.confidence,
    queuedAt: new Date().toISOString(),
    sourceIssue: signal.sourceIssue,
    learnStepId: signal.learnStepId,
  };
  appendFileSync(queuePath, JSON.stringify(record) + "\n");
}

/**
 * Direct-write a low-trust learning with 90-day TTL.
 */
export function directWriteLearning(
  signal: RoutedLearning,
  route: LearningRouteResult,
  writesPath: string,
): void {
  ensureDir(writesPath);
  const writtenAt = new Date();
  const expiresAt = new Date(writtenAt);
  expiresAt.setDate(expiresAt.getDate() + DIRECT_WRITE_TTL_DAYS);

  const record: DirectWriteRecord = {
    content: signal.content,
    evidence: signal.evidence,
    destination: route.destination,
    type: signal.type,
    confidence: signal.confidence,
    writtenAt: writtenAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    sourceIssue: signal.sourceIssue,
    learnStepId: signal.learnStepId,
  };
  appendFileSync(writesPath, JSON.stringify(record) + "\n");
}

/**
 * Process the promotion queue:
 * - Items < 14 days old → remain queued
 * - Gate/claude-md patches >= 14 days → escalated
 * - Template patches >= 14 days → expired (removed)
 */
export function processPromotionQueue(queuePath: string): ProcessQueueResult {
  const result: ProcessQueueResult = {
    kept: 0,
    escalated: [],
    expired: [],
  };

  if (!existsSync(queuePath)) return result;

  const entries = readJsonl<QueuedPromotion>(queuePath);
  if (entries.length === 0) return result;

  const now = Date.now();
  const kept: QueuedPromotion[] = [];

  for (const entry of entries) {
    const queuedAt = new Date(entry.queuedAt).getTime();
    const ageInDays = (now - queuedAt) / (1000 * 60 * 60 * 24);

    if (ageInDays < QUEUE_ESCALATION_DAYS) {
      kept.push(entry);
    } else if (entry.destination === "template") {
      // Template patches expire
      result.expired.push(entry);
    } else {
      // Gate and claude-md patches escalate
      result.escalated.push(entry);
    }
  }

  result.kept = kept.length;

  // Rewrite queue with only kept items
  ensureDir(queuePath);
  if (kept.length > 0) {
    writeFileSync(
      queuePath,
      kept.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
  } else {
    writeFileSync(queuePath, "");
  }

  return result;
}

// ── Capacity helpers (#210) ──

function countDestinationEntries(filePath: string, destination: string): number {
  if (!existsSync(filePath)) return 0;
  const entries = readJsonl<{ destination?: string }>(filePath);
  return entries.filter((e) => e.destination === destination).length;
}

function evictOldest(filePath: string, destination: string): void {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((l) => l.trim());

  let evicted = false;
  const kept: string[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as { destination?: string };
      if (!evicted && entry.destination === destination) {
        evicted = true; // skip oldest (first) matching entry
        continue;
      }
    } catch {
      // keep malformed lines
    }
    kept.push(line);
  }

  writeFileSync(filePath, kept.length > 0 ? kept.join("\n") + "\n" : "");
}
