import { join } from "path";
import { readSignals } from "../adapters/jsonl";
import type { CorrectionSignal, Pattern } from "../adapters/types";

// ── Constants ──────────────────────────────────────────────────────────────

const CORRECTIONS_FILE = "corrections.jsonl";
const DEFAULT_THRESHOLD = 5;
const INCIDENT_THRESHOLD = 2;
const INCIDENT_RETENTION_DAYS = 14;

// ── Types ──────────────────────────────────────────────────────────────────

/** Structured failure entry with harness step, category, and agent attribution. */
export interface FailureEntry {
  timestamp: string;
  description: string;
  agent_id: string;
  harness_step: string;
  failure_category: string;
  summary: string;
}

/** Cluster of failure entries grouped by composite key (step|category|agent). */
export interface FailureCluster {
  key: string;
  harness_step: string;
  failure_category: string;
  agent_id: string;
  entries: FailureEntry[];
  count: number;
}

/** Three-tier routing for failure classification. */
export type FailureRouting = "process" | "knowledge" | "structural";

/** Proposed skill-text patch for a recurring failure pattern. */
export interface PatchProposal {
  cluster_key: string;
  target_skill: string;
  harness_step: string;
  failure_category: string;
  occurrence_count: number;
  failure_descriptions: string[];
  proposed_action: string;
  generated_at: string;
}

/** Incident record from error monitoring. */
export interface IncidentRecord {
  timestamp: string;
  session_id: string;
  error_snippet: string;
  error_type: string;
  command_preview: string;
}

// ── Internal: correction grouping ──────────────────────────────────────────

interface CorrectionGroup {
  representative: string;
  tokens: Set<string>;
  signals: CorrectionSignal[];
  sessions: Set<string>;
  maxSeverity: number;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const word of a) {
    if (b.has(word)) overlap++;
  }
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : overlap / union;
}

function groupByKeywordSimilarity(
  corrections: CorrectionSignal[],
  similarityThreshold = 0.3,
): CorrectionGroup[] {
  const groups: CorrectionGroup[] = [];

  for (const signal of corrections) {
    const text = `${signal.correction_phrase} ${signal.context}`;
    const tokens = tokenize(text);

    let matched = false;
    for (const group of groups) {
      if (similarity(tokens, group.tokens) >= similarityThreshold) {
        group.signals.push(signal);
        group.sessions.add(signal.session_id);
        for (const t of tokens) group.tokens.add(t);
        matched = true;
        break;
      }
    }

    if (!matched) {
      groups.push({
        representative: signal.correction_phrase.slice(0, 200),
        tokens,
        signals: [signal],
        sessions: new Set([signal.session_id]),
        maxSeverity: 5,
      });
    }
  }

  return groups;
}

function buildCandidateRule(group: CorrectionGroup): string {
  const triggers = group.signals
    .slice(0, 3)
    .map((s) => s.correction_phrase.slice(0, 80))
    .join("; ");
  return `Recurring correction (${group.signals.length}x): ${triggers}`;
}

// ── Harness step to skill mapping ──────────────────────────────────────────

const STEP_TO_SKILL: Record<string, string> = {
  GOAL: "goal",
  DISCOVERY: "ship",
  RESEARCH: "Research",
  PLANNING: "ship",
  EXECUTION: "ship",
  VERIFICATION: "ship",
  ITERATION: "ship",
  FEEDBACK: "ship",
};

export function stepToSkill(step: string): string {
  return STEP_TO_SKILL[step] ?? "ship";
}

// ── Three-tier failure routing ─────────────────────────────────────────────

const KNOWLEDGE_CATEGORIES = new Set([
  "knowledge", "factual-error", "api-misuse", "wrong-assumption",
]);

const STRUCTURAL_CATEGORIES = new Set([
  "structural", "architecture", "data-flow", "integration",
]);

export function classifyFailureType(category: string): FailureRouting {
  const lower = category.toLowerCase();
  if (KNOWLEDGE_CATEGORIES.has(lower)) return "knowledge";
  if (STRUCTURAL_CATEGORIES.has(lower)) return "structural";
  return "process";
}

// ── Severity scoring ───────────────────────────────────────────────────────

export function scoreSeverity(cluster: FailureCluster): number {
  let severity = Math.min(cluster.count + 2, 8);
  const dateSet = new Set(cluster.entries.map((e) => e.timestamp.slice(0, 10)));
  if (dateSet.size >= 3) severity++;
  if (classifyFailureType(cluster.failure_category) === "structural") severity++;
  return Math.min(severity, 10);
}

// ── Structured failure clustering ──────────────────────────────────────────

