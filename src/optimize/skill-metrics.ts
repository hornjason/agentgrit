import { existsSync } from "fs";
import { join } from "path";

export interface SkillSequenceEntry {
  session_id: string;
  timestamp: string;
  skill_name: string;
  args: string;
  outcome: string;
  rating: number | null;
}

export interface SkillSuggestionEntry {
  timestamp: string;
  session_id: string;
  prompt_snippet: string;
  suggested_skills: string[];
}

export interface SkillInvocationEntry {
  timestamp: string;
  session_id: string;
  skill: string;
  workflow: string | null;
}

export interface RatingEntry {
  timestamp: string;
  session_id: string;
  rating: number;
}

export interface AccuracyResult {
  totalSessions: number;
  detectableSessions: number;
  correctSelections: number;
  accuracy: number;
}

export interface ConversionResult {
  totalSuggestions: number;
  totalInvocations: number;
  matchedConversions: number;
  overallConversionRate: number;
  falsePositiveCount: number;
  falsePositiveRate: number;
  perSkill: Record<string, { suggestions: number; invocations: number; conversion: number }>;
}

export type CooccurrenceMatrix = Record<string, Record<string, number>>;

export interface UsageStats {
  skill: string;
  totalInvocations: number;
  uniqueSessions: number;
  avgRating: number | null;
  impactDelta: number | null;
  trend: "improving" | "declining" | "stable" | "insufficient-data";
}

export interface SkillMetrics {
  accuracy: AccuracyResult;
  conversion: ConversionResult;
  cooccurrence: CooccurrenceMatrix;
  usage: UsageStats[];
  generatedAt: string;
}

const TASK_PATTERNS: Record<string, RegExp[]> = {
  "debugging-and-bug-fixes": [/\bfix\b/i, /\bbug\b/i, /\bdebug\b/i, /\bbroken\b/i, /\berror\b/i],
  "testing-and-qa-validation": [/\btest\b/i, /\bQA\b/i, /\bvalidat/i, /\bspec\b/i],
  "research-and-api-investigation": [/\bresearch\b/i, /\binvestigat/i, /\bexplor/i],
};

const CONVERSION_WINDOW_MS = 30 * 60 * 1000;

async function readJsonl<T>(filePath: string): Promise<T[]> {
  if (!existsSync(filePath)) return [];
  const content = await Bun.file(filePath).text();
  const results: T[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      results.push(JSON.parse(trimmed) as T);
    } catch {}
  }
  return results;
}

function computeAccuracy(sequences: SkillSequenceEntry[]): AccuracyResult {
  const sessions = new Map<string, string[]>();
  for (const entry of sequences) {
    if (!sessions.has(entry.session_id)) sessions.set(entry.session_id, []);
    sessions.get(entry.session_id)!.push(entry.skill_name);
  }

  let totalSessions = 0;
  let detectableSessions = 0;
  let correctSelections = 0;

  for (const [, skills] of sessions) {
    if (skills.length === 0) continue;
    totalSessions++;
    const firstSkill = skills[0];
    const allText = skills.join(" ");

    let expectedSkill: string | null = null;
    for (const [skill, patterns] of Object.entries(TASK_PATTERNS)) {
      if (patterns.some((p) => p.test(allText))) {
        expectedSkill = skill;
        break;
      }
    }

    if (expectedSkill) {
      detectableSessions++;
      if (firstSkill === expectedSkill) correctSelections++;
    }
  }

  return {
    totalSessions,
    detectableSessions,
    correctSelections,
    accuracy: detectableSessions > 0 ? correctSelections / detectableSessions : 0,
  };
}

function isFalsePositive(snippet: string): boolean {
  return snippet.startsWith("<task-notification>") || snippet.startsWith("<system-reminder>");
}

function computeConversion(
  suggestions: SkillSuggestionEntry[],
  invocations: SkillInvocationEntry[],
): ConversionResult {
  const fpCount = suggestions.filter((s) => isFalsePositive(s.prompt_snippet || "")).length;
  const realSuggestions = suggestions.filter((s) => !isFalsePositive(s.prompt_snippet || ""));

  type Claimable = SkillInvocationEntry & { _ms: number; _claimed: boolean };
  const invBySkill = new Map<string, Claimable[]>();
  for (const inv of invocations) {
    const arr = invBySkill.get(inv.skill) || [];
    arr.push({ ...inv, _ms: Date.parse(inv.timestamp), _claimed: false });
    invBySkill.set(inv.skill, arr);
  }
  for (const arr of invBySkill.values()) arr.sort((a, b) => a._ms - b._ms);

  const perSkill = new Map<string, { suggestions: number; invocations: number; conversion: number }>();
  let totalMatched = 0;

  for (const sugg of realSuggestions) {
    const suggMs = Date.parse(sugg.timestamp);
    for (const slug of sugg.suggested_skills) {
      const stats = perSkill.get(slug) || { suggestions: 0, invocations: 0, conversion: 0 };
      stats.suggestions++;

      const candidates = invBySkill.get(slug) || [];
      let claimed = false;

      for (const inv of candidates) {
        if (inv._claimed) continue;
        if (sugg.session_id && inv.session_id === sugg.session_id) {
          inv._claimed = true;
          claimed = true;
          break;
        }
      }
      if (!claimed) {
        for (const inv of candidates) {
          if (inv._claimed) continue;
          const dt = inv._ms - suggMs;
          if (dt >= 0 && dt <= CONVERSION_WINDOW_MS) {
            inv._claimed = true;
            claimed = true;
            break;
          }
          if (dt > CONVERSION_WINDOW_MS) break;
        }
      }

      if (claimed) {
        stats.invocations++;
        totalMatched++;
      }
      perSkill.set(slug, stats);
    }
  }

  for (const stats of perSkill.values()) {
    stats.conversion = stats.suggestions > 0 ? stats.invocations / stats.suggestions : 0;
  }

  const totalSuggSlots = realSuggestions.reduce((n, s) => n + (s.suggested_skills?.length || 0), 0);

  return {
    totalSuggestions: suggestions.length,
    totalInvocations: invocations.length,
    matchedConversions: totalMatched,
    overallConversionRate: totalSuggSlots > 0 ? totalMatched / totalSuggSlots : 0,
    falsePositiveCount: fpCount,
    falsePositiveRate: suggestions.length > 0 ? fpCount / suggestions.length : 0,
    perSkill: Object.fromEntries(perSkill),
  };
}

