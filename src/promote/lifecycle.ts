import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { join } from "path";
import { stateDir } from "../adapters/paths";
import { loadEvictedRegistryEntries } from "./auto-eviction";

export type RuleLifecycleState = "active" | "graduated" | "evicted";

export interface RuleLifecycleEntry {
  state: RuleLifecycleState;
  transitionedAt: string;
  reason: string;
  addedBy: string;
}

export interface RuleLifecycle {
  version: 1;
  rules: Record<string, RuleLifecycleEntry>;
}

const LIFECYCLE_FILE = "rule-lifecycle.json";

export function loadLifecycle(dir?: string): RuleLifecycle {
  const filePath = join(dir ?? stateDir(), LIFECYCLE_FILE);
  if (!existsSync(filePath)) return { version: 1, rules: {} };
  try {
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    return data as RuleLifecycle;
  } catch {
    return { version: 1, rules: {} };
  }
}

export function saveLifecycle(lifecycle: RuleLifecycle, dir?: string): void {
  const baseDir = dir ?? stateDir();
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
  const filePath = join(baseDir, LIFECYCLE_FILE);
  const content = JSON.stringify(lifecycle, null, 2);
  const tmpPath = filePath + ".tmp." + process.pid;
  try {
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* cleanup best-effort */ }
    throw err;
  }
}

export function transitionRule(
  ruleId: string,
  state: RuleLifecycleState,
  reason: string,
  addedBy: string,
  dir?: string,
): void {
  const lifecycle = loadLifecycle(dir);
  lifecycle.rules[ruleId] = {
    state,
    transitionedAt: new Date().toISOString(),
    reason,
    addedBy,
  };
  saveLifecycle(lifecycle, dir);
}

export function readLifecycleState(ruleId: string, dir?: string): RuleLifecycleState {
  const lifecycle = loadLifecycle(dir);
  return lifecycle.rules[ruleId]?.state ?? "active";
}

export function getFilteredRuleIds(states: RuleLifecycleState[], dir?: string): Set<string> {
  const lifecycle = loadLifecycle(dir);
  const stateSet = new Set(states);
  const result = new Set<string>();
  for (const [ruleId, entry] of Object.entries(lifecycle.rules)) {
    if (stateSet.has(entry.state)) result.add(ruleId);
  }
  return result;
}

const GRADUATED_RULES = [
  "feedback_capture_decisions_immediately",
  "feedback_iterative_quality_loop",
  "success_real-data-honest-gaps",
  "feedback_read-background-task-output",
];

export function migrateFromEvictedRegistry(dir?: string): void {
  const baseDir = dir ?? stateDir();
  const lifecycle = loadLifecycle(baseDir);

  const evictedEntries = loadEvictedRegistryEntries(baseDir);
  for (const entry of evictedEntries) {
    if (lifecycle.rules[entry.ruleId]) continue;
    lifecycle.rules[entry.ruleId] = {
      state: "evicted",
      transitionedAt: entry.evictedAt,
      reason: entry.reason,
      addedBy: "eviction-daemon",
    };
  }

  for (const ruleId of GRADUATED_RULES) {
    if (lifecycle.rules[ruleId]) continue;
    lifecycle.rules[ruleId] = {
      state: "graduated",
      transitionedAt: new Date().toISOString(),
      reason: "Graduated to CLAUDE.md Critical Rules in #234",
      addedBy: "graduation-migration",
    };
  }

  saveLifecycle(lifecycle, baseDir);
}
