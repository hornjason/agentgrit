import { join } from "path";
import { readSignals } from "../adapters/jsonl";
import { resolveSignalFile } from "../adapters/paths";
import type {
  CorrectionSignal,
  RatingSignal,
  SkillInvocationSignal,
  Pattern,
} from "../adapters/types";

const RATING_LOW_THRESHOLD = 4;

interface SessionSnapshot {
  session_id: string;
  ratings: RatingSignal[];
  corrections: CorrectionSignal[];
  skillMisses: SkillInvocationSignal[];
  avgRating: number;
}

function buildSessionSnapshots(
  ratings: RatingSignal[],
  corrections: CorrectionSignal[],
  skills: SkillInvocationSignal[],
): Map<string, SessionSnapshot> {
  const sessions = new Map<string, SessionSnapshot>();

  function ensure(sid: string): SessionSnapshot {
    if (!sessions.has(sid)) {
      sessions.set(sid, {
        session_id: sid,
        ratings: [],
        corrections: [],
        skillMisses: [],
        avgRating: 0,
      });
    }
    return sessions.get(sid)!;
  }

  for (const r of ratings) {
    ensure(r.session_id).ratings.push(r);
  }
  for (const c of corrections) {
    ensure(c.session_id).corrections.push(c);
  }
  for (const s of skills) {
    ensure(s.session_id).skillMisses.push(s);
  }

  for (const snap of sessions.values()) {
    if (snap.ratings.length > 0) {
      snap.avgRating =
        snap.ratings.reduce((sum, r) => sum + r.rating, 0) /
        snap.ratings.length;
    }
  }

  return sessions;
}

function findLowRatedWithCorrections(
  sessions: Map<string, SessionSnapshot>,
): Pattern[] {
  const patterns: Pattern[] = [];
  const lowSessions: SessionSnapshot[] = [];

  for (const snap of sessions.values()) {
    if (snap.avgRating > 0 && snap.avgRating <= RATING_LOW_THRESHOLD && snap.corrections.length > 0) {
      lowSessions.push(snap);
    }
  }

  if (lowSessions.length >= 2) {
    const sessionIds = lowSessions.map((s) => s.session_id);
    const allCorrections = lowSessions.flatMap((s) => s.corrections);
    const maxSeverity = Math.min(allCorrections.length + 3, 10);
    const timestamps = allCorrections.map((c) => c.timestamp).sort();

    patterns.push({
      id: `corr-low-rating-${sessionIds.length}`,
      type: "low-rating-with-corrections",
      frequency: lowSessions.length,
      sessions: sessionIds,
      severity: maxSeverity,
      candidateRule: `Low-rated sessions (avg <= ${RATING_LOW_THRESHOLD}) consistently show correction signals. Review correction triggers for common themes.`,
      firstSeen: timestamps[0],
      lastSeen: timestamps[timestamps.length - 1],
    });
  }

  return patterns;
}

function findSkillMissPatterns(
  sessions: Map<string, SessionSnapshot>,
): Pattern[] {
  const missCounter = new Map<string, { sessions: string[]; count: number }>();

  for (const snap of sessions.values()) {
    for (const miss of snap.skillMisses) {
      const key = miss.skill;
      if (!missCounter.has(key)) {
        missCounter.set(key, { sessions: [], count: 0 });
      }
      const entry = missCounter.get(key)!;
      if (!entry.sessions.includes(snap.session_id)) {
        entry.sessions.push(snap.session_id);
      }
      entry.count++;
    }
  }

  const patterns: Pattern[] = [];
  for (const [skill, data] of missCounter) {
    if (data.sessions.length >= 2) {
      patterns.push({
        id: `skill-miss-${skill}`,
        type: "skill-miss",
        frequency: data.count,
        sessions: data.sessions,
        severity: 5,
        candidateRule: `Skill "${skill}" failed in ${data.sessions.length} sessions (${data.count} total failures). Investigate trigger accuracy or skill reliability.`,
      });
    }
  }

  return patterns;
}

function findScoreDrops(
  sessions: Map<string, SessionSnapshot>,
): Pattern[] {
  const chronological = [...sessions.values()]
    .filter((s) => s.ratings.length > 0)
    .sort((a, b) => {
      const aTime = a.ratings[0]?.timestamp ?? "";
      const bTime = b.ratings[0]?.timestamp ?? "";
      return aTime.localeCompare(bTime);
    });

  if (chronological.length < 4) return [];

  const patterns: Pattern[] = [];
  const windowSize = Math.min(Math.floor(chronological.length / 2), 5);

  const earlyAvg =
    chronological
      .slice(0, windowSize)
      .reduce((sum, s) => sum + s.avgRating, 0) / windowSize;
  const lateAvg =
    chronological
      .slice(-windowSize)
      .reduce((sum, s) => sum + s.avgRating, 0) / windowSize;

  if (earlyAvg - lateAvg >= 1.5) {
    const dropSessions = chronological.slice(-windowSize).map((s) => s.session_id);
    patterns.push({
      id: "score-drop-trend",
      type: "score-drop",
      frequency: windowSize,
      sessions: dropSessions,
      severity: 7,
      candidateRule: `Score trend declining: early avg ${earlyAvg.toFixed(1)} → recent avg ${lateAvg.toFixed(1)}. Investigate what changed in recent sessions.`,
    });
  }

  return patterns;
}

export async function minePatterns(signalDir: string): Promise<Pattern[]> {
  const [rawRatings, rawCorrections, rawSkills] = await Promise.all([
    readSignals(resolveSignalFile(signalDir, "ratings.jsonl")),
    readSignals(resolveSignalFile(signalDir, "corrections.jsonl")),
    readSignals(resolveSignalFile(signalDir, "skills.jsonl")),
  ]);

  const ratings = rawRatings.filter((s): s is RatingSignal => s.type === "rating");
  const corrections = rawCorrections.filter(
    (s): s is CorrectionSignal => s.type === "correction",
  );
  const skills = rawSkills.filter(
    (s): s is SkillInvocationSignal => s.type === "skill-invocation",
  );

  const sessions = buildSessionSnapshots(ratings, corrections, skills);

  const patterns: Pattern[] = [
    ...findLowRatedWithCorrections(sessions),
    ...findSkillMissPatterns(sessions),
    ...findScoreDrops(sessions),
  ];

  return patterns.sort((a, b) => b.severity - a.severity);
}
