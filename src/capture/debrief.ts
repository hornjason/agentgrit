/**
 * debrief.ts - Session-end extraction of correction and approval signals
 *
 * Consolidates:
 * - AutoDebrief.hook.ts: Full transcript analysis that extracts correction and
 *   approval moments from every session. Feeds the learning pipeline with raw
 *   behavioral data that weekly review can promote into hard rules.
 *
 * Key capabilities:
 * - Transcript parsing (JSONL format with user/assistant turns)
 * - Correction phrase detection with noise filtering
 * - Approval signal detection
 * - Reprompt detection via word overlap analysis
 * - Theme-based grouping of corrections into rule candidates
 */

import { randomUUID } from "crypto";
import type { CorrectionSignal } from "../adapters/types";
import { SCHEMA_VERSION } from "../adapters/types";

// ── Types ──

export interface RuleCandidate {
  id: string;
  text: string;
  sourceSessions: string[];
  frequency: number;
  severity: number;
}

export interface DebriefResult {
  candidates: RuleCandidate[];
  corrections: CorrectionSignal[];
  approvals: ApprovalSignal[];
  reprompts: number;
}

export interface ApprovalSignal {
  phrase: string;
  context: string;
  turnIndex: number;
}

// ── Phrase lists ──

const CORRECTION_PHRASES: { phrase: RegExp; severity: number }[] = [
  { phrase: /\bno[,.]?\s+not\s+(?:like\s+)?that\b/i, severity: 7 },
  { phrase: /\bstop\s+doing\s+/i, severity: 8 },
  { phrase: /\bstop\b(?!\s+(?:by|at|for|to|and|the|in)\b)/i, severity: 6 },
  { phrase: /\bthat'?s\s+(?:not\s+what|wrong)/i, severity: 7 },
  { phrase: /\bi\s+didn'?t\s+ask/i, severity: 8 },
  { phrase: /\bdon'?t\s+do\s+that\b/i, severity: 7 },
  { phrase: /\bwrong\b/i, severity: 6 },
  { phrase: /\bincorrect\b/i, severity: 6 },
  { phrase: /\bnot\s+(?:right|correct)\b/i, severity: 5 },
  { phrase: /\byou\s+missed\b/i, severity: 5 },
  { phrase: /\btoo\s+much\b/i, severity: 4 },
  { phrase: /\bbad\s+approach\b/i, severity: 7 },
];

const NOISE_FILTER: RegExp[] = [
  /\bno\s+problem\b/i,
  /\bno\s+worries\b/i,
  /\bno\s+rush\b/i,
  /\bno\s+need\b/i,
  /\bno\s+thanks\b/i,
  /\bnot\s+(?:yet|now|sure|necessarily)\b/i,
  /\bdon'?t\s+worry\b/i,
  /\bdon'?t\s+(?:forget|mind)\b/i,
];

const APPROVAL_PHRASES = [
  "perfect",
  "yes exactly",
  "great work",
  "love it",
  "keep doing that",
  "nice",
  "that's right",
  "excellent",
  "well done",
  "nailed it",
  "go for it",
];

// ── Turn type ──

interface Turn {
  role: "user" | "assistant";
  text: string;
}

// ── Transcript parsing ──

export function parseTranscript(transcript: string): Turn[] {
  const turns: Turn[] = [];
  const lines = transcript.split("\n").filter((l) => l.trim());

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "user" && entry.message?.content) {
        const text =
          typeof entry.message.content === "string"
            ? entry.message.content
            : Array.isArray(entry.message.content)
              ? entry.message.content
                  .filter((c: { type: string }) => c.type === "text")
                  .map((c: { text: string }) => c.text)
                  .join(" ")
              : "";
        if (text.trim()) turns.push({ role: "user", text: text.trim() });
      } else if (entry.type === "assistant" && entry.message?.content) {
        const text =
          typeof entry.message.content === "string"
            ? entry.message.content
            : Array.isArray(entry.message.content)
              ? entry.message.content
                  .filter((c: { type: string }) => c.type === "text")
                  .map((c: { text: string }) => c.text)
                  .join(" ")
              : "";
        if (text.trim()) turns.push({ role: "assistant", text: text.trim() });
      }
    } catch {
      // skip malformed lines
    }
  }

  return turns;
}

// ── Correction detection ──

