import { join } from "path";
import { readSignals } from "../adapters/jsonl";
import type { CorrectionSignal, RatingSignal, SkillInvocationSignal, Pattern } from "../adapters/types";

const RATING_LOW_THRESHOLD = 4;
const RATING_HIGH_THRESHOLD = 7;

// ── Types ──────────────────────────────────────────────────────────────────

interface SessionSnapshot {
  session_id: string;
  ratings: RatingSignal[];
  corrections: CorrectionSignal[];
  skillMisses: SkillInvocationSignal[];
  avgRating: number;
}

export interface PatternGroup {
  pattern: string;
  count: number;
  avgRating: number;
  avgConfidence: number;
  examples: string[];
}

export interface SynthesisResult {
  period: string;
  totalRatings: number;
  avgRating: number;
  frustrations: PatternGroup[];
  successes: PatternGroup[];
  topIssues: string[];
  recommendations: string[];
}

export interface NewGapPattern {
  name: string;
  slug: string;
  commonTheme: string;
  suggestedRule: string;
  reportFile: string;
}

export interface AnnotatedPattern {
  name: string;
  occurrences: number;
  dates: string[];
  common_lesson: string;
  source_indices: number[];
  feedbackMemory: string;
  suggestedRule: string;
}

// ── Regex matchers ─────────────────────────────────────────────────────────

export const FRUSTRATION_PATTERNS: Record<string, RegExp> = {
  "Time/Performance Issues": /time|slow|delay|hang|wait|long|minutes|hours/i,
  "Incomplete Work": /incomplete|missing|partial|didn't finish|not done/i,
  "Wrong Approach": /wrong|incorrect|not what|misunderstand|mistake/i,
  "Over-engineering": /over-?engineer|too complex|unnecessary|bloat/i,
  "Tool/System Failures": /fail|error|broken|crash|bug|issue/i,
  "Communication Problems": /unclear|confus|didn't ask|should have asked/i,
  "Repetitive Issues": /again|repeat|still|same problem/i,
};

export const SUCCESS_PATTERNS: Record<string, RegExp> = {
  "Quick Resolution": /quick|fast|efficient|smooth/i,
  "Good Understanding": /understood|clear|exactly|perfect/i,
  "Proactive Help": /proactive|anticipat|helpful|above and beyond/i,
  "Clean Implementation": /clean|simple|elegant|well done/i,
};

// ── Session snapshot building ──────────────────────────────────────────────

function buildSessionSnapshots(
  ratings: RatingSignal[], corrections: CorrectionSignal[], skills: SkillInvocationSignal[],
): Map<string, SessionSnapshot> {
  const sessions = new Map<string, SessionSnapshot>();
  function ensure(sid: string): SessionSnapshot {
    if (!sessions.has(sid)) {
      sessions.set(sid, { session_id: sid, ratings: [], corrections: [], skillMisses: [], avgRating: 0 });
    }
    return sessions.get(sid)!;
  }
  for (const r of ratings) ensure(r.session_id).ratings.push(r);
  for (const c of corrections) ensure(c.session_id).corrections.push(c);
  for (const s of skills) ensure(s.session_id).skillMisses.push(s);
  for (const snap of sessions.values()) {
    if (snap.ratings.length > 0) {
      snap.avgRating = snap.ratings.reduce((sum, r) => sum + r.rating, 0) / snap.ratings.length;
    }
  }
  return sessions;
}

// ── Cross-signal pattern detectors ─────────────────────────────────────────

function findLowRatedWithCorrections(sessions: Map<string, SessionSnapshot>): Pattern[] {
  const lowSessions: SessionSnapshot[] = [];
  for (const snap of sessions.values()) {
    if (snap.avgRating > 0 && snap.avgRating <= RATING_LOW_THRESHOLD && snap.corrections.length > 0) {
      lowSessions.push(snap);
    }
  }
  if (lowSessions.length < 2) return [];
  const sessionIds = lowSessions.map((s) => s.session_id);
  const allCorrections = lowSessions.flatMap((s) => s.corrections);
  const timestamps = allCorrections.map((c) => c.timestamp).sort();
  return [{
    id: `corr-low-rating-${sessionIds.length}`,
    type: "low-rating-with-corrections",
    frequency: lowSessions.length,
    sessions: sessionIds,
    severity: Math.min(allCorrections.length + 3, 10),
    candidateRule: `Low-rated sessions (avg <= ${RATING_LOW_THRESHOLD}) consistently show correction signals. Review correction triggers for common themes.`,
    firstSeen: timestamps[0],
    lastSeen: timestamps[timestamps.length - 1],
  }];
}

