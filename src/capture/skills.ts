import { randomUUID } from "crypto";
import { appendSignal } from "../adapters/jsonl";
import { signalPath } from "../adapters/paths";
import type { SkillInvocationSignal } from "../adapters/types";
import { SCHEMA_VERSION } from "../adapters/types";

const SKILL_INVOCATIONS_FILE = "skill-invocations.jsonl";

export type SkillOutcome = "hit" | "miss" | "unknown";

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
    workflow,
  };

  await appendSignal(signalPath(SKILL_INVOCATIONS_FILE), signal);
  return signal;
}
