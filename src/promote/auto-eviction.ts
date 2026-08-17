import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { stateDir } from "../adapters/paths";
import type { RuleStats } from "./rules";

export type EvictionTrigger = "low-avg-high-volume" | "never-helped" | "net-negative-roi" | "high-injection-low-value";

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
): EvictionResult | null {
  if (stats.injectionCount < MIN_INJECTION_SAFETY) return null;
  if (allowlist?.has(stats.ruleId)) return null;

  // Trigger 4: high injection count with low value (most specific — checked first)
  if (stats.injectionCount >= 150 && stats.avgCorrelatedRating < 4.0) {
    return {
      trigger: "high-injection-low-value",
      reason: `${stats.injectionCount} injections with avg ${stats.avgCorrelatedRating.toFixed(2)} < 4.0`,
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

export function appendEvictionLog(entry: EvictionLogEntry, dir?: string): void {
  const logPath = join(dir ?? stateDir(), "eviction-log.jsonl");
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
