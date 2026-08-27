import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { stateDir } from "../adapters/paths";
import type { RuleStats } from "./rules";
import { getFilteredRuleIds } from "./lifecycle";
import type { LearningArtifactStats } from "../adapters/types";

export type EvictionTrigger = "low-avg-high-volume" | "never-helped" | "net-negative-roi" | "high-injection-low-value" | "frequency-cap" | "negative-lift";

export interface EvictionResult {
  trigger: EvictionTrigger;
  reason: string;
}

export interface EvictionLogEntry {
  ruleId: string;
  trigger: EvictionTrigger;
  reason: string;
  avgRating: number;
  injections: number;
  highActivations: number;
  lowActivations: number;
  timestamp: string;
}

const MIN_INJECTION_SAFETY = 5;

export function shouldEvict(
  stats: RuleStats,
  allowlist?: Set<string>,
  totalSessions?: number,
): EvictionResult | null {
  if (stats.injectionCount < MIN_INJECTION_SAFETY) return null;
  if (allowlist?.has(stats.ruleId)) return null;
  if (stats.differentialLift !== undefined && stats.differentialLift > 0) return null;

  // Trigger 4: high injection count with low value (most specific — checked first)
  if (stats.injectionCount >= 150 && stats.avgCorrelatedRating < 4.0) {
    return {
      trigger: "high-injection-low-value",
      reason: `${stats.injectionCount} injections with avg ${stats.avgCorrelatedRating.toFixed(2)} < 4.0`,
    };
  }

  // Trigger 5: frequency cap — fires too often without helping
  // Guard: skip when lift is undefined (not enough data) or positive
  if (
    totalSessions &&
    totalSessions > 0 &&
    stats.injectionCount / totalSessions > 0.6 &&
    stats.differentialLift !== undefined &&
    stats.differentialLift <= 0
  ) {
    const pct = ((stats.injectionCount / totalSessions) * 100).toFixed(0);
    return {
      trigger: "frequency-cap",
      reason: `${pct}% session frequency (${stats.injectionCount}/${totalSessions}) with differential lift ${stats.differentialLift.toFixed(2)} <= 0`,
    };
  }

  // Trigger 6: negative differential lift — actively hurts session quality
  if (
    stats.differentialLift !== undefined &&
    stats.differentialLift < -0.5 &&
    stats.injectionCount >= 10
  ) {
    return {
      trigger: "negative-lift",
      reason: `differential lift ${stats.differentialLift.toFixed(2)} < -0.5 with ${stats.injectionCount} injections`,
    };
  }

  // Trigger 1: low avg + high volume
  if (stats.avgCorrelatedRating < 4.0 && stats.injectionCount > 50) {
    return {
      trigger: "low-avg-high-volume",
      reason: `avg ${stats.avgCorrelatedRating.toFixed(2)} < 4.0 with ${stats.injectionCount} injections`,
    };
  }

  // Trigger 2: never helped
  if (stats.highRatingActivations === 0 && stats.injectionCount >= 5) {
    return {
      trigger: "never-helped",
      reason: `0 high-rating activations after ${stats.injectionCount} injections`,
    };
  }

  // Trigger 3: net negative ROI
  if (
    stats.lowRatingActivations > stats.highRatingActivations * 2 &&
    stats.injectionCount >= 10
  ) {
    return {
      trigger: "net-negative-roi",
      reason: `${stats.lowRatingActivations} low vs ${stats.highRatingActivations} high activations (>${stats.highRatingActivations * 2} threshold)`,
    };
  }

  return null;
}

export function loadEvictionAllowlist(path?: string): Set<string> {
  const filePath = path ?? join(stateDir(), "eviction-allowlist.json");
  if (!existsSync(filePath)) return new Set();
  try {
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    return new Set(Array.isArray(data) ? data : []);
  } catch {
    return new Set();
  }
}

export function addToEvictionAllowlist(ruleId: string, path?: string): void {
  const filePath = path ?? join(stateDir(), "eviction-allowlist.json");
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const existing = loadEvictionAllowlist(filePath);
  existing.add(ruleId);
  writeFileSync(filePath, JSON.stringify([...existing], null, 2), "utf-8");
}

export interface EvictedRegistryEntry {
  ruleId: string;
  trigger: EvictionTrigger;
  reason: string;
  evictedAt: string;
}

export function loadEvictedRegistry(dir?: string): Set<string> {
  return new Set(loadEvictedRegistryEntries(dir).map(e => e.ruleId));
}

export function loadEvictedRegistryEntries(dir?: string): EvictedRegistryEntry[] {
  const filePath = join(dir ?? stateDir(), "evicted-rules.json");
  if (!existsSync(filePath)) return [];
  try {
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    return Array.isArray(data?.evicted) ? data.evicted : [];
  } catch {
    return [];
  }
}

/** @deprecated Use transitionRule() from lifecycle.ts instead. Writes to evicted-rules.json will be removed. */
export function addToEvictedRegistry(
  entry: { ruleId: string; trigger: EvictionTrigger; reason: string },
  dir?: string,
): void {
  const baseDir = dir ?? stateDir();
  const filePath = join(baseDir, "evicted-rules.json");
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });

  const existing = loadEvictedRegistryEntries(baseDir);
  if (existing.some(e => e.ruleId === entry.ruleId)) return;

  existing.push({
    ruleId: entry.ruleId,
    trigger: entry.trigger,
    reason: entry.reason,
    evictedAt: new Date().toISOString(),
  });

  const content = JSON.stringify({ evicted: existing }, null, 2);
  const tmpPath = filePath + ".tmp." + process.pid;
  try {
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* cleanup best-effort */ }
    throw err;
  }
}