function detectCorrections(
  turns: Turn[],
  sessionId: string,
): CorrectionSignal[] {
  const corrections: CorrectionSignal[] = [];
  const userTurns = turns.filter((t) => t.role === "user");

  for (let i = 0; i < userTurns.length; i++) {
    const text = userTurns[i].text;
    if (NOISE_FILTER.some((p) => p.test(text))) continue;

    for (const { phrase, severity } of CORRECTION_PHRASES) {
      if (phrase.test(text)) {
        const prevAssistant = turns
          .filter((t) => t.role === "assistant")
          .slice(0, i + 1)
          .pop();

        corrections.push({
          id: randomUUID(),
          type: "correction",
          timestamp: new Date().toISOString(),
          session_id: sessionId,
          schemaVersion: SCHEMA_VERSION,
          correction_phrase: text.slice(0, 300),
          context: prevAssistant
            ? `User: ${text.slice(0, 150)}\nAssistant: ${prevAssistant.text.slice(0, 150)}`
            : text.slice(0, 300),
          turn_index: i,
        });
        break;
      }
    }
  }

  return corrections;
}

// ── Approval detection (from AutoDebrief) ──

function detectApprovals(turns: Turn[]): ApprovalSignal[] {
  const approvals: ApprovalSignal[] = [];
  const userTurns = turns.filter((t) => t.role === "user");

  for (let i = 0; i < userTurns.length; i++) {
    const lowerText = userTurns[i].text.toLowerCase();

    for (const phrase of APPROVAL_PHRASES) {
      if (lowerText.includes(phrase)) {
        const phraseIdx = lowerText.indexOf(phrase);
        const context = userTurns[i].text
          .slice(Math.max(0, phraseIdx - 80), phraseIdx)
          .trim();

        approvals.push({
          phrase,
          context,
          turnIndex: i,
        });
        break;
      }
    }
  }

  return approvals;
}

// ── Reprompt detection via word overlap ──

function detectReprompts(turns: Turn[]): number {
  const userTexts = turns
    .filter((t) => t.role === "user")
    .map((t) => t.text);

  let reprompts = 0;
  const maxPairs = Math.min(userTexts.length - 1, 50);

  for (let i = 0; i < maxPairs; i++) {
    const wordsA = new Set(
      userTexts[i].toLowerCase().split(/\s+/).filter((w) => w.length > 2),
    );
    const wordsB = new Set(
      userTexts[i + 1].toLowerCase().split(/\s+/).filter((w) => w.length > 2),
    );
    if (wordsA.size === 0 || wordsB.size === 0) continue;

    let overlap = 0;
    for (const word of wordsA) {
      if (wordsB.has(word)) overlap++;
    }

    const ratio = overlap / Math.min(wordsA.size, wordsB.size);
    if (ratio > 0.6) reprompts++;
  }

  return reprompts;
}

// ── Theme grouping ──

function groupByTheme(
  corrections: CorrectionSignal[],
): Map<string, CorrectionSignal[]> {
  const themes = new Map<string, CorrectionSignal[]>();

  for (const correction of corrections) {
    const trigger = correction.correction_phrase.toLowerCase();

    let theme: string;
    if (/stop|don'?t/.test(trigger)) {
      theme = "behavioral-correction";
    } else if (/wrong|incorrect|not right/.test(trigger)) {
      theme = "accuracy-error";
    } else if (/missed|too much|didn'?t ask/.test(trigger)) {
      theme = "scope-mismatch";
    } else {
      theme = "general-correction";
    }

    const group = themes.get(theme) ?? [];
    group.push(correction);
    themes.set(theme, group);
  }

  return themes;
}

// ── Main debrief extraction ──

export async function extractDebrief(
  transcript: string,
  sessionId: string,
): Promise<DebriefResult> {
  const turns = parseTranscript(transcript);
  const corrections = detectCorrections(turns, sessionId);
  const approvals = detectApprovals(turns);
  const reprompts = detectReprompts(turns);

  if (corrections.length === 0 && approvals.length === 0) {
    return { candidates: [], corrections: [], approvals: [], reprompts };
  }

  const themes = groupByTheme(corrections);
  const candidates: RuleCandidate[] = [];

  for (const [theme, group] of themes) {
    if (group.length === 0) continue;

    candidates.push({
      id: randomUUID(),
      text: `${theme}: ${group[0].correction_phrase.slice(0, 100)}`,
      sourceSessions: [sessionId],
      frequency: group.length,
      severity: group.length >= 3 ? 7 : group.length >= 2 ? 5 : 3,
    });
  }

  return { candidates, corrections, approvals, reprompts };
}
