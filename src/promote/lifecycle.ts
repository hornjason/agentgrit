import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { join } from "path";
import { stateDir } from "../adapters/paths";
import { loadEvictedRegistryEntries } from "./auto-eviction";
import { loadRuleStats } from "./rules";
import { normalizeRuleId } from "./bridge";

export type RuleLifecycleState = "active" | "graduated" | "evicted" | "undersampled";

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
    const validStates = new Set<string>(["active", "graduated", "evicted", "undersampled"]);
    const rules: Record<string, RuleLifecycleEntry> = {};
    for (const [ruleId, entry] of Object.entries(data.rules ?? {})) {
      const e = entry as RuleLifecycleEntry;
      if (validStates.has(e.state)) {
        rules[ruleId] = e;
      } else {
        console.error(`[lifecycle] Invalid state "${e.state}" for rule ${ruleId} — skipping`);
      }
    }
    return { version: 1, rules };
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

export interface TransitionLogEntry {
  ruleId: string;
  fromState: RuleLifecycleState;
  toState: RuleLifecycleState;
  timestamp: string;
  reason: string;
  addedBy: string;
}

export function appendTransitionLog(entry: TransitionLogEntry, dir?: string): void {
  const baseDir = dir ?? stateDir();
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
  const logPath = join(baseDir, "transition-log.jsonl");
  appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
}

export function transitionRule(
  ruleId: string,
  state: RuleLifecycleState,
  reason: string,
  addedBy: string,
  dir?: string,
): void {
  const lifecycle = loadLifecycle(dir);
  const prevState: RuleLifecycleState = lifecycle.rules[ruleId]?.state ?? "active";
  const timestamp = new Date().toISOString();
  lifecycle.rules[ruleId] = {
    state,
    transitionedAt: timestamp,
    reason,
    addedBy,
  };
  appendTransitionLog({ ruleId, fromState: prevState, toState: state, timestamp, reason, addedBy }, dir);
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

const CRITICAL_SECTION_RE = /^### Critical Rules\b/;
const CRITICAL_RULE_LINE_RE = /^- \*\*(.+?)(?:\s*\(from\s.*?\))?:\*\*\s*/;

export function detectGraduatedRules(dir?: string): string[] {
  const claudeMdPath = join(process.env.HOME ?? "", ".claude", "CLAUDE.md");
  if (!existsSync(claudeMdPath)) return [];

  const content = readFileSync(claudeMdPath, "utf-8");
  const lines = content.split("\n");

  let inSection = false;
  const criticalNames: string[] = [];
  for (const line of lines) {
    if (CRITICAL_SECTION_RE.test(line)) { inSection = true; continue; }
    if (inSection && (line.startsWith("## ") || line.startsWith("### ") || line.startsWith("---"))) break;
    if (inSection) {
      const match = line.match(CRITICAL_RULE_LINE_RE);
      if (match) criticalNames.push(match[1].trim());
    }
  }

  if (criticalNames.length === 0) return [];

  const statsMap = loadRuleStats(dir);
  const baseDir = dir ?? stateDir();
  const lifecycle = loadLifecycle(baseDir);
  const matched: string[] = [];

  for (const critName of criticalNames) {
    const normCrit = normalizeRuleId(critName);
    for (const [statId] of statsMap) {
      if (lifecycle.rules[statId]) continue;
      const normStat = normalizeRuleId(statId);
      if (normStat === normCrit || normStat.includes(normCrit) || normCrit.includes(normStat)) {
        transitionRule(statId, "graduated", `Graduated to CLAUDE.md Critical Rules (matched: ${critName})`, "graduation-auto-detect", baseDir);
        matched.push(statId);
        break;
      }
    }
  }

  return matched;
}

export function classifyUndersampledRules(dir?: string): string[] {
  const baseDir = dir ?? stateDir();
  const statsMap = loadRuleStats(baseDir);
  const lifecycle = loadLifecycle(baseDir);
  const classified: string[] = [];

  for (const [ruleId, stats] of statsMap) {
    if (stats.injectionCount >= 10) continue;
    const existing = lifecycle.rules[ruleId];
    if (existing && (existing.state === "graduated" || existing.state === "evicted")) continue;
    if (existing?.state === "undersampled") continue;
    transitionRule(ruleId, "undersampled", `${stats.injectionCount} injections < 10 threshold`, "undersampled-classifier", baseDir);
    classified.push(ruleId);
  }

  return classified;
}

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

  saveLifecycle(lifecycle, baseDir);
  detectGraduatedRules(baseDir);
  classifyUndersampledRules(baseDir);
}