export function clusterFailureEntries(entries: FailureEntry[]): FailureCluster[] {
  const clusters = new Map<string, FailureCluster>();

  for (const entry of entries) {
    const key = `${entry.harness_step}|${entry.failure_category}|${entry.agent_id}`;
    if (!clusters.has(key)) {
      clusters.set(key, {
        key,
        harness_step: entry.harness_step,
        failure_category: entry.failure_category,
        agent_id: entry.agent_id,
        entries: [],
        count: 0,
      });
    }
    const cluster = clusters.get(key)!;
    cluster.entries.push(entry);
    cluster.count++;
  }

  return [...clusters.values()].sort((a, b) => b.count - a.count);
}

export function generatePatchProposals(
  clusters: FailureCluster[],
  threshold: number = 2,
): PatchProposal[] {
  const patches: PatchProposal[] = [];

  for (const cluster of clusters) {
    if (cluster.count < threshold) continue;
    if (cluster.failure_category === "unknown" && cluster.harness_step === "unknown") continue;

    const routing = classifyFailureType(cluster.failure_category);
    if (routing === "knowledge") continue;

    const targetSkill = stepToSkill(cluster.harness_step);
    const descriptions = cluster.entries.map((e) => e.description);
    const action = routing === "process"
      ? `Add mechanical check to ${targetSkill} at ${cluster.harness_step} step to prevent: ${descriptions[0]}`
      : `Add structural guard to harness ${cluster.harness_step} section AND ${targetSkill}`;

    patches.push({
      cluster_key: cluster.key,
      target_skill: targetSkill,
      harness_step: cluster.harness_step,
      failure_category: cluster.failure_category,
      occurrence_count: cluster.count,
      failure_descriptions: descriptions,
      proposed_action: action,
      generated_at: new Date().toISOString(),
    });
  }

  return patches;
}

// ── Incident-based pattern detection ───────────────────────────────────────

export function pruneOldIncidents(
  incidents: IncidentRecord[],
  retentionDays: number = INCIDENT_RETENTION_DAYS,
): IncidentRecord[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  return incidents.filter((r) => {
    try { return new Date(r.timestamp) >= cutoff; }
    catch { return true; }
  });
}

export function detectIncidentPatterns(
  incidents: IncidentRecord[],
  sessionId?: string,
  threshold: number = INCIDENT_THRESHOLD,
): Pattern[] {
  const filtered = sessionId
    ? incidents.filter((r) => r.session_id === sessionId)
    : incidents;

  if (filtered.length < threshold) return [];

  const typeCounts = new Map<string, IncidentRecord[]>();
  for (const incident of filtered) {
    if (!typeCounts.has(incident.error_type)) typeCounts.set(incident.error_type, []);
    typeCounts.get(incident.error_type)!.push(incident);
  }

  const patterns: Pattern[] = [];
  for (const [errorType, records] of typeCounts) {
    if (records.length < threshold) continue;
    const sessions = [...new Set(records.map((r) => r.session_id))];
    const timestamps = records.map((r) => r.timestamp).sort();
    patterns.push({
      id: `incident-${errorType}-${sessions[0]?.slice(0, 8) ?? "unknown"}`,
      type: "incident-pattern",
      frequency: records.length,
      sessions,
      severity: Math.min(records.length + 3, 10),
      candidateRule: `"${errorType}" errors appeared ${records.length}x${sessionId ? ` in session ${sessionId.slice(0, 8)}` : ""}. Investigate root cause before retrying.`,
      firstSeen: timestamps[0],
      lastSeen: timestamps[timestamps.length - 1],
    });
  }

  return patterns.sort((a, b) => b.frequency - a.frequency);
}

// ── Primary: correction-based failure pattern detection ────────────────────

export async function detectFailurePatterns(
  signalDir: string,
  threshold: number = DEFAULT_THRESHOLD,
): Promise<Pattern[]> {
  const corrections = (await readSignals(
    join(signalDir, CORRECTIONS_FILE),
  )) as CorrectionSignal[];

  if (corrections.length === 0) return [];

  const groups = groupByKeywordSimilarity(corrections);
  const patterns: Pattern[] = [];

  for (const group of groups) {
    if (group.signals.length < threshold) continue;
    const sessions = [...group.sessions];
    const timestamps = group.signals.map((s) => s.timestamp).sort();
    patterns.push({
      id: `fail-${sessions[0].slice(0, 8)}-${patterns.length}`,
      type: "failure",
      frequency: group.signals.length,
      sessions,
      severity: group.maxSeverity,
      candidateRule: buildCandidateRule(group),
      firstSeen: timestamps[0],
      lastSeen: timestamps[timestamps.length - 1],
    });
  }

  return patterns.sort((a, b) => b.frequency - a.frequency);
}
