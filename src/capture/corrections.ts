/**
 * corrections.ts - Unified correction, failure, assertion audit, and work learning capture
 *
 * Consolidates:
 * - FailureCapture.ts: captureFailure() — analyzes surrounding turns for context,
 *   classifies failure severity, extracts root cause signals from transcript data
 * - NegativeAssertionAudit.hook.ts: auditAssertions() — detects unverified negative
 *   claims ("can't", "doesn't exist", "not possible") without evidence markers
 * - WorkCompletionLearning.hook.ts: extractWorkLearnings() — pulls learnings from
 *   completed work (what worked, what didn't, follow-ups)
 */

import { randomUUID } from "crypto";
import { appendSignal } from "../adapters/jsonl";
import { signalPath } from "../adapters/paths";
import type { CorrectionSignal } from "../adapters/types";
import { SCHEMA_VERSION } from "../adapters/types";

const CORRECTIONS_FILE = "corrections.jsonl";

// ── Correction detection patterns ──

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

// ── Negative assertion audit patterns (from NegativeAssertionAudit) ──

const NEGATIVE_ASSERTION_PATTERNS: RegExp[] = [
  /can'?t (?:run|access|connect|reach|execute|scrape|use) (?:from |on |locally|here)/i,
  /only (?:works?|runs?|available) (?:on|from|in|at) /i,
  /not possible (?:from|on|to run|to access)/i,
  /(?:requires?|needs?) .{3,40} (?:to run|to work|to access|to scrape)/i,
  /(?:won'?t|cannot|unable to) (?:work|run|execute|connect) (?:from|on|here|locally)/i,
  /no (?:way to|ability to) (?:run|access|connect|scrape) /i,
  /(?:doesn'?t|does not) (?:have|support) .{3,30} (?:auth|access|session|credentials)/i,
];

const EVIDENCE_MARKERS: RegExp[] = [
  /(?:error|Error|ERROR):/,
  /(?:tried|attempted|ran|executed) (?:it|the|and)/i,
  /(?:verified|confirmed|checked) (?:that|by|with)/i,
  /(?:output|result|response) (?:shows?|was|is|returned)/i,
  /exit (?:code|status) \d/i,
  /actually (?:got|received|saw|returned)/i,
  /the (?:actual|real) (?:error|issue|problem|blocker)/i,
  /here'?s? (?:what|the error)/i,
  /stack ?trace/i,
  /failed (?:with|because)/i,
];

// ── Learning classification patterns (from WorkCompletionLearning) ──

const WORK_LEARNING_PATTERNS = {
  approach: [
    /over.?engineer/i,
    /wrong approach/i,
    /should have asked/i,
    /didn't follow/i,
    /missed the point/i,
    /too complex/i,
  ],
  tooling: [
    /hook|crash|broken/i,
    /tool|config|deploy|path/i,
    /import|module|file.*not.*found/i,
  ],
};

// ── Types ──

export interface FailureContext {
  rating: number;
  sentimentSummary: string;
  detailedContext?: string;
  conversationSnippets?: { role: string; content: string }[];
  toolNames?: string[];
  sessionId: string;
}

export interface FailureSignal {
  id: string;
  type: "failure";
  timestamp: string;
  session_id: string;
  rating: number;
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  context: string;
  toolsUsed: string[];
}

export interface AssertionViolation {
  phrase: string;
  hasEvidence: boolean;
}

export interface AssertionAuditResult {
  violations: AssertionViolation[];
  sessionId: string;
  timestamp: string;
}

export interface WorkLearning {
  id: string;
  category: "approach" | "tooling" | "general";
  title: string;
  filesChanged: number;
  toolsUsed: string[];
  insights: string[];
  timestamp: string;
}

// ── Noise filter ──

function isNoise(message: string): boolean {
  return NOISE_PATTERNS.some((p) => p.test(message));
}

// ── Context extraction ──

function extractContext(
  message: string,
  assistantResponse: string,
): string {
  const msgPreview = message.slice(0, 200);
  const respPreview = assistantResponse.slice(0, 200);
  return `User: ${msgPreview}\nAssistant: ${respPreview}`;
}

// ── Detect correction from a single user message ──

export async function detectCorrection(
  message: string,
  assistantResponse: string,
  sessionId: string,
): Promise<CorrectionSignal | null> {
  if (isNoise(message)) return null;

  for (const { pattern } of CORRECTION_PATTERNS) {
    if (pattern.test(message)) {
      const signal: CorrectionSignal = {
        id: randomUUID(),
        type: "correction",
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        schemaVersion: SCHEMA_VERSION,
        correction_phrase: message.slice(0, 300),
        context: extractContext(message, assistantResponse),
      };

      await appendSignal(signalPath(CORRECTIONS_FILE), signal);
      return signal;
    }
  }

  return null;
}

// ── Failure capture (from FailureCapture.ts) ──

function classifySeverity(rating: number): "low" | "medium" | "high" | "critical" {
  if (rating <= 1) return "critical";
  if (rating <= 2) return "high";
  if (rating <= 3) return "medium";
  return "low";
}

export function captureFailure(input: FailureContext): FailureSignal | null {
  if (input.rating > 3) return null;

  const severity = classifySeverity(input.rating);

  // Build context from conversation snippets
  let contextText = input.detailedContext || "";
  if (input.conversationSnippets && input.conversationSnippets.length > 0) {
    const snippetText = input.conversationSnippets
      .slice(-10)
      .map((s) => `${s.role.toUpperCase()}: ${s.content.slice(0, 500)}`)
      .join("\n\n");
    contextText = contextText
      ? `${contextText}\n\n---\n\n${snippetText}`
      : snippetText;
  }

  return {
    id: randomUUID(),
    type: "failure",
    timestamp: new Date().toISOString(),
    session_id: input.sessionId,
    rating: input.rating,
    severity,
    summary: input.sentimentSummary,
    context: contextText.slice(0, 2000),
    toolsUsed: input.toolNames ?? [],
  };
}

// ── Negative assertion audit (from NegativeAssertionAudit.hook.ts) ──

export function auditAssertions(
  assistantMessage: string,
  sessionId: string,
): AssertionAuditResult {
  const violations: AssertionViolation[] = [];

  if (!assistantMessage || assistantMessage.length < 20) {
    return { violations, sessionId, timestamp: new Date().toISOString() };
  }

  // Split into sentences for context-aware matching
  const sentences = assistantMessage
    .split(/[.!?\n]+/)
    .filter((s) => s.trim().length > 10);

  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i];

    const hasNegative = NEGATIVE_ASSERTION_PATTERNS.some((p) => p.test(sentence));
    if (!hasNegative) continue;

    // Check sentence itself for evidence
    const hasEvidence = EVIDENCE_MARKERS.some((p) => p.test(sentence));
    if (hasEvidence) {
      violations.push({ phrase: sentence.trim().slice(0, 200), hasEvidence: true });
      continue;
    }

    // Check surrounding context (2 sentences before/after)
    const context = sentences
      .slice(Math.max(0, i - 2), i + 3)
      .join(" ");
    const contextHasEvidence = EVIDENCE_MARKERS.some((p) => p.test(context));

    if (!contextHasEvidence) {
      violations.push({ phrase: sentence.trim().slice(0, 200), hasEvidence: false });
    }
  }

  return {
    violations,
    sessionId,
    timestamp: new Date().toISOString(),
  };
}

