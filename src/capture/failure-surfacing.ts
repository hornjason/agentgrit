/**
 * failure-surfacing.ts — Surface historical failure patterns for harness steps
 *
 * Ported from PAI hooks/HarnessFailureSurfacing.hook.ts.
 * When a skill (ship, goal, Research) is invoked, extracts top 3 failure
 * patterns per mapped harness step from patterns.json. This is how the
 * learning loop feeds back into execution.
 */

import { existsSync, readFileSync } from "fs";

// ── Types ──

export interface PatternEntry {
  description: string;
  count: number;
  last_seen: string;
}

export interface StepPatterns {
  patterns: PatternEntry[];
}

export interface PatternsFile {
  step_patterns?: Record<string, StepPatterns>;
}

export interface FailureSurfacingResult {
  sections: StepSection[];
  text: string;
}

export interface StepSection {
  step: string;
  totalFailures: number;
  top: PatternEntry[];
}

// ── Skill → harness step mapping ──

const SKILL_STEP_MAP: Record<string, string[]> = {
  ship: ["SCOPE", "EXECUTION", "VERIFICATION"],
  goal: ["GOAL"],
  Research: ["RESEARCH"],
  "research-and-api-investigation": ["RESEARCH"],
};

export function getStepsForSkill(skillName: string): string[] {
  return SKILL_STEP_MAP[skillName] ?? [];
}

// ── Load patterns file ──

export function loadPatterns(patternsPath: string): PatternsFile | null {
  if (!existsSync(patternsPath)) return null;

  try {
    return JSON.parse(readFileSync(patternsPath, "utf-8")) as PatternsFile;
  } catch {
    return null;
  }
}

// ── Extract failure patterns for a skill ──

export function getFailurePatterns(
  skillName: string,
  patternsPath: string,
): FailureSurfacingResult {
  const empty: FailureSurfacingResult = { sections: [], text: "" };

  const steps = getStepsForSkill(skillName);
  if (steps.length === 0) return empty;

  const patterns = loadPatterns(patternsPath);
  if (!patterns?.step_patterns) return empty;

  const sections: StepSection[] = [];

  for (const step of steps) {
    const stepData = patterns.step_patterns[step];
    if (!stepData?.patterns || stepData.patterns.length === 0) continue;

    const sorted = [...stepData.patterns].sort((a, b) => b.count - a.count);
    const top3 = sorted.slice(0, 3);
    const totalFailures = sorted.reduce((sum, p) => sum + p.count, 0);

    sections.push({ step, totalFailures, top: top3 });
  }

  if (sections.length === 0) return empty;

  const textSections = sections.map((s) => {
    const lines = s.top.map(
      (p, i) => `  #${i + 1}: ${p.description} -- ${p.count}x`,
    );
    return `${s.step} (${s.totalFailures} prior failures):\n${lines.join("\n")}`;
  });

  const text = [
    "HARNESS FAILURE PATTERNS:",
    "",
    ...textSections,
    "",
    "Check each pattern before reporting done.",
  ].join("\n");

  return { sections, text };
}

// ── Format as system-reminder (for hook/CLI injection) ──

export function formatAsReminder(result: FailureSurfacingResult): string {
  if (result.sections.length === 0) return "";
  return `<system-reminder>\n${result.text}\n</system-reminder>`;
}