export function appendEvictionLog(entry: EvictionLogEntry, dir?: string): void {
  const baseDir = dir ?? stateDir();
  const evictedIds = getFilteredRuleIds(['evicted'], baseDir);
  if (evictedIds.has(entry.ruleId)) return;

  const logPath = join(baseDir, "eviction-log.jsonl");
  const logDir = dirname(logPath);
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
}

export function readEvictionLog(dir?: string): EvictionLogEntry[] {
  const logPath = join(dir ?? stateDir(), "eviction-log.jsonl");
  if (!existsSync(logPath)) return [];
  try {
    return readFileSync(logPath, "utf-8")
      .split("\n")
      .filter(l => l.trim())
      .map(l => JSON.parse(l) as EvictionLogEntry);
  } catch {
    return [];
  }
}

// ── Learning Artifact Eviction (Phase 3 — #211) ──

const STATS_FILE = "learning-artifact-stats.jsonl";

/**
 * Configuration for learning artifact lifecycle management.
 * Initial defaults are conservative pending instrumentation data from shadow mode.
 */
export interface LearningEvictionConfig {
  /** Days with firingCount=0 before an artifact becomes an eviction candidate. Initial default: 90 */
  evictionDays: number;
  /** Minimum firing count within the promotion window to qualify for promotion. Initial default: 10 */
  promotionFiringThreshold: number;
  /** Window (days) over which lastFired must fall for promotion eligibility. Initial default: 30 */
  promotionWindowDays: number;
  /** When true, returns candidates but does NOT delete/promote — logs only. Default: true (initial defaults pending instrumentation data) */
  loggingOnly: boolean;
}

export interface LearningEvictionResult {
  candidates: LearningArtifactStats[];
  loggingOnly: boolean;
}

export interface LearningPromotionResult {
  candidates: LearningArtifactStats[];
  loggingOnly: boolean;
}

/**
 * Load all artifact stats from the JSONL file.
 */
export function loadArtifactStats(dataDir: string): LearningArtifactStats[] {
  const filePath = join(dataDir, STATS_FILE);
  if (!existsSync(filePath)) return [];
  try {
    return readFileSync(filePath, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as LearningArtifactStats);
  } catch {
    return [];
  }
}

function writeArtifactStats(dataDir: string, stats: LearningArtifactStats[]): void {
  const filePath = join(dataDir, STATS_FILE);
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const content = stats.map((s) => JSON.stringify(s)).join("\n") + (stats.length > 0 ? "\n" : "");
  const tmpPath = filePath + ".tmp." + process.pid;
  try {
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* cleanup best-effort */ }
    throw err;
  }
}

/**
 * Record that a learning artifact fired. Increments firingCount, updates lastFired.
 * Creates the artifact entry on first firing.
 */
export function recordArtifactFiring(artifactId: string, dataDir: string, destination: string): void {
  const existing = loadArtifactStats(dataDir);
  const idx = existing.findIndex((s) => s.artifactId === artifactId);
  const now = new Date().toISOString();

  if (idx >= 0) {
    existing[idx].firingCount++;
    existing[idx].lastFired = now;
  } else {
    existing.push({
      artifactId,
      firingCount: 1,
      lastFired: now,
      createdAt: now,
      destination,
    });
  }

  writeArtifactStats(dataDir, existing);
}

/**
 * Returns eviction candidates: artifacts with firingCount=0 for longer than config.evictionDays.
 * Default is logging-only — returns candidates but does not delete.
 */
export function shouldEvictLearning(
  stats: LearningArtifactStats[],
  config: LearningEvictionConfig,
): LearningEvictionResult {
  const now = Date.now();
  const thresholdMs = config.evictionDays * 24 * 60 * 60 * 1000;

  const candidates = stats.filter((s) => {
    if (s.firingCount > 0) return false;
    // Use lastFired (which equals createdAt for never-fired artifacts) as the reference point
    const referenceTime = new Date(s.lastFired).getTime();
    return (now - referenceTime) >= thresholdMs;
  });

  return {
    candidates,
    loggingOnly: config.loggingOnly,
  };
}

/**
 * Returns promotion candidates: artifacts with firingCount >= threshold and lastFired within the promotion window.
 * Default is logging-only — returns candidates but does not promote.
 */
export function shouldPromoteLearning(
  stats: LearningArtifactStats[],
  config: LearningEvictionConfig,
): LearningPromotionResult {
  const now = Date.now();
  const windowMs = config.promotionWindowDays * 24 * 60 * 60 * 1000;

  const candidates = stats.filter((s) => {
    if (s.firingCount < config.promotionFiringThreshold) return false;
    // lastFired must be within the promotion window
    const lastFiredTime = new Date(s.lastFired).getTime();
    return (now - lastFiredTime) <= windowMs;
  });

  return {
    candidates,
    loggingOnly: config.loggingOnly,
  };
}
