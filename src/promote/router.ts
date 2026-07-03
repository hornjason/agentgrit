import { Tier, type Pattern } from "../adapters/types";

const BEHAVIORAL_KEYWORDS = [
  "verify", "read", "check", "confirm", "validate", "test",
  "before", "always", "never", "must", "surgical", "evidence",
  "ask", "first", "ensure", "review", "inspect",
];

const PROCEDURAL_KEYWORDS = [
  "run", "spawn", "invoke", "execute", "after", "when",
  "trigger", "fire", "launch", "call", "deploy", "rebuild",
  "use", "apply", "switch", "route", "queue",
];

export interface RouteResult {
  tier: Tier;
  rationale: string;
}

function classifyBehavioral(text: string): number {
  const lower = text.toLowerCase();
  return BEHAVIORAL_KEYWORDS.filter((kw) => lower.includes(kw)).length;
}

function classifyProcedural(text: string): number {
  const lower = text.toLowerCase();
  return PROCEDURAL_KEYWORDS.filter((kw) => lower.includes(kw)).length;
}

export function routeRule(
  pattern: Pattern,
  projectHistory: string[],
): RouteResult {
  const uniqueProjects = [...new Set(projectHistory)];

  if (uniqueProjects.length <= 1) {
    return {
      tier: Tier.Project,
      rationale: `Pattern observed in ${uniqueProjects.length === 0 ? "no" : "single"} project: ${uniqueProjects[0] ?? "unknown"}`,
    };
  }

  const ruleText = pattern.candidateRule ?? "";
  const behavioralScore = classifyBehavioral(ruleText);
  const proceduralScore = classifyProcedural(ruleText);

  if (behavioralScore > proceduralScore) {
    return {
      tier: Tier.Global,
      rationale: `Multi-project (${uniqueProjects.length}) behavioral pattern: ${behavioralScore} behavioral vs ${proceduralScore} procedural keywords`,
    };
  }

  return {
    tier: Tier.Graph,
    rationale: `Multi-project (${uniqueProjects.length}) procedural pattern: ${proceduralScore} procedural vs ${behavioralScore} behavioral keywords`,
  };
}
