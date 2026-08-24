import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { statePath, stateDir } from "../adapters/paths";

export type OutcomeType =
  | "commit-merged"
  | "tests-pass"
  | "issue-closed"
  | "pr-merged"
  | "no-regressions"
  | "correction"
  | "reprompt"
  | "healthy-iteration";

export interface OutcomeEvent {
  type: OutcomeType;
  sessionId: string;
  timestamp: string;
  turn: number;
  metadata?: Record<string, unknown>;
}

const OUTCOME_WEIGHTS: Record<OutcomeType, number> = {
  "commit-merged": 1.0,
  "tests-pass": 0.8,
  "issue-closed": 1.0,
  "pr-merged": 0.8,
  "no-regressions": 0.5,
  "correction": -0.3,
  "reprompt": -0.5,
  "healthy-iteration": 0.0,
};

const OUTCOMES_FILE = "outcome-events.jsonl";

export function computeOutcomeScore(events: OutcomeEvent[]): number {
  const base = 5.0;
  let total = base;
  for (const event of events) {
    total += OUTCOME_WEIGHTS[event.type] ?? 0;
  }
  return Math.round(Math.max(1, Math.min(10, total)) * 10) / 10;
}

export async function captureOutcome(event: OutcomeEvent): Promise<void> {
  const filePath = statePath(OUTCOMES_FILE);
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const line = JSON.stringify(event) + "\n";
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
  writeFileSync(filePath, existing + line);
}

export function readOutcomes(sessionId?: string): OutcomeEvent[] {
  const filePath = statePath(OUTCOMES_FILE);
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, "utf-8");
  const events: OutcomeEvent[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as OutcomeEvent;
      if (!sessionId || event.sessionId === sessionId) {
        events.push(event);
      }
    } catch { /* skip malformed */ }
  }
  return events;
}

export function detectMiniBoundary(
  currentPrompt: string,
  previousPrompt?: string,
): boolean {
  const lower = currentPrompt.toLowerCase();
  if (lower.includes("/clear") || lower.includes("/compact")) return true;

  if (!previousPrompt) return false;

  const wordsA = new Set(currentPrompt.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(previousPrompt.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return false;

  const union = new Set([...wordsA, ...wordsB]);
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  const jaccard = intersection / union.size;
  return jaccard < 0.2;
}
