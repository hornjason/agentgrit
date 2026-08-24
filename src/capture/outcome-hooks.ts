import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { stateDir } from "../adapters/paths";
import type { OutcomeEvent } from "./outcomes";

function writeOutcome(event: OutcomeEvent, dir: string): void {
  const filePath = join(dir, "outcome-events.jsonl");
  const d = dirname(filePath);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });

  const line = JSON.stringify(event) + "\n";
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
  writeFileSync(filePath, existing + line);
}

export async function captureCommitOutcome(
  sessionId: string,
  turn: number,
  dirOverride?: string,
): Promise<void> {
  writeOutcome({
    type: "commit-merged",
    sessionId,
    timestamp: new Date().toISOString(),
    turn,
  }, dirOverride ?? stateDir());
}

export async function captureCorrectionOutcome(
  sessionId: string,
  turn: number,
  dirOverride?: string,
): Promise<void> {
  writeOutcome({
    type: "correction",
    sessionId,
    timestamp: new Date().toISOString(),
    turn,
  }, dirOverride ?? stateDir());
}

export async function captureIssueClosedOutcome(
  sessionId: string,
  turn: number,
  dirOverride?: string,
): Promise<void> {
  writeOutcome({
    type: "issue-closed",
    sessionId,
    timestamp: new Date().toISOString(),
    turn,
  }, dirOverride ?? stateDir());
}
