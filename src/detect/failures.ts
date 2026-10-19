import { join } from "path";
import { readSignals } from "../adapters/jsonl";
import { resolveSignalFile } from "../adapters/paths";
import type { CorrectionSignal, Pattern } from "../adapters/types";

const CORRECTIONS_FILE = "corrections.jsonl";
const DEFAULT_THRESHOLD = 5;

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const word of a) {
    if (b.has(word)) overlap++;
  }
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : overlap / union;
}

/**
 * The text a correction record carries.
 *
 * Cross-session message captures store it as `user_text` rather than
 * `correction_phrase` — 21 of 3011 records in a real signal file have no
 * `correction_phrase` at all (#254), and dereferencing it aborted the whole
 * detection pass, so a file that was 99% readable yielded zero patterns.
 *
 * One accessor, so no two readers can disagree about what a record says.
 * Returns "" when a record carries neither field; callers skip those.
 */
function correctionTextOf(signal: CorrectionSignal): string {
  const raw = signal.correction_phrase ?? (signal as { user_text?: unknown }).user_text;
  return typeof raw === "string" ? raw : "";
}

interface CorrectionGroup {
  representative: string;
  tokens: Set<string>;
  signals: CorrectionSignal[];
  sessions: Set<string>;
}

function groupByKeywordSimilarity(
  corrections: CorrectionSignal[],
  similarityThreshold = 0.3,
): CorrectionGroup[] {
  const groups: CorrectionGroup[] = [];

  for (const signal of corrections) {
    const phrase = correctionTextOf(signal);
    if (!phrase) continue;
    const text = `${phrase} ${signal.context}`;
    const tokens = tokenize(text);

    let matched = false;
    for (const group of groups) {
      if (similarity(tokens, group.tokens) >= similarityThreshold) {
        group.signals.push(signal);
        group.sessions.add(signal.session_id);
        for (const t of tokens) group.tokens.add(t);
        matched = true;
        break;
      }
    }

    if (!matched) {
      groups.push({
        representative: phrase.slice(0, 200),
        tokens,
        signals: [signal],
        sessions: new Set([signal.session_id]),
      });
    }
  }

  return groups;
}

/**
 * Calculate severity from frequency, session spread, and recency.
 * Base 3 + log2(frequency) + session spread bonus + recency bonus. Capped at 10.
 */
function calculateSeverity(group: CorrectionGroup): number {
  const frequency = group.signals.length;
  const sessionCount = group.sessions.size;

  // Base severity + frequency contribution (log2 scale)
  let severity = 3 + Math.log2(Math.max(1, frequency));

  // Session spread: broad problems are more severe
  if (sessionCount > 5) severity += 1;

  // Recency: recent patterns more urgent
  const timestamps = group.signals.map((s) => new Date(s.timestamp).getTime());
  const mostRecent = Math.max(...timestamps);
  const daysSinceLastSeen = (Date.now() - mostRecent) / (1000 * 60 * 60 * 24);
  if (daysSinceLastSeen < 7) severity += 1;

  return Math.min(10, Math.round(severity));
}

function buildCandidateRule(group: CorrectionGroup): string {
  // Extract unique correction phrases, deduplicate by content
  const seen = new Set<string>();
  const uniquePhrases: string[] = [];
  for (const s of group.signals) {
    const phrase = correctionTextOf(s).trim().slice(0, 80);
    const normalized = phrase.toLowerCase().replace(/[^a-z0-9\s]/g, "");
    if (!seen.has(normalized)) {
      seen.add(normalized);
      uniquePhrases.push(phrase);
    }
    if (uniquePhrases.length >= 3) break;
  }

  // Extract context hints from surrounding assistant responses
  const contextHints: string[] = [];
  for (const s of group.signals.slice(0, 5)) {
    if (s.context) {
      const assistantLine = s.context.split("\n").find((l) => l.startsWith("Assistant:"));
      if (assistantLine) {
        const snippet = assistantLine.slice(11, 80).trim();
        if (snippet.length > 10 && !contextHints.includes(snippet)) {
          contextHints.push(snippet);
        }
      }
      if (contextHints.length >= 2) break;
    }
  }

  const triggers = uniquePhrases.join("; ");
  const contextSuffix = contextHints.length > 0
    ? ` Context: ${contextHints[0]}`
    : "";

  return `Recurring correction (${group.signals.length}x across ${group.sessions.size} sessions): ${triggers}.${contextSuffix}`;
}

export async function detectFailurePatterns(
  signalDir: string,
  threshold: number = DEFAULT_THRESHOLD,
): Promise<Pattern[]> {
  const corrections = (await readSignals(
    resolveSignalFile(signalDir, CORRECTIONS_FILE),
  )) as CorrectionSignal[];

  if (corrections.length === 0) return [];

  const groups = groupByKeywordSimilarity(corrections);
  const patterns: Pattern[] = [];

  for (const group of groups) {
    if (group.signals.length < threshold) continue;

    const sessions = [...group.sessions];
    const timestamps = group.signals.map((s) => s.timestamp).sort();

    patterns.push({
      id: `fail-${sessions[0].slice(0, 8)}-${patterns.length}`,
      type: "failure",
      frequency: group.signals.length,
      sessions,
      severity: calculateSeverity(group),
      candidateRule: buildCandidateRule(group),
      firstSeen: timestamps[0],
      lastSeen: timestamps[timestamps.length - 1],
    });
  }

  return patterns.sort((a, b) => b.frequency - a.frequency);
}
