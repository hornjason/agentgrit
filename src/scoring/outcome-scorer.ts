import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { computeOutcomeScore, readOutcomes, type OutcomeEvent } from "../capture/outcomes";
import { stateDir as defaultStateDir, resolveSignalDir } from "../adapters/paths";

export interface ScoredSession {
  sessionId: string;
  keywordScore: number;
  outcomeScore: number;
  delta: number;
  outcomeEvents: OutcomeEvent[];
  confidence: "high" | "medium" | "low";
}

function readRatingsForSession(
  sessionId: string,
  signalDir: string,
): number | null {
  const ratingsPath = join(signalDir, "ratings.jsonl");
  if (!existsSync(ratingsPath)) return null;

  const content = readFileSync(ratingsPath, "utf-8");
  let lastRating: number | null = null;

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.session_id === sessionId && typeof entry.rating === "number") {
        lastRating = entry.rating;
      }
    } catch { /* skip malformed */ }
  }

  return lastRating;
}

function allSessionIdsFromRatings(signalDir: string): string[] {
  const ratingsPath = join(signalDir, "ratings.jsonl");
  if (!existsSync(ratingsPath)) return [];

  const content = readFileSync(ratingsPath, "utf-8");
  const ids = new Set<string>();

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.session_id) ids.add(entry.session_id);
    } catch { /* skip */ }
  }

  return Array.from(ids);
}

function readOutcomesFromDir(
  sessionId: string | undefined,
  dir: string,
): OutcomeEvent[] {
  const filePath = join(dir, "outcome-events.jsonl");
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

function determineConfidence(eventCount: number): "high" | "medium" | "low" {
  if (eventCount >= 3) return "high";
  if (eventCount >= 1) return "medium";
  return "low";
}

export function scoreSessionByOutcome(
  sessionId: string,
  stateOverride?: string,
  signalOverride?: string,
): ScoredSession {
  const sd = stateOverride ?? defaultStateDir();
  const sig = signalOverride ?? resolveSignalDir();

  const events = readOutcomesFromDir(sessionId, sd);
  const keywordScore = readRatingsForSession(sessionId, sig) ?? 6.0;
  const confidence = determineConfidence(events.length);

  const outcomeScore = confidence === "low"
    ? keywordScore
    : computeOutcomeScore(events);

  return {
    sessionId,
    keywordScore,
    outcomeScore,
    delta: Math.round((outcomeScore - keywordScore) * 10) / 10,
    outcomeEvents: events,
    confidence,
  };
}

export function scoreAllSessions(
  stateOverride?: string,
  signalOverride?: string,
): ScoredSession[] {
  const sig = signalOverride ?? resolveSignalDir();
  const sessionIds = allSessionIdsFromRatings(sig);

  return sessionIds.map(id => scoreSessionByOutcome(id, stateOverride, signalOverride));
}