function findSkillMissPatterns(sessions: Map<string, SessionSnapshot>): Pattern[] {
  const missCounter = new Map<string, { sessions: string[]; count: number }>();
  for (const snap of sessions.values()) {
    for (const miss of snap.skillMisses) {
      if (!missCounter.has(miss.skill)) missCounter.set(miss.skill, { sessions: [], count: 0 });
      const entry = missCounter.get(miss.skill)!;
      if (!entry.sessions.includes(snap.session_id)) entry.sessions.push(snap.session_id);
      entry.count++;
    }
  }
  const patterns: Pattern[] = [];
  for (const [skill, data] of missCounter) {
    if (data.sessions.length >= 2) {
      patterns.push({
        id: `skill-miss-${skill}`, type: "skill-miss", frequency: data.count,
        sessions: data.sessions, severity: 5,
        candidateRule: `Skill "${skill}" failed in ${data.sessions.length} sessions (${data.count} total failures). Investigate trigger accuracy or skill reliability.`,
      });
    }
  }
  return patterns;
}

function findScoreDrops(sessions: Map<string, SessionSnapshot>): Pattern[] {
  const chronological = [...sessions.values()]
    .filter((s) => s.ratings.length > 0)
    .sort((a, b) => (a.ratings[0]?.timestamp ?? "").localeCompare(b.ratings[0]?.timestamp ?? ""));
  if (chronological.length < 4) return [];
  const windowSize = Math.min(Math.floor(chronological.length / 2), 5);
  const earlyAvg = chronological.slice(0, windowSize).reduce((sum, s) => sum + s.avgRating, 0) / windowSize;
  const lateAvg = chronological.slice(-windowSize).reduce((sum, s) => sum + s.avgRating, 0) / windowSize;
  if (earlyAvg - lateAvg < 1.5) return [];
  return [{
    id: "score-drop-trend", type: "score-drop", frequency: windowSize,
    sessions: chronological.slice(-windowSize).map((s) => s.session_id), severity: 7,
    candidateRule: `Score trend declining: early avg ${earlyAvg.toFixed(1)} → recent avg ${lateAvg.toFixed(1)}. Investigate what changed in recent sessions.`,
  }];
}

// ── Synthesis: regex-based pattern detection ───────────────────────────────

function detectRegexPatterns(summaries: string[], patterns: Record<string, RegExp>): Map<string, string[]> {
  const results = new Map<string, string[]>();
  for (const summary of summaries) {
    for (const [name, pattern] of Object.entries(patterns)) {
      if (pattern.test(summary)) {
        if (!results.has(name)) results.set(name, []);
        results.get(name)!.push(summary);
      }
    }
  }
  return results;
}

function groupToPatternGroups(grouped: Map<string, string[]>, ratings: RatingSignal[]): PatternGroup[] {
  const groups: PatternGroup[] = [];
  for (const [pattern, examples] of grouped.entries()) {
    const matchingRatings = ratings.filter((r) => examples.some((e) => e === r.sentimentSummary));
    const avgRating = matchingRatings.length > 0
      ? matchingRatings.reduce((sum, r) => sum + r.rating, 0) / matchingRatings.length : 5;
    const avgConfidence = matchingRatings.length > 0
      ? matchingRatings.reduce((sum, r) => sum + (r.confidence ?? 0.5), 0) / matchingRatings.length : 0.5;
    groups.push({ pattern, count: examples.length, avgRating, avgConfidence, examples: examples.slice(0, 3) });
  }
  return groups.sort((a, b) => b.count - a.count);
}

