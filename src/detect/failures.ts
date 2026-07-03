import { join } from "path";
import { readSignals } from "../adapters/jsonl";
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

interface CorrectionGroup {
  representative: string;
  tokens: Set<string>;
  signals: CorrectionSignal[];
  sessions: Set<string>;
  maxSeverity: number;
}

function groupByKeywordSimilarity(
  corrections: CorrectionSignal[],
  similarityThreshold = 0.3,
): CorrectionGroup[] {
  const groups: CorrectionGroup[] = [];

  for (const signal of corrections) {
    const text = `${signal.correction_phrase} ${signal.context}`;
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
        representative: signal.correction_phrase.slice(0, 200),
        tokens,
        signals: [signal],
        sessions: new Set([signal.session_id]),
        maxSeverity: 5,
      });
    }
  }

  return groups;
}

function buildCandidateRule(group: CorrectionGroup): string {
  const triggers = group.signals
    .slice(0, 3)
    .map((s) => s.correction_phrase.slice(0, 80))
    .join("; ");
  return `Recurring correction (${group.signals.length}x): ${triggers}`;
}

export async function detectFailurePatterns(
  signalDir: string,
  threshold: number = DEFAULT_THRESHOLD,
): Promise<Pattern[]> {
  const corrections = (await readSignals(
    join(signalDir, CORRECTIONS_FILE),
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
      severity: group.maxSeverity,
      candidateRule: buildCandidateRule(group),
      firstSeen: timestamps[0],
      lastSeen: timestamps[timestamps.length - 1],
    });
  }

  return patterns.sort((a, b) => b.frequency - a.frequency);
}
