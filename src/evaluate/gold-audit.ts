import type { GoldSession, GoldSet } from "./gold";

export interface AuditRule {
  id: string;
  text: string;
  rank: number;
}

export interface AuditSession {
  sessionId: string;
  taskDescription: string;
  domains: string[];
  rules: AuditRule[];
}

export interface ParsedAuditSession {
  sessionId: string;
  taskDescription: string;
  relevantRules: string[];
  excludedRules: string[];
}

export function formatAuditSession(session: AuditSession): string {
  const lines: string[] = [];
  lines.push(`=== Session: ${session.sessionId} ===`);
  lines.push(`Task: "${session.taskDescription}"`);
  lines.push(`Domains detected: [${session.domains.join(", ")}]`);
  lines.push("");

  if (session.rules.length === 0) {
    lines.push("Retrieved rules: (no rules retrieved)");
  } else {
    lines.push("Retrieved rules (top 15):");
    for (const rule of session.rules) {
      lines.push(`  ${rule.rank}. ${rule.id}`);
      lines.push(`     "${rule.text}"`);
      lines.push(`     Relevant? [ ]`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

export function formatAuditReport(sessions: AuditSession[]): string {
  const lines: string[] = [];
  lines.push("# Gold Set Audit Report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Sessions: ${sessions.length}`);
  lines.push("");
  lines.push("Instructions: Mark rules as relevant by changing [ ] to [x].");
  lines.push("Then run: agentgrit eval gold apply --file <this-file>");
  lines.push("");

  for (const session of sessions) {
    lines.push(formatAuditSession(session));
    lines.push("");
  }

  return lines.join("\n");
}

export function parseAuditFile(content: string): ParsedAuditSession[] {
  const sessions: ParsedAuditSession[] = [];
  const sessionBlocks = content.split(/(?==== Session:)/);

  for (const block of sessionBlocks) {
    const sessionMatch = block.match(/=== Session:\s*(\S+)\s*===/);
    if (!sessionMatch) continue;

    const sessionId = sessionMatch[1];
    const taskMatch = block.match(/Task:\s*"([^"]+)"/);
    const taskDescription = taskMatch?.[1] ?? "";

    const relevantRules: string[] = [];
    const excludedRules: string[] = [];

    const rulePattern = /^\s*\d+\.\s+(\S+)\s*$/gm;
    const checkPattern = /Relevant\?\s*\[(x| )\]/gi;

    const ruleIds: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = rulePattern.exec(block)) !== null) {
      ruleIds.push(m[1]);
    }

    const checks: boolean[] = [];
    while ((m = checkPattern.exec(block)) !== null) {
      checks.push(m[1].toLowerCase() === "x");
    }

    for (let i = 0; i < ruleIds.length; i++) {
      const checked = checks[i] ?? false;
      if (checked) {
        relevantRules.push(ruleIds[i]);
      } else {
        excludedRules.push(ruleIds[i]);
      }
    }

    sessions.push({ sessionId, taskDescription, relevantRules, excludedRules });
  }

  return sessions;
}

export function buildGoldSetFromAudit(parsed: ParsedAuditSession[]): GoldSet {
  const labeled: Record<string, GoldSession> = {};

  for (const session of parsed) {
    labeled[session.sessionId] = {
      sessionId: session.sessionId,
      description: session.taskDescription,
      relevantRules: session.relevantRules,
      excluded_rules: session.excludedRules,
      autoLabeled: false,
    };
  }

  return {
    labeled,
    totalLabeled: Object.keys(labeled).length,
    updated: new Date().toISOString(),
  };
}