export function synthesizePatterns(ratings: RatingSignal[], period: string = "Weekly"): SynthesisResult {
  if (ratings.length === 0) {
    return { period, totalRatings: 0, avgRating: 0, frustrations: [], successes: [], topIssues: [], recommendations: [] };
  }
  const avgRating = ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length;
  const frustrationRatings = ratings.filter((r) => r.rating <= RATING_LOW_THRESHOLD);
  const successRatings = ratings.filter((r) => r.rating >= RATING_HIGH_THRESHOLD);
  const frustrationSummaries = frustrationRatings.map((r) => r.sentimentSummary ?? r.comment ?? "").filter(Boolean);
  const successSummaries = successRatings.map((r) => r.sentimentSummary ?? r.comment ?? "").filter(Boolean);
  const frustrations = groupToPatternGroups(detectRegexPatterns(frustrationSummaries, FRUSTRATION_PATTERNS), frustrationRatings);
  const successes = groupToPatternGroups(detectRegexPatterns(successSummaries, SUCCESS_PATTERNS), successRatings);
  const topIssues = frustrations.slice(0, 3).map((f) => `${f.pattern} (${f.count} occurrences, avg rating ${f.avgRating.toFixed(1)})`);
  const recommendations: string[] = [];
  if (frustrations.some((f) => f.pattern === "Time/Performance Issues")) recommendations.push("Consider setting clearer time expectations and progress updates");
  if (frustrations.some((f) => f.pattern === "Wrong Approach")) recommendations.push("Ask clarifying questions before starting complex tasks");
  if (frustrations.some((f) => f.pattern === "Over-engineering")) recommendations.push("Default to simpler solutions; only add complexity when justified");
  if (frustrations.some((f) => f.pattern === "Communication Problems")) recommendations.push("Summarize understanding before implementation");
  if (frustrations.some((f) => f.pattern === "Incomplete Work")) recommendations.push("Self-audit against all requirements before claiming done");
  if (frustrations.some((f) => f.pattern === "Repetitive Issues")) recommendations.push("Check if a rule or process change can prevent recurrence");
  if (recommendations.length === 0) recommendations.push("Continue current patterns - no major issues detected");
  return { period, totalRatings: ratings.length, avgRating, frustrations, successes, topIssues, recommendations };
}

// ── Pattern report converter ───────────────────────────────────────────────

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
}

export function convertReportPatterns(reportContent: string, reportFile: string = "unknown"): NewGapPattern[] {
  const patterns: NewGapPattern[] = [];
  const patternBlocks = reportContent.split(/(?=###\s+Pattern\s+\d+:)/);
  for (const block of patternBlocks) {
    if (!block.includes("NONE") || !block.includes("NEW GAP")) continue;
    const nameMatch = block.match(/###\s+Pattern\s+\d+:\s+(.+)/);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();
    const themeMatch = block.match(/\*\*Common theme:\*\*\s+(.+?)(?=\n\n|\n\*\*)/s);
    if (!themeMatch) continue;
    const commonTheme = themeMatch[1].trim().replace(/\n/g, " ");
    const ruleMatch = block.match(/\*\*Suggested rule:\*\*\s+(.+?)(?=\n\n###|\n---|\n\*Generated|$)/s);
    if (!ruleMatch) continue;
    const suggestedRule = ruleMatch[1].trim().replace(/\n/g, " ");
    patterns.push({ name, slug: slugify(name), commonTheme, suggestedRule, reportFile });
  }
  return patterns;
}

// ── Mining payload builder ─────────────────────────────────────────────────

export function buildMiningPayload(
  digests: string[],
  lowRatings: { date: string; rating: number; sentiment: string }[],
): string {
  const captureLines = digests.map((d, i) => `[${i}] ${d}`).join("\n");
  const badRatings = lowRatings
    .filter((r) => r.rating <= RATING_LOW_THRESHOLD && r.sentiment)
    .slice(0, 30)
    .map((r) => `  - ${r.date} (${r.rating}/10): ${r.sentiment}`)
    .join("\n");
  return `## Learning Captures (${digests.length} total)\n\n${captureLines}\n\n## Low-Rating Signals\n\n${badRatings || "(none in this period)"}`;
}

// ── Primary: cross-signal pattern mining ───────────────────────────────────

export async function minePatterns(signalDir: string): Promise<Pattern[]> {
  const [rawRatings, rawCorrections, rawSkills] = await Promise.all([
    readSignals(join(signalDir, "ratings.jsonl")),
    readSignals(join(signalDir, "corrections.jsonl")),
    readSignals(join(signalDir, "skills.jsonl")),
  ]);
  const ratings = rawRatings.filter((s): s is RatingSignal => s.type === "rating");
  const corrections = rawCorrections.filter((s): s is CorrectionSignal => s.type === "correction");
  const skills = rawSkills.filter((s): s is SkillInvocationSignal => s.type === "skill-invocation");
  const sessions = buildSessionSnapshots(ratings, corrections, skills);
  const patterns: Pattern[] = [
    ...findLowRatedWithCorrections(sessions),
    ...findSkillMissPatterns(sessions),
    ...findScoreDrops(sessions),
  ];
  return patterns.sort((a, b) => b.severity - a.severity);
}
