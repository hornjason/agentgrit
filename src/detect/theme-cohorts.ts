import type { Pattern } from "../adapters/types";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ThemeCohort {
  id: number; name: string; description: string; ablatable: boolean;
  patterns: Pattern[]; avgSeverity: number; totalFrequency: number;
}

export interface AntiRationalization {
  shortcut: string; rebuttal: string; evidence: string; frequency: number;
}

export interface CohortDefinition {
  name: string; description: string; ablatable: boolean; keywords: string[];
}

export interface CohortHealth {
  id: number; name: string; ablatable: boolean; node_count: number;
  nodes: string[]; avg_rating: number; high_pct: number; low_pct: number; sample_size: number;
}

export interface NodeCohortDefinition {
  id: number; name: string; ablatable: boolean; patterns: string[];
}

// ── Cohort definitions (6 themes) ──────────────────────────────────────────

export const COHORT_DEFINITIONS: CohortDefinition[] = [
  { name: "verification", description: "Failures related to asserting without verifying", ablatable: false,
    keywords: ["verify", "assert", "claim", "check", "confirm", "evidence"] },
  { name: "delegation", description: "Agent delegation and coordination failures", ablatable: true,
    keywords: ["delegate", "agent", "team", "escalate", "routing", "spawn"] },
  { name: "scope", description: "Scope misreads and incomplete delivery", ablatable: true,
    keywords: ["scope", "incomplete", "wrong", "misread", "missing", "partial", "delivery", "complete"] },
  { name: "process", description: "Development process and workflow failures", ablatable: true,
    keywords: ["test", "deploy", "build", "pipeline", "loop", "workflow", "process", "gate"] },
  { name: "communication", description: "Communication and context failures", ablatable: true,
    keywords: ["communicate", "context", "unclear", "misunderstand", "ask", "clarify"] },
  { name: "domain-specific", description: "Product-specific and domain-specific rule failures", ablatable: true,
    keywords: ["auth", "scraper", "security", "config", "environment", "api", "database", "schema", "integration"] },
];

// ── Anti-rationalization templates ─────────────────────────────────────────

const ANTI_RAT_TEMPLATES: Record<string, { shortcut: string; rebuttal: string; evidence: string }> = {
  verification: { shortcut: '"I\'ve verified this"',
    rebuttal: "Name every source checked. If fewer than 2 independent sources, it's incomplete",
    evidence: "List of sources checked with what each confirmed" },
  scope: { shortcut: '"It\'s done / complete"',
    rebuttal: "Re-read the original request. Check every named item was addressed",
    evidence: "Checklist of requirements with file:line evidence for each" },
  delegation: { shortcut: '"The agent handled it"',
    rebuttal: "Read the agent's actual output. Grep for hedged claims",
    evidence: "Agent output with zero hedged claims (probably, should, might)" },
  process: { shortcut: '"Tests pass"',
    rebuttal: "Tests verify code correctness, not feature correctness. Check the actual UI/output",
    evidence: "Screenshot or live verification of the user-facing behavior" },
  communication: { shortcut: '"The user meant X"',
    rebuttal: "Re-read the exact request. Present interpretations before picking one",
    evidence: "Quote from user message matching your interpretation" },
};

// ── Extended templates from failure analysis (AntiRationalizationGen) ──────

export const EXTENDED_ANTI_RAT_TEMPLATES: Record<string, { shortcut: string; rebuttal: string; evidence: string }> = {
  working_live: { shortcut: '"It\'s working/live"',
    rebuttal: "Open the URL, navigate to the specific page, confirm the actual state",
    evidence: "Screenshot or curl response showing the feature rendering data" },
  logic_does_x: { shortcut: '"The logic does X"',
    rebuttal: "Read the source file and cite the exact line",
    evidence: "`file:line` reference to the actual implementation" },
  verified_this: { shortcut: '"I\'ve verified this"',
    rebuttal: "Name every source checked — if fewer than 2 independent sources, it's incomplete",
    evidence: "List of sources checked with what each confirmed" },
  issue_is_x: { shortcut: '"The issue is X"',
    rebuttal: "What evidence rules out alternatives? State the evidence chain",
    evidence: "grep/log/screenshot ruling out other root causes" },
  data_shows_x: { shortcut: '"The data shows X"',
    rebuttal: "Read all entries, not just the first match — count total vs examined",
    evidence: "Count of items examined vs total available" },
  doesnt_exist: { shortcut: '"X doesn\'t exist"',
    rebuttal: "Search with at least 2 methods before claiming non-existence",
    evidence: "grep output + API/UI check showing absence" },
  its_deployed: { shortcut: '"It\'s deployed/fixed"',
    rebuttal: "Open the deployed URL, test the specific fix, confirm the behavior changed",
    evidence: "Screenshot or curl of the deployed state showing the fix working" },
};

