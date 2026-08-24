import type { OutcomeType } from "../capture/outcomes";

export type TaskType = "ship" | "research" | "design" | "debug" | "config" | "unknown";

const TASK_KEYWORDS: Record<Exclude<TaskType, "unknown">, string[]> = {
  ship: ["ship", "implement", "fix", "build", "deploy", "feature", "add", "create", "refactor"],
  research: ["investigate", "research", "find", "explore", "look into", "analyze", "study"],
  design: ["design", "plan", "architect", "spec", "blueprint", "layout", "propose"],
  debug: ["debug", "diagnose", "trace", "troubleshoot", "bisect", "inspect"],
  config: ["configure", "setup", "install", "provision", "wire", "connect"],
};

export function detectTaskType(prompt: string): TaskType {
  const lower = prompt.toLowerCase();
  for (const [type, keywords] of Object.entries(TASK_KEYWORDS) as [Exclude<TaskType, "unknown">, string[]][]) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return type;
    }
  }
  return "unknown";
}

const DEFAULT_WEIGHTS: Record<OutcomeType, number> = {
  "commit-merged": 1.0,
  "tests-pass": 0.8,
  "issue-closed": 1.0,
  "pr-merged": 0.8,
  "no-regressions": 0.5,
  "correction": -0.3,
  "reprompt": -0.5,
  "healthy-iteration": 0.0,
};

const TASK_WEIGHT_OVERRIDES: Partial<Record<TaskType, Partial<Record<OutcomeType, number>>>> = {
  research: {
    "commit-merged": 0.3,
    "tests-pass": 0.3,
    "issue-closed": 0.5,
    "pr-merged": 0.3,
  },
  debug: {
    "tests-pass": 1.5,
    "correction": -0.2,
  },
  design: {
    "commit-merged": 0.3,
    "tests-pass": 0.2,
    "issue-closed": 0.8,
  },
  config: {
    "tests-pass": 0.5,
    "commit-merged": 0.6,
  },
};

export function getOutcomeWeights(taskType: TaskType): Record<OutcomeType, number> {
  const overrides = TASK_WEIGHT_OVERRIDES[taskType] ?? {};
  return { ...DEFAULT_WEIGHTS, ...overrides };
}
