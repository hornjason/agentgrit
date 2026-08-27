import {
  Tier,
  type Pattern,
  type RoutedLearning,
  type LearningRouteResult,
  type TrustTier,
  type LearningAction,
} from "../adapters/types";
import { appendFileSync } from "fs";
import { join } from "path";

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

// ── Learning Router ──

export interface LearningRouteOpts {
  shadowMode?: boolean;
}

function routeByType(signal: RoutedLearning): LearningRouteResult {
  switch (signal.type) {
    case "mechanical-fix": {
      const destination = signal.artifactType ?? "template";
      const trustTier: TrustTier =
        signal.artifactType === "gate" ? "high" : "low";
      const action: LearningAction =
        trustTier === "high" ? "queue-for-promotion" : "direct-write";
      return {
        destination,
        trustTier,
        action,
        rationale: `mechanical-fix (confidence=${signal.confidence}) → ${destination}`,
      };
    }
    case "process-rule":
      return {
        destination: "claude-md",
        trustTier: "high",
        action: "queue-for-promotion",
        rationale: `process-rule (confidence=${signal.confidence}) → claude-md`,
      };
    case "domain-knowledge":
      return {
        destination: "feedback-memory",
        trustTier: "low",
        action: "direct-write",
        rationale: `domain-knowledge (confidence=${signal.confidence}) → feedback-memory`,
      };
    case "judgment":
      return {
        destination: "questionnaire",
        trustTier: "low",
        action: "direct-write",
        rationale: `judgment (confidence=${signal.confidence}) → questionnaire`,
      };
  }
}

export function routeLearning(
  signal: RoutedLearning,
  opts?: LearningRouteOpts,
): LearningRouteResult {
  // Confidence gate — below threshold goes to incidents staging
  if (signal.confidence < 0.7) {
    const result: LearningRouteResult = {
      destination: "incidents",
      trustTier: "low",
      action: opts?.shadowMode ? "shadow-log" : "incident-log",
      rationale: `Low confidence (${signal.confidence} < 0.7) → incidents staging`,
    };
    if (opts?.shadowMode) {
      logShadow(signal, result);
    }
    return result;
  }

  const result = routeByType(signal);

  // Shadow mode: log and override action
  if (opts?.shadowMode) {
    logShadow(signal, result);
    return { ...result, action: "shadow-log" };
  }

  return result;
}

function logShadow(
  signal: RoutedLearning,
  result: LearningRouteResult,
): void {
  try {
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      signal: { type: signal.type, confidence: signal.confidence, learnStepId: signal.learnStepId },
      result,
    });
    appendFileSync(
      join(process.cwd(), "shadow-routing.jsonl"),
      entry + "\n",
    );
  } catch {
    // Shadow logging is best-effort — never blocks routing
  }
}
