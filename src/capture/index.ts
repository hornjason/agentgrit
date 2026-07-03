export { captureRating, parseRating, scoreSentiment } from "./rating";
export type { RatingParseResult } from "./rating";

export { detectCorrection } from "./corrections";

export { captureSkillInvocation, classifyOutcome } from "./skills";
export type { SkillOutcome } from "./skills";

export { extractDebrief } from "./debrief";
export type { RuleCandidate } from "./debrief";

export { captureToolUse } from "./tool-audit";

export interface HookConfig {
  hooks: Record<string, HookEntry[]>;
}

interface HookEntry {
  matcher: string;
  command: string;
}

export function generateHookConfig(): HookConfig {
  const prefix = "npx agentgrit hook";

  return {
    hooks: {
      UserPromptSubmit: [
        {
          matcher: "",
          command: `${prefix} rating`,
        },
        {
          matcher: "",
          command: `${prefix} correction`,
        },
      ],
      PostToolUse: [
        {
          matcher: "Skill",
          command: `${prefix} skill-invocation`,
        },
        {
          matcher: ".*",
          command: `${prefix} tool-audit`,
        },
      ],
      SessionEnd: [
        {
          matcher: "",
          command: `${prefix} debrief`,
        },
      ],
    },
  };
}
