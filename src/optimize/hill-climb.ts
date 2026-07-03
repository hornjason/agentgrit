import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";

export interface HillClimbConfig {
  current: string;
  evaluate: (text: string) => Promise<number>;
  propose: (text: string, weakDimension: string) => Promise<string>;
  rounds: number;
  maxChangeRatio?: number;
  stateDir: string;
  weakDimension?: string;
}

export interface RoundResult {
  round: number;
  score: number;
  delta: number;
  outcome: "kept" | "discarded" | "rejected_size" | "proposal_failed";
  summary: string;
  latencyMs: number;
  timestamp: string;
}

export interface HillClimbResult {
  initialScore: number;
  finalScore: number;
  totalDelta: number;
  rounds: RoundResult[];
  kept: number;
  discarded: number;
  rejected: number;
  finalText: string;
  reviewFlagged: RoundResult[];
}

const DEFAULT_MAX_CHANGE_RATIO = 0.15;
const LARGE_DELTA_THRESHOLD = 0.15;

function isChangeTooLarge(original: string, proposed: string, maxRatio: number): boolean {
  if (original.length === 0) return false;
  const ratio = Math.abs(proposed.length - original.length) / original.length;
  return ratio > maxRatio;
}

async function appendExperimentLog(stateDir: string, entry: RoundResult): Promise<void> {
  const logPath = join(stateDir, "experiments.jsonl");
  const dir = dirname(logPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const line = JSON.stringify(entry) + "\n";
  const file = Bun.file(logPath);
  const existing = existsSync(logPath) ? await file.text() : "";
  await Bun.write(logPath, existing + line);
}

export async function hillClimb(config: HillClimbConfig): Promise<HillClimbResult> {
  const maxChangeRatio = config.maxChangeRatio ?? DEFAULT_MAX_CHANGE_RATIO;
  const weakDimension = config.weakDimension ?? "";

  const initialScore = await config.evaluate(config.current);
  let currentText = config.current;
  let currentScore = initialScore;

  const rounds: RoundResult[] = [];
  const reviewFlagged: RoundResult[] = [];
  let kept = 0;
  let discarded = 0;
  let rejected = 0;

  for (let i = 1; i <= config.rounds; i++) {
    const roundStart = Date.now();
    let proposed: string;

    try {
      proposed = await config.propose(currentText, weakDimension);
    } catch {
      const result: RoundResult = {
        round: i,
        score: currentScore,
        delta: 0,
        outcome: "proposal_failed",
        summary: "Propose function threw an error",
        latencyMs: Date.now() - roundStart,
        timestamp: new Date().toISOString(),
      };
      rounds.push(result);
      await appendExperimentLog(config.stateDir, result);
      continue;
    }

    if (!proposed || proposed === currentText) {
      const result: RoundResult = {
        round: i,
        score: currentScore,
        delta: 0,
        outcome: "proposal_failed",
        summary: "Proposal returned empty or identical text",
        latencyMs: Date.now() - roundStart,
        timestamp: new Date().toISOString(),
      };
      rounds.push(result);
      await appendExperimentLog(config.stateDir, result);
      continue;
    }

    if (isChangeTooLarge(currentText, proposed, maxChangeRatio)) {
      const ratio = Math.abs(proposed.length - currentText.length) / currentText.length;
      const result: RoundResult = {
        round: i,
        score: currentScore,
        delta: 0,
        outcome: "rejected_size",
        summary: `Change ratio ${(ratio * 100).toFixed(1)}% exceeds limit ${(maxChangeRatio * 100).toFixed(0)}%`,
        latencyMs: Date.now() - roundStart,
        timestamp: new Date().toISOString(),
      };
      rounds.push(result);
      rejected++;
      await appendExperimentLog(config.stateDir, result);
      continue;
    }

    const proposedScore = await config.evaluate(proposed);
    const delta = proposedScore - currentScore;
    const latencyMs = Date.now() - roundStart;

    if (proposedScore > currentScore) {
      currentText = proposed;
      currentScore = proposedScore;
      kept++;

      const result: RoundResult = {
        round: i,
        score: proposedScore,
        delta,
        outcome: "kept",
        summary: `Improved from ${(currentScore - delta).toFixed(4)} to ${proposedScore.toFixed(4)}`,
        latencyMs,
        timestamp: new Date().toISOString(),
      };
      rounds.push(result);
      await appendExperimentLog(config.stateDir, result);

      if (delta > LARGE_DELTA_THRESHOLD) {
        reviewFlagged.push(result);
      }
    } else {
      discarded++;
      const result: RoundResult = {
        round: i,
        score: proposedScore,
        delta,
        outcome: "discarded",
        summary: `Score ${proposedScore.toFixed(4)} did not exceed ${currentScore.toFixed(4)}`,
        latencyMs,
        timestamp: new Date().toISOString(),
      };
      rounds.push(result);
      await appendExperimentLog(config.stateDir, result);
    }
  }

  return {
    initialScore,
    finalScore: currentScore,
    totalDelta: currentScore - initialScore,
    rounds,
    kept,
    discarded,
    rejected,
    finalText: currentText,
    reviewFlagged,
  };
}
