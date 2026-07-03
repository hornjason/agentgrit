/**
 * cleanup.ts — Session lifecycle cleanup, signal rotation, and memory compression
 *
 * Consolidated from:
 *   - PAI hooks/SessionCleanup.hook.ts — mark work complete, clear state
 *   - PAI Tools/SessionCompressor.ts — graduated memory compression
 *   - PAI hooks/UpdateCounts.hook.ts — system counts update
 */

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { rotateFile } from "../adapters/jsonl";

const DEFAULT_MAX_SIZE_MB = 10;
const STALE_STATE_DAYS = 30;
const MS_PER_DAY = 86_400_000;
const WEEKLY_THRESHOLD_DAYS = 7;
const MONTHLY_THRESHOLD_DAYS = 30;

// ── Types ──

export interface CleanupResult {
  staleFilesRemoved: number;
  sessionStatesCleared: number;
  errors: string[];
}

export interface CompressResult {
  weeklyDigestsCreated: number;
  monthlyDigestsCreated: number;
  sessionsCompressed: number;
}

export interface CountsResult {
  signalFiles: number;
  ruleFiles: number;
  graphNodes: number;
}

// ── Session Cleanup ──

export async function cleanupSession(
  signalDir: string,
  stateDir: string,
): Promise<CleanupResult> {
  const result: CleanupResult = {
    staleFilesRemoved: 0,
    sessionStatesCleared: 0,
    errors: [],
  };

  // Clean stale session state files
  if (existsSync(stateDir)) {
    try {
      const files = readdirSync(stateDir);
      const now = Date.now();

      for (const file of files) {
        if (!file.startsWith("current-work-") && file !== "current-work.json") continue;

        const path = join(stateDir, file);
        try {
          const stat = statSync(path);
          const ageMs = now - stat.mtimeMs;

          if (ageMs > STALE_STATE_DAYS * MS_PER_DAY) {
            unlinkSync(path);
            result.staleFilesRemoved++;
          }
        } catch (err) {
          result.errors.push(
            `Failed to check ${file}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      result.errors.push(
        `Failed to read state dir: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Clean stale temp/backup files
  if (existsSync(stateDir)) {
    try {
      const files = readdirSync(stateDir);

      for (const file of files) {
        if (!file.endsWith(".tmp") && !file.endsWith(".bak")) continue;

        const path = join(stateDir, file);
        try {
          const stat = statSync(path);
          const ageMs = Date.now() - stat.mtimeMs;

          if (ageMs > 7 * MS_PER_DAY) {
            unlinkSync(path);
            result.sessionStatesCleared++;
          }
        } catch (err) {
          result.errors.push(
            `Failed to clean ${file}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      result.errors.push(
        `Failed to clean state dir: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}

// ── Signal Rotation ──

export async function rotateSignals(
  signalDir: string,
  maxSizeMB: number = DEFAULT_MAX_SIZE_MB,
): Promise<number> {
  if (!existsSync(signalDir)) return 0;

  const maxSizeBytes = maxSizeMB * 1024 * 1024;
  const files = readdirSync(signalDir).filter((f) => f.endsWith(".jsonl"));
  let rotated = 0;

  for (const file of files) {
    const path = join(signalDir, file);
    const result = await rotateFile(path, maxSizeBytes);
    if (result.rotated) rotated++;
  }

  return rotated;
}

// ── Session Compression (graduated weekly/monthly digests) ──

interface RatingEntry {
  session_id?: string;
  timestamp: string;
  rating?: number;
  sentiment_summary?: string;
}

interface WeeklyDigest {
  type: "weekly";
  weekStart: string;
  sessionCount: number;
  avgRating: number;
  summaries: string[];
  keyThemes: string[];
}

interface MonthlyDigest {
  type: "monthly";
  month: string;
  sessionCount: number;
  avgRating: number;
  topThemes: string[];
  weekCount: number;
}

interface DigestStore {
  weekly: Record<string, WeeklyDigest>;
  monthly: Record<string, MonthlyDigest>;
  lastCompressed: string;
  totalSessionsCompressed: number;
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "by", "do", "for",
  "from", "has", "have", "he", "her", "him", "his", "how", "i", "if", "in",
  "is", "it", "its", "me", "my", "no", "not", "of", "on", "or", "our",
  "the", "their", "them", "they", "this", "to", "up", "us", "was", "we",
  "what", "when", "which", "who", "will", "with", "you", "that", "but",
]);

function getMondayOfWeek(date: Date): string {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().slice(0, 10);
}

function extractThemes(summaries: string[], count: number = 5): string[] {
  const freq = new Map<string, number>();
  for (const s of summaries) {
    const words = s.toLowerCase().split(/\W+/).filter((w) => w.length > 3 && !STOPWORDS.has(w));
    for (const w of words) {
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([word]) => word);
}

export async function compressSession(
  ratingsPath: string,
  digestsPath: string,
): Promise<CompressResult> {
  const result: CompressResult = {
    weeklyDigestsCreated: 0,
    monthlyDigestsCreated: 0,
    sessionsCompressed: 0,
  };

  if (!existsSync(ratingsPath)) return result;

  // Load existing digests
  let store: DigestStore;
  try {
    if (existsSync(digestsPath)) {
      store = JSON.parse(readFileSync(digestsPath, "utf-8"));
    } else {
      store = { weekly: {}, monthly: {}, lastCompressed: "", totalSessionsCompressed: 0 };
    }
  } catch {
    store = { weekly: {}, monthly: {}, lastCompressed: "", totalSessionsCompressed: 0 };
  }

  // Parse ratings
  const lines = readFileSync(ratingsPath, "utf-8").trim().split("\n");
  const entries: RatingEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* skip */ }
  }

  if (entries.length === 0) return result;

  const now = new Date();
  const weeklyThreshold = new Date(now.getTime() - WEEKLY_THRESHOLD_DAYS * MS_PER_DAY);
  const monthlyThreshold = new Date(now.getTime() - MONTHLY_THRESHOLD_DAYS * MS_PER_DAY);

  // Group entries by week
  const byWeek = new Map<string, RatingEntry[]>();
  for (const entry of entries) {
    const date = new Date(entry.timestamp);
    if (date >= weeklyThreshold) continue; // Too recent for weekly digest
    const weekKey = getMondayOfWeek(date);
    if (store.weekly[weekKey]) continue; // Already compressed
    const group = byWeek.get(weekKey) || [];
    group.push(entry);
    byWeek.set(weekKey, group);
  }

  // Create weekly digests
  for (const [weekKey, weekEntries] of byWeek) {
    const ratings = weekEntries.filter((e) => e.rating !== undefined).map((e) => e.rating!);
    const summaries = weekEntries
      .filter((e) => e.sentiment_summary)
      .map((e) => e.sentiment_summary!)
      .slice(0, 5);

    store.weekly[weekKey] = {
      type: "weekly",
      weekStart: weekKey,
      sessionCount: weekEntries.length,
      avgRating: ratings.length > 0 ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 0,
      summaries,
      keyThemes: extractThemes(summaries),
    };
    result.weeklyDigestsCreated++;
    result.sessionsCompressed += weekEntries.length;
  }

  // Create monthly digests from old weekly digests
  const monthCandidates = new Map<string, WeeklyDigest[]>();
  for (const [weekKey, digest] of Object.entries(store.weekly)) {
    const weekDate = new Date(weekKey);
    if (weekDate >= monthlyThreshold) continue;
    const monthKey = weekKey.slice(0, 7);
    const group = monthCandidates.get(monthKey) || [];
    group.push(digest);
    monthCandidates.set(monthKey, group);
  }

  for (const [monthKey, weeks] of monthCandidates) {
    if (store.monthly[monthKey]) continue;
    const allSummaries = weeks.flatMap((w) => w.summaries);
    const totalSessions = weeks.reduce((sum, w) => sum + w.sessionCount, 0);
    const avgRating = weeks.reduce((sum, w) => sum + w.avgRating * w.sessionCount, 0) / totalSessions;

    store.monthly[monthKey] = {
      type: "monthly",
      month: monthKey,
      sessionCount: totalSessions,
      avgRating,
      topThemes: extractThemes(allSummaries),
      weekCount: weeks.length,
    };
    result.monthlyDigestsCreated++;

    // Remove compressed weekly digests
    for (const week of weeks) {
      delete store.weekly[week.weekStart];
    }
  }

  // Save
  store.lastCompressed = now.toISOString();
  store.totalSessionsCompressed += result.sessionsCompressed;

  const dir = dirname(digestsPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(digestsPath, JSON.stringify(store, null, 2));

  return result;
}

// ── System Counts ──

export function updateCounts(baseDir: string): CountsResult {
  const signalDir = join(baseDir, "signals");
  const rulesDir = join(baseDir, "rules");
  const stateBase = join(baseDir, "state");
  const graphPath = join(stateBase, "knowledge-graph.json");

  const signalFiles = existsSync(signalDir)
    ? readdirSync(signalDir).filter((f) => f.endsWith(".jsonl")).length
    : 0;

  const ruleFiles = existsSync(rulesDir)
    ? readdirSync(rulesDir).filter((f) => f.endsWith(".md")).length
    : 0;

  let graphNodes = 0;
  if (existsSync(graphPath)) {
    try {
      const graph = JSON.parse(readFileSync(graphPath, "utf-8"));
      graphNodes = Object.keys(graph.nodes || {}).length;
    } catch { /* ignore */ }
  }

  return { signalFiles, ruleFiles, graphNodes };
}