function computeCooccurrence(sequences: SkillSequenceEntry[]): CooccurrenceMatrix {
  const sessions = new Map<string, Set<string>>();
  for (const entry of sequences) {
    if (!sessions.has(entry.session_id)) sessions.set(entry.session_id, new Set());
    sessions.get(entry.session_id)!.add(entry.skill_name);
  }

  const matrix: CooccurrenceMatrix = {};
  for (const [, skills] of sessions) {
    const arr = Array.from(skills);
    for (const skill of arr) {
      if (!matrix[skill]) matrix[skill] = {};
    }
    if (arr.length < 2) continue;
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        matrix[arr[i]][arr[j]] = (matrix[arr[i]][arr[j]] || 0) + 1;
        matrix[arr[j]][arr[i]] = (matrix[arr[j]][arr[i]] || 0) + 1;
      }
    }
  }
  return matrix;
}

function computeUsage(
  invocations: SkillInvocationEntry[],
  ratings: RatingEntry[],
): UsageStats[] {
  const ratingBySession = new Map<string, number>();
  for (const r of ratings) {
    if (r.session_id && typeof r.rating === "number") {
      ratingBySession.set(r.session_id, r.rating);
    }
  }

  const bySkill = new Map<string, SkillInvocationEntry[]>();
  for (const inv of invocations) {
    if (!inv.skill) continue;
    const arr = bySkill.get(inv.skill) || [];
    arr.push(inv);
    bySkill.set(inv.skill, arr);
  }

  const sessionsWithSkills = new Set(invocations.map((i) => i.session_id));
  const baselineRatings = [...ratingBySession.entries()]
    .filter(([s]) => !sessionsWithSkills.has(s))
    .map(([, r]) => r);
  const baselineAvg =
    baselineRatings.length > 0
      ? baselineRatings.reduce((a, b) => a + b, 0) / baselineRatings.length
      : null;

  const results: UsageStats[] = [];
  for (const [skill, invs] of bySkill) {
    const uniqueSessions = new Set(invs.map((i) => i.session_id));
    const sessionIds = [...uniqueSessions];

    const skillRatings = sessionIds
      .map((s) => ratingBySession.get(s))
      .filter((r): r is number => r !== undefined);
    const avgRating =
      skillRatings.length > 0
        ? skillRatings.reduce((a, b) => a + b, 0) / skillRatings.length
        : null;

    const impactDelta =
      avgRating !== null && baselineAvg !== null ? avgRating - baselineAvg : null;

    let trend: UsageStats["trend"] = "insufficient-data";
    const ratedSessions = sessionIds.filter((s) => ratingBySession.has(s));
    if (ratedSessions.length >= 4) {
      const half = Math.floor(ratedSessions.length / 2);
      const firstN = ratedSessions.slice(0, half);
      const lastN = ratedSessions.slice(-half);
      const avgFirst = firstN.reduce((s, id) => s + (ratingBySession.get(id) || 0), 0) / firstN.length;
      const avgLast = lastN.reduce((s, id) => s + (ratingBySession.get(id) || 0), 0) / lastN.length;
      const delta = avgLast - avgFirst;
      if (delta > 0.3) trend = "improving";
      else if (delta < -0.3) trend = "declining";
      else trend = "stable";
    }

    results.push({
      skill,
      totalInvocations: invs.length,
      uniqueSessions: uniqueSessions.size,
      avgRating,
      impactDelta,
      trend,
    });
  }

  return results.sort((a, b) => b.totalInvocations - a.totalInvocations);
}

export async function computeSkillMetrics(signalDir: string): Promise<SkillMetrics> {
  const sequences = await readJsonl<SkillSequenceEntry>(join(signalDir, "skill-sequences.jsonl"));
  const suggestions = await readJsonl<SkillSuggestionEntry>(join(signalDir, "skill-router-suggestions.jsonl"));
  const invocations = await readJsonl<SkillInvocationEntry>(join(signalDir, "skill-invocations.jsonl"));
  const ratings = await readJsonl<RatingEntry>(join(signalDir, "ratings.jsonl"));

  return {
    accuracy: computeAccuracy(sequences),
    conversion: computeConversion(suggestions, invocations),
    cooccurrence: computeCooccurrence(sequences),
    usage: computeUsage(invocations, ratings),
    generatedAt: new Date().toISOString(),
  };
}
