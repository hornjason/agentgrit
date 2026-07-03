import type { Pattern } from "../adapters/types";

export interface ThemeCohort {
  id: number;
  name: string;
  description: string;
  ablatable: boolean;
  patterns: Pattern[];
  avgSeverity: number;
  totalFrequency: number;
}

export interface AntiRationalization {
  shortcut: string;
  rebuttal: string;
  evidence: string;
  frequency: number;
}

interface CohortDefinition {
  name: string;
  description: string;
  ablatable: boolean;
  keywords: string[];
}

const COHORT_DEFINITIONS: CohortDefinition[] = [
  {
    name: "verification",
    description: "Failures related to asserting without verifying",
    ablatable: false,
    keywords: ["verify", "assert", "claim", "check", "confirm", "evidence"],
  },
  {
    name: "delegation",
    description: "Agent delegation and coordination failures",
    ablatable: true,
    keywords: ["delegate", "agent", "team", "escalate", "routing", "spawn"],
  },
  {
    name: "scope",
    description: "Scope misreads and incomplete delivery",
    ablatable: true,
    keywords: [
      "scope", "incomplete", "wrong", "misread", "missing", "partial",
      "delivery", "complete",
    ],
  },
  {
    name: "process",
    description: "Development process and workflow failures",
    ablatable: true,
    keywords: [
      "test", "deploy", "build", "pipeline", "loop", "workflow", "process",
      "gate",
    ],
  },
  {
    name: "communication",
    description: "Communication and context failures",
    ablatable: true,
    keywords: [
      "communicate", "context", "unclear", "misunderstand", "ask", "clarify",
    ],
  },
];

const ANTI_RAT_TEMPLATES: Record<
  string,
  { shortcut: string; rebuttal: string; evidence: string }
> = {
  verification: {
    shortcut: '"I\'ve verified this"',
    rebuttal: "Name every source checked. If fewer than 2 independent sources, it's incomplete",
    evidence: "List of sources checked with what each confirmed",
  },
  scope: {
    shortcut: '"It\'s done / complete"',
    rebuttal: "Re-read the original request. Check every named item was addressed",
    evidence: "Checklist of requirements with file:line evidence for each",
  },
  delegation: {
    shortcut: '"The agent handled it"',
    rebuttal: "Read the agent's actual output. Grep for hedged claims",
    evidence: "Agent output with zero hedged claims (probably, should, might)",
  },
  process: {
    shortcut: '"Tests pass"',
    rebuttal: "Tests verify code correctness, not feature correctness. Check the actual UI/output",
    evidence: "Screenshot or live verification of the user-facing behavior",
  },
  communication: {
    shortcut: '"The user meant X"',
    rebuttal: "Re-read the exact request. Present interpretations before picking one",
    evidence: "Quote from user message matching your interpretation",
  },
};

function matchCohort(pattern: Pattern): number {
  const text = `${pattern.type} ${pattern.candidateRule ?? ""}`.toLowerCase();

  let bestIdx = -1;
  let bestScore = 0;

  for (let i = 0; i < COHORT_DEFINITIONS.length; i++) {
    const def = COHORT_DEFINITIONS[i];
    let score = 0;
    for (const kw of def.keywords) {
      if (text.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return bestIdx >= 0 ? bestIdx : 0;
}

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
    const avgSeverity =
      members.length > 0
        ? members.reduce((sum, p) => sum + p.severity, 0) / members.length
        : 0;

    cohorts.push({
      id: idx,
      name: def.name,
      description: def.description,
      ablatable: def.ablatable,
      patterns: members,
      avgSeverity: Math.round(avgSeverity * 100) / 100,
      totalFrequency,
    });
  }

  return cohorts.sort((a, b) => b.totalFrequency - a.totalFrequency);
}

export function generateAntiRationalizations(
  cohorts: ThemeCohort[],
): AntiRationalization[] {
  const results: AntiRationalization[] = [];

  for (const cohort of cohorts) {
    const template = ANTI_RAT_TEMPLATES[cohort.name];
    if (!template) continue;
    if (cohort.patterns.length === 0) continue;

    results.push({
      ...template,
      frequency: cohort.totalFrequency,
    });
  }

  return results.sort((a, b) => b.frequency - a.frequency);
}
