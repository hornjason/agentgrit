/**
 * incidents.ts — Tool failure detection and session-end pattern analysis
 *
 * Consolidated from PAI hooks:
 *   - IncidentMonitor.hook.ts: detects tool failures from Bash output
 *   - IncidentPatternAnalyzer.hook.ts: groups incidents by error_type,
 *     proposes rules when same error appears 2+ times
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join, dirname } from "path";

// ── Types ──

export interface IncidentRecord {
  timestamp: string;
  session_id: string;
  error_snippet: string;
  error_type: string;
  command_preview: string;
}

export interface IncidentDetectResult {
  matched: boolean;
  errorType: string;
}

export interface PatternAnalysisResult {
  patternsFound: number;
  rulesProposed: number;
  incidentsRetained: number;
}

// ── Error patterns ──

const ERROR_PATTERNS: { pattern: RegExp; type: string }[] = [
  { pattern: /Exit code [^0\s]/, type: "non-zero-exit" },
  { pattern: /exit status [^0\s]/, type: "non-zero-exit" },
  { pattern: /returned non-zero/, type: "non-zero-exit" },
  { pattern: /TypeError/, type: "TypeError" },
  { pattern: /SyntaxError/, type: "SyntaxError" },
  { pattern: /Error:/, type: "Error" },
  { pattern: /error:/, type: "error" },
  { pattern: /\bFAILED\b/, type: "FAILED" },
  { pattern: /\bfailed\b/, type: "failed" },
  { pattern: /Exception/, type: "Exception" },
  { pattern: /Cannot find/, type: "Cannot find" },
  { pattern: /not found/, type: "not found" },
  { pattern: /permission denied/i, type: "permission denied" },
];

const FALSE_POSITIVE_PATTERNS: RegExp[] = [/no changes/i, /0 errors/];

// ── Detection ──

export function detectError(output: string): IncidentDetectResult {
  for (const fp of FALSE_POSITIVE_PATTERNS) {
    if (fp.test(output)) return { matched: false, errorType: "" };
  }

  for (const { pattern, type } of ERROR_PATTERNS) {
    if (pattern.test(output)) return { matched: true, errorType: type };
  }

  return { matched: false, errorType: "" };
}

// ── Record management ──

export function recordIncident(
  incidentsPath: string,
  record: IncidentRecord,
): void {
  const dir = dirname(incidentsPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(incidentsPath, JSON.stringify(record) + "\n", "utf8");
}

export function parseIncidents(raw: string): IncidentRecord[] {
  const records: IncidentRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as IncidentRecord);
    } catch {
      // skip malformed
    }
  }
  return records;
}

// ── Monitor entry point (called per Bash tool output) ──

export function monitorToolOutput(
  output: string,
  command: string,
  sessionId: string,
  incidentsPath: string,
): IncidentRecord | null {
  if (!output) return null;

  const { matched, errorType } = detectError(output);
  if (!matched) return null;

  const record: IncidentRecord = {
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    error_snippet: output.slice(0, 200),
    error_type: errorType,
    command_preview: command.slice(0, 80),
  };

  recordIncident(incidentsPath, record);
  return record;
}

// ── Pattern analysis (called at session end) ──

export function analyzeSessionPatterns(
  incidentsPath: string,
  pendingRulesPath: string,
  sessionId: string,
  retentionDays: number = 14,
): PatternAnalysisResult {
  const result: PatternAnalysisResult = {
    patternsFound: 0,
    rulesProposed: 0,
    incidentsRetained: 0,
  };

  if (!existsSync(incidentsPath)) return result;

  let allIncidents: IncidentRecord[];
  try {
    allIncidents = parseIncidents(readFileSync(incidentsPath, "utf8"));
  } catch {
    return result;
  }

  const sessionIncidents = allIncidents.filter(
    (r) => r.session_id === sessionId,
  );

  // Prune old entries
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const retained = allIncidents.filter((r) => {
    try {
      return new Date(r.timestamp) >= cutoff;
    } catch {
      return true;
    }
  });

  result.incidentsRetained = retained.length;

  // Rewrite with retained entries
  const dir = dirname(incidentsPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    incidentsPath,
    retained.map((r) => JSON.stringify(r)).join("\n") +
      (retained.length > 0 ? "\n" : ""),
    "utf8",
  );

  if (sessionIncidents.length < 2) return result;

  // Group by error_type
  const typeCounts = new Map<string, number>();
  for (const incident of sessionIncidents) {
    typeCounts.set(
      incident.error_type,
      (typeCounts.get(incident.error_type) ?? 0) + 1,
    );
  }

  const patterns = [...typeCounts.entries()].filter(([, count]) => count >= 2);
  result.patternsFound = patterns.length;

  if (patterns.length === 0) return result;

  // Check existing rules for dedup
  let existingRules = "";
  try {
    if (existsSync(pendingRulesPath)) {
      existingRules = readFileSync(pendingRulesPath, "utf8");
    }
  } catch {
    // proceed
  }

  const today = new Date().toISOString().slice(0, 10);
  const sessionShort = sessionId.slice(0, 8);

  for (const [errorType, count] of patterns) {
    if (
      existingRules.includes("incident-pattern") &&
      existingRules.includes(errorType)
    ) {
      continue;
    }

    const proposal = [
      "",
      `## [PROPOSED - ${today}] incident-pattern-${errorType}`,
      `When "${errorType}" errors appear 2+ times in a session, investigate root cause before retrying.`,
      `Pattern detected: ${count} occurrences in session ${sessionShort}`,
      "",
    ].join("\n");

    const rulesDir = dirname(pendingRulesPath);
    if (!existsSync(rulesDir)) mkdirSync(rulesDir, { recursive: true });
    appendFileSync(pendingRulesPath, proposal, "utf8");
    result.rulesProposed++;
  }

  return result;
}
