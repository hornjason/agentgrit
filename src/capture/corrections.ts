import { randomUUID } from "crypto";
import { appendSignal } from "../adapters/jsonl";
import { signalPath } from "../adapters/paths";
import type { CorrectionSignal } from "../adapters/types";
import { SCHEMA_VERSION } from "../adapters/types";

const CORRECTIONS_FILE = "corrections.jsonl";

const CORRECTION_PATTERNS: { pattern: RegExp; severity: number }[] = [
  { pattern: /\bno[,.]?\s+not\s+(?:like\s+)?that\b/i, severity: 7 },
  { pattern: /\bstop\s+doing\s+/i, severity: 8 },
  { pattern: /\bstop\s+(?!by\b|at\b|for\b|to\b|and\b|the\b|in\b)/i, severity: 6 },
  { pattern: /\bthat'?s\s+(?:not\s+what|wrong)/i, severity: 7 },
  { pattern: /\bi\s+didn'?t\s+ask\s+(?:for|you)/i, severity: 8 },
  { pattern: /\bdon'?t\s+do\s+that\b/i, severity: 7 },
  { pattern: /\bwrong\b(?!\s+(?:with|about|way)\s+(?:the|a|my|your))/i, severity: 6 },
  { pattern: /\bincorrect\b/i, severity: 6 },
  { pattern: /\bnot\s+(?:right|correct)\b/i, severity: 5 },
  { pattern: /\byou\s+missed\b/i, severity: 5 },
  { pattern: /\btoo\s+much\b/i, severity: 4 },
  { pattern: /\bbad\s+approach\b/i, severity: 7 },
];

const NOISE_PATTERNS: RegExp[] = [
  /\bno\s+problem\b/i,
  /\bno\s+worries\b/i,
  /\bno\s+rush\b/i,
  /\bno\s+need\b/i,
  /\bno\s+thanks\b/i,
  /\bno\s+big\s+deal\b/i,
  /\bnot\s+(?:yet|now|sure|necessarily)\b/i,
  /\bstop\s+(?:by|at|for|to|in)\b/i,
  /\bdon'?t\s+worry\b/i,
  /\bdon'?t\s+(?:forget|mind)\b/i,
];

function isNoise(message: string): boolean {
  return NOISE_PATTERNS.some((p) => p.test(message));
}

function extractContext(
  message: string,
  assistantResponse: string,
): string {
  const msgPreview = message.slice(0, 200);
  const respPreview = assistantResponse.slice(0, 200);
  return `User: ${msgPreview}\nAssistant: ${respPreview}`;
}

export async function detectCorrection(
  message: string,
  assistantResponse: string,
  sessionId: string,
): Promise<CorrectionSignal | null> {
  if (isNoise(message)) return null;

  for (const { pattern, severity } of CORRECTION_PATTERNS) {
    if (pattern.test(message)) {
      const signal: CorrectionSignal = {
        id: randomUUID(),
        type: "correction",
        timestamp: new Date().toISOString(),
        sessionId,
        schemaVersion: SCHEMA_VERSION,
        trigger: message.slice(0, 300),
        context: extractContext(message, assistantResponse),
        severity,
      };

      await appendSignal(signalPath(CORRECTIONS_FILE), signal);
      return signal;
    }
  }

  return null;
}