// ── Work completion learning extraction (from WorkCompletionLearning.hook.ts) ──

function classifyWorkCategory(
  title: string,
  toolsUsed: string[],
): "approach" | "tooling" | "general" {
  const text = `${title} ${toolsUsed.join(" ")}`.toLowerCase();

  for (const pattern of WORK_LEARNING_PATTERNS.approach) {
    if (pattern.test(text)) return "approach";
  }
  for (const pattern of WORK_LEARNING_PATTERNS.tooling) {
    if (pattern.test(text)) return "tooling";
  }

  return "general";
}

export function extractWorkLearnings(opts: {
  title: string;
  filesChanged: string[];
  toolsUsed: string[];
  agentsSpawned: string[];
  sessionId: string;
  duration?: string;
}): WorkLearning | null {
  // Only capture if significant work happened
  const hasSignificantWork =
    opts.filesChanged.length > 0 ||
    opts.toolsUsed.length > 5 ||
    opts.agentsSpawned.length > 0;

  if (!hasSignificantWork) return null;

  const category = classifyWorkCategory(opts.title, opts.toolsUsed);

  // Generate insights based on work characteristics
  const insights: string[] = [];
  if (opts.filesChanged.length > 5) {
    insights.push(`Touched ${opts.filesChanged.length} files — review if scope was appropriate`);
  }
  if (opts.agentsSpawned.length > 0) {
    insights.push(`Spawned ${opts.agentsSpawned.length} agent(s): ${opts.agentsSpawned.slice(0, 5).join(", ")}`);
  }
  if (opts.toolsUsed.length > 10) {
    insights.push(`Heavy tool usage (${opts.toolsUsed.length} calls) — check for iteration loops`);
  }
  if (opts.duration) {
    insights.push(`Session duration: ${opts.duration}`);
  }

  return {
    id: randomUUID(),
    category,
    title: opts.title,
    filesChanged: opts.filesChanged.length,
    toolsUsed: [...new Set(opts.toolsUsed)].slice(0, 20),
    insights,
    timestamp: new Date().toISOString(),
  };
}
