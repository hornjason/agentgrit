import { randomUUID } from "crypto";
import { appendSignal } from "../adapters/jsonl";
import { signalPath } from "../adapters/paths";
import type { SkillInvocationSignal } from "../adapters/types";
import { SCHEMA_VERSION } from "../adapters/types";

const SKILL_INVOCATIONS_FILE = "skill-invocations.jsonl";

export type SkillOutcome = "hit" | "miss" | "unknown";

export function classifyOutcome(
  skillName: string,
  trigger: string,
): SkillOutcome {
  if (!skillName || !trigger) return "unknown";

  const normalizedTrigger = trigger.toLowerCase();
  const normalizedSkill = skillName.toLowerCase();

  if (normalizedTrigger.includes(`/${normalizedSkill}`)) return "hit";
  if (normalizedTrigger.includes(normalizedSkill)) return "hit";

  return "unknown";
}

export async function captureSkillInvocation(
  skillName: string,
  trigger: string,
  sessionId: string,
): Promise<SkillInvocationSignal> {
  const outcome = classifyOutcome(skillName, trigger);

  const signal: SkillInvocationSignal = {
    id: randomUUID(),
    type: "skill-invocation",
    timestamp: new Date().toISOString(),
    sessionId,
    schemaVersion: SCHEMA_VERSION,
    skillName,
    trigger: trigger.slice(0, 500),
    success: outcome === "hit" ? true : outcome === "miss" ? false : undefined,
  };

  await appendSignal(signalPath(SKILL_INVOCATIONS_FILE), signal);
  return signal;
}
