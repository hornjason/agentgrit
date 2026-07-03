/**
 * skills.ts - Skill invocation and sequence tracking
 *
 * Consolidates:
 * - SkillInvocation.hook.ts: Individual skill invocation capture with outcome
 *   classification (hit/miss/unknown)
 * - SkillSequenceLogger.hook.ts: Session-level skill sequence tracking —
 *   ordered list of skills per session, co-occurrence pattern detection,
 *   rating-weighted analysis
 */

import { randomUUID } from "crypto";
import { appendSignal } from "../adapters/jsonl";
import { signalPath } from "../adapters/paths";
import type { SkillInvocationSignal } from "../adapters/types";
import { SCHEMA_VERSION } from "../adapters/types";

const SKILL_INVOCATIONS_FILE = "skill-invocations.jsonl";
const SKILL_SEQUENCES_FILE = "skill-sequences.jsonl";

// ── Types ──

export type SkillOutcome = "hit" | "miss" | "unknown";

export interface SkillSequenceEntry {
  session_id: string;
  timestamp: string;
  skill_name: string;
  args: string;
  outcome: SkillOutcome;
  rating: number | null;
}

export interface SkillSequenceResult {
  sessionId: string;
  skills: string[];
  pairs: [string, string][];
  rating: number | null;
}

// ── Outcome classification ──

export function classifyOutcome(
  skill: string,
  trigger: string,
): SkillOutcome {
  if (!skill || !trigger) return "unknown";

  const normalizedTrigger = trigger.toLowerCase();
  const normalizedSkill = skill.toLowerCase();

  if (normalizedTrigger.includes(`/${normalizedSkill}`)) return "hit";
  if (normalizedTrigger.includes(normalizedSkill)) return "hit";

  return "unknown";
}

// ── Workflow extraction from args ──

export function extractWorkflow(args: string | undefined): string | null {
  if (!args || typeof args !== "string") return null;

  const workflowMatch =
    args.match(/workflow[:\s]+([A-Za-z0-9_-]+)/i) ||
    args.match(/^([A-Za-z0-9_-]+)\s/);

  if (workflowMatch) return workflowMatch[1];

  // Short args are likely workflow names
  if (args.trim().length > 0 && args.trim().length < 40) {
    return args.trim();
  }

  return null;
}

// ── Capture single skill invocation ──

export async function captureSkillInvocation(
  skill: string,
  trigger: string,
  sessionId: string,
  workflow?: string,
): Promise<SkillInvocationSignal> {
  const signal: SkillInvocationSignal = {
    id: randomUUID(),
    type: "skill-invocation",
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    schemaVersion: SCHEMA_VERSION,
    skill,
    workflow: workflow ?? extractWorkflow(trigger) ?? undefined,
  };

  await appendSignal(signalPath(SKILL_INVOCATIONS_FILE), signal);
  return signal;
}

// ── Skill sequence capture (from SkillSequenceLogger) ──

export async function captureSkillSequence(
  calls: { skill: string; args?: string }[],
  sessionId: string,
  rating: number | null,
): Promise<SkillSequenceEntry[]> {
  const entries: SkillSequenceEntry[] = [];

  for (const call of calls) {
    const entry: SkillSequenceEntry = {
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      skill_name: call.skill,
      args: call.args ?? "",
      outcome: "unknown",
      rating,
    };

    entries.push(entry);
    await appendSignal(
      signalPath(SKILL_SEQUENCES_FILE),
      entry as unknown as SkillInvocationSignal,
    );
  }

  return entries;
}

// ── Build co-occurrence pairs from a skill sequence ──

export function buildCoOccurrencePairs(
  skills: string[],
): [string, string][] {
  const unique = [...new Set(skills)];
  const pairs: [string, string][] = [];

  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      const a = unique[i];
      const b = unique[j];
      // Sort pair alphabetically for canonical form
      pairs.push(a < b ? [a, b] : [b, a]);
    }
  }

  return pairs;
}

// ── Analyze a full session's skill usage ──

export function analyzeSkillSequence(
  calls: { skill: string; args?: string }[],
  sessionId: string,
  rating: number | null,
): SkillSequenceResult {
  const skills = calls.map((c) => c.skill);
  const pairs = buildCoOccurrencePairs(skills);

  return {
    sessionId,
    skills,
    pairs,
    rating,
  };
}
