import type { OutcomeEvent } from "../capture/outcomes";
import { getOutcomeWeights, type TaskType } from "./task-types";

export interface MiniSession {
  startTurn: number;
  endTurn: number;
  score: number;
  outcomeCount: number;
  taskType: TaskType;
}

function computeSegmentScore(events: OutcomeEvent[], taskType: TaskType): number {
  const weights = getOutcomeWeights(taskType);
  const base = 5.0;
  let total = base;
  for (const event of events) {
    total += weights[event.type] ?? 0;
  }
  return Math.round(Math.max(1, Math.min(10, total)) * 10) / 10;
}

export function segmentIntoMiniSessions(
  events: OutcomeEvent[],
  boundaries: number[],
  taskType: TaskType,
): MiniSession[] {
  const sorted = [...boundaries].sort((a, b) => a - b);
  const edges = [0, ...sorted, Infinity];

  const sessions: MiniSession[] = [];

  for (let i = 0; i < edges.length - 1; i++) {
    const start = edges[i];
    const end = edges[i + 1];
    const segmentEvents = events.filter(e => e.turn >= start && e.turn < end);

    sessions.push({
      startTurn: start,
      endTurn: end,
      score: computeSegmentScore(segmentEvents, taskType),
      outcomeCount: segmentEvents.length,
      taskType,
    });
  }

  return sessions;
}

export function aggregateMiniSessions(sessions: MiniSession[]): number {
  if (sessions.length === 0) return 5.0;

  const totalOutcomes = sessions.reduce((sum, s) => sum + s.outcomeCount, 0);
  if (totalOutcomes === 0) return 5.0;

  const weightedSum = sessions.reduce((sum, s) => sum + s.score * s.outcomeCount, 0);
  return Math.round((weightedSum / totalOutcomes) * 10) / 10;
}