// ── Regex-based failure classifiers ────────────────────────────────────────

export const PATTERN_MATCHERS: Record<string, RegExp[]> = {
  working_live: [/claimed.*live/i, /claimed.*working/i, /claimed.*deployed/i, /claimed.*cached/i,
    /dashboard.*live/i, /deployed.*broken/i, /still.*broken/i],
  logic_does_x: [/misunderstanding.*logic/i, /diagnosis.*wrong/i, /validation.*inaccurate/i,
    /waterfall/i, /misunderstood/i],
  verified_this: [/verification.*incomplete/i, /missed.*completed/i, /missed.*skills/i,
    /missed.*detail/i, /questioning.*verified/i],
  issue_is_x: [/diagnosis.*wrong/i, /incorrect.*requirement/i, /false.*vpn/i, /wrong.*app.*state/i],
  data_shows_x: [/analysis.*incomplete/i, /missed.*data/i, /incomplete.*analysis/i, /zero.*cases/i],
  doesnt_exist: [/claimed.*no.*sources/i, /claimed.*doesnt.*have/i, /stated.*otherwise/i, /exists.*but.*claimed/i],
  its_deployed: [/deployed.*not.*visible/i, /fix.*deployed.*broken/i, /server.*failed.*deploy/i, /supposedly.*deployed/i],
};

// ── Pattern matching ───────────────────────────────────────────────────────

function matchCohort(pattern: Pattern): number {
  const text = `${pattern.type} ${pattern.candidateRule ?? ""}`.toLowerCase();
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < COHORT_DEFINITIONS.length; i++) {
    let score = 0;
    for (const kw of COHORT_DEFINITIONS[i].keywords) { if (text.includes(kw)) score++; }
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  return bestIdx >= 0 ? bestIdx : 0;
}

// ── Node-to-cohort assignment ──────────────────────────────────────────────

export const NODE_COHORT_DEFINITIONS: NodeCohortDefinition[] = [
  { id: 0, name: "constitutional", ablatable: false,
    patterns: ["verify_before", "verify-before", "verify-live", "verify-state", "verify-fix",
      "assert", "execution_discipline", "root_cause_data", "exhaustive-search", "validate-dom"] },
  { id: 1, name: "delegation", ablatable: true,
    patterns: ["delegate", "proactive_agents", "escalate", "pre-brief-agent", "wait-for-agent",
      "da_runs_rebuild", "explicit-multi-agent"] },
  { id: 2, name: "dev-loop", ablatable: true,
    patterns: ["dev_loop", "dev-loop", "mandatory-dev-loop", "test_before", "test-container",
      "container_only", "use_makefile", "gates_before", "worktree_merge", "worktree_isolation", "test-first"] },
  { id: 3, name: "documentation", ablatable: true,
    patterns: ["always_update_docs", "docs_always", "capture_decisions", "claude_md_gate",
      "project_state_live", "auto_log_backlog", "session_continuity", "backlog-verify"] },
  { id: 4, name: "scope-and-delivery", ablatable: true,
    patterns: ["scope_misread", "match_question", "wrong-scope", "incomplete-delivery",
      "no_false_completions", "complete-thoughts", "clarify_before", "flag_rule_conflicts"] },
  { id: 5, name: "domain-specific", ablatable: true,
    patterns: ["no_auth", "scraper", "security_review", "daily_brief", "daily-brief",
      "salesforce", "portability", "ask_environment", "customer_intelligence"] },
];

export function assignNodeToCohort(nodeId: string, definitions: NodeCohortDefinition[] = NODE_COHORT_DEFINITIONS): number {
  const lower = nodeId.toLowerCase();
  for (const cohort of definitions) {
    for (const pattern of cohort.patterns) {
      if (lower.includes(pattern.toLowerCase())) return cohort.id;
    }
  }
  return 0;
}

// ── Recency weighting ─────────────────────────────────────────────────────

export function recencyWeight(daysAgo: number): number {
  if (daysAgo <= 30) return 3;
  if (daysAgo <= 60) return 2;
  return 1;
}

// ── Regex-based failure classification ─────────────────────────────────────

