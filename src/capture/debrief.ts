import { randomUUID } from "crypto";
import type { CorrectionSignal } from "../adapters/types";
import { SCHEMA_VERSION } from "../adapters/types";

export interface RuleCandidate {
  id: string;
  text: string;
  sourceSessions: string[];
  frequency: number;
  severity: number;
}

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

interface Turn {
  role: "user" | "assistant";
  text: string;
}

function parseTranscript(transcript: string): Turn[] {
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
          sessionId,
          schemaVersion: SCHEMA_VERSION,
          trigger: text.slice(0, 300),
          context: prevAssistant
            ? `User: ${text.slice(0, 150)}\nAssistant: ${prevAssistant.text.slice(0, 150)}`
            : text.slice(0, 300),
          severity,
        });
        break;
      }
    }
  }

  return corrections;
}

function groupByTheme(corrections: CorrectionSignal[]): Map<string, CorrectionSignal[]> {
  const themes = new Map<string, CorrectionSignal[]>();

  for (const correction of corrections) {
    const trigger = correction.trigger.toLowerCase();

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

export async function extractDebrief(
  transcript: string,
  sessionId: string,
): Promise<{ candidates: RuleCandidate[]; corrections: CorrectionSignal[] }> {
  const turns = parseTranscript(transcript);
  const corrections = detectCorrections(turns, sessionId);

  if (corrections.length === 0) {
    return { candidates: [], corrections: [] };
  }

  const themes = groupByTheme(corrections);
  const candidates: RuleCandidate[] = [];

  for (const [theme, group] of themes) {
    if (group.length === 0) continue;

    const avgSeverity =
      group.reduce((sum, c) => sum + c.severity, 0) / group.length;

    candidates.push({
      id: randomUUID(),
      text: `${theme}: ${group[0].trigger.slice(0, 100)}`,
      sourceSessions: [sessionId],
      frequency: group.length,
      severity: Math.round(avgSeverity),
    });
  }

  return { candidates, corrections };
}