export function classifyFailureByRegex(text: string): string | null {
  for (const [category, matchers] of Object.entries(PATTERN_MATCHERS)) {
    for (const regex of matchers) { if (regex.test(text)) return category; }
  }
  return null;
}

// ── Weighted anti-rationalization generation ───────────────────────────────

export function buildWeightedAntiRationalizations(
  failures: { text: string; daysAgo: number }[],
): AntiRationalization[] {
  const clusters = new Map<string, { rawCount: number; weightedScore: number }>();
  for (const failure of failures) {
    const category = classifyFailureByRegex(failure.text);
    if (!category) continue;
    const existing = clusters.get(category) ?? { rawCount: 0, weightedScore: 0 };
    existing.rawCount++;
    existing.weightedScore += recencyWeight(failure.daysAgo);
    clusters.set(category, existing);
  }
  const sorted = [...clusters.entries()].sort((a, b) => b[1].weightedScore - a[1].weightedScore).slice(0, 5);
  const results: AntiRationalization[] = [];
  for (const [category, data] of sorted) {
    const template = EXTENDED_ANTI_RAT_TEMPLATES[category];
    if (!template) continue;
    results.push({ shortcut: template.shortcut, rebuttal: template.rebuttal, evidence: template.evidence, frequency: data.weightedScore });
  }
  return results;
}

// ── Cohort health analysis ─────────────────────────────────────────────────

export function analyzeCohortHealth(
  nodeStats: Record<string, { ratings: number[] }>,
  definitions: NodeCohortDefinition[] = NODE_COHORT_DEFINITIONS,
): CohortHealth[] {
  const cohortNodes: Record<number, string[]> = {};
  for (const def of definitions) cohortNodes[def.id] = [];
  for (const nodeId of Object.keys(nodeStats)) {
    const cohortId = assignNodeToCohort(nodeId, definitions);
    if (!cohortNodes[cohortId]) cohortNodes[cohortId] = [];
    cohortNodes[cohortId].push(nodeId);
  }
  const results: CohortHealth[] = [];
  for (const def of definitions) {
    const memberNodes = cohortNodes[def.id] ?? [];
    let totalRating = 0, totalHigh = 0, totalLow = 0, sampleSize = 0;
    for (const nodeId of memberNodes) {
      const node = nodeStats[nodeId];
      if (!node) continue;
      for (const r of node.ratings) {
        totalRating += r; sampleSize++;
        if (r >= 7) totalHigh++;
        if (r <= 3) totalLow++;
      }
    }
    results.push({
      id: def.id, name: def.name, ablatable: def.ablatable, node_count: memberNodes.length, nodes: memberNodes,
      avg_rating: sampleSize > 0 ? Math.round((totalRating / sampleSize) * 100) / 100 : 0,
      high_pct: sampleSize > 0 ? Math.round((100 * totalHigh) / sampleSize) : 0,
      low_pct: sampleSize > 0 ? Math.round((100 * totalLow) / sampleSize) : 0,
      sample_size: sampleSize,
    });
  }
  return results;
}

// ── Primary: pattern-based cohort building ─────────────────────────────────

export function buildCohorts(patterns: Pattern[]): ThemeCohort[] {
  const grouped = new Map<number, Pattern[]>();
  for (const p of patterns) {
    const idx = matchCohort(p);
    if (!grouped.has(idx)) grouped.set(idx, []);
    grouped.get(idx)!.push(p);
  }
  const cohorts: ThemeCohort[] = [];
  for (const [idx, members] of grouped) {
    const def = COHORT_DEFINITIONS[idx];
    const totalFrequency = members.reduce((sum, p) => sum + p.frequency, 0);
    const avgSeverity = members.length > 0 ? members.reduce((sum, p) => sum + p.severity, 0) / members.length : 0;
    cohorts.push({ id: idx, name: def.name, description: def.description, ablatable: def.ablatable,
      patterns: members, avgSeverity: Math.round(avgSeverity * 100) / 100, totalFrequency });
  }
  return cohorts.sort((a, b) => b.totalFrequency - a.totalFrequency);
}

export function generateAntiRationalizations(cohorts: ThemeCohort[]): AntiRationalization[] {
  const results: AntiRationalization[] = [];
  for (const cohort of cohorts) {
    const template = ANTI_RAT_TEMPLATES[cohort.name];
    if (!template) continue;
    if (cohort.patterns.length === 0) continue;
    results.push({ ...template, frequency: cohort.totalFrequency });
  }
  return results.sort((a, b) => b.frequency - a.frequency);
}
