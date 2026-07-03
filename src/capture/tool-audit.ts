/**
 * tool-audit.ts - Tool usage audit logging with rotation and categorization
 *
 * Consolidates:
 * - ToolAudit.hook.ts: Minimal hot-path logger recording every tool call as
 *   JSONL. Adds signal rotation when file exceeds size threshold, structured
 *   tool categorization by type, and error/ok tracking from tool responses.
 */

import { appendSignal, rotateFile } from "../adapters/jsonl";
import { signalPath } from "../adapters/paths";
import { SCHEMA_VERSION } from "../adapters/types";
import { randomUUID } from "crypto";
import type { AnySignal } from "../adapters/types";

const TOOL_AUDIT_FILE = "tool-audit.jsonl";
const MAX_AUDIT_SIZE_BYTES = 5 * 1024 * 1024; // 5MB rotation threshold

// ── Tool categories ──

export type ToolCategory =
  | "file-read"
  | "file-write"
  | "shell"
  | "search"
  | "skill"
  | "agent"
  | "mcp"
  | "web"
  | "notebook"
  | "other";

const TOOL_CATEGORY_MAP: Record<string, ToolCategory> = {
  Read: "file-read",
  Write: "file-write",
  Edit: "file-write",
  NotebookEdit: "file-write",
  Bash: "shell",
  WebSearch: "search",
  WebFetch: "web",
  Skill: "skill",
  Agent: "agent",
};

// ── Types ──

export interface ToolAuditEntry {
  id: string;
  type: "tool-audit";
  timestamp: string;
  session_id: string;
  schemaVersion: number;
  toolName: string;
  category: ToolCategory;
  ok: boolean;
  argsSummary: string;
}

// ── Tool categorization ──

export function categorizeToolName(toolName: string): ToolCategory {
  if (TOOL_CATEGORY_MAP[toolName]) {
    return TOOL_CATEGORY_MAP[toolName];
  }
  // MCP tools typically have double underscores
  if (toolName.startsWith("mcp__") || toolName.includes("__")) {
    return "mcp";
  }
  return "other";
}

// ── Args summarization ──

function summarizeArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return "{}";

  const parts: string[] = [];
  for (const key of keys.slice(0, 5)) {
    const val = args[key];
    if (typeof val === "string") {
      parts.push(`${key}: "${val.slice(0, 50)}${val.length > 50 ? "..." : ""}"`);
    } else if (typeof val === "number" || typeof val === "boolean") {
      parts.push(`${key}: ${val}`);
    } else {
      parts.push(`${key}: [${typeof val}]`);
    }
  }

  if (keys.length > 5) {
    parts.push(`...+${keys.length - 5} more`);
  }

  return `{${parts.join(", ")}}`;
}

// ── Capture tool use ──

export async function captureToolUse(
  toolName: string,
  args: Record<string, unknown>,
  sessionId: string,
  opts?: { isError?: boolean },
): Promise<void> {
  const entry: ToolAuditEntry = {
    id: randomUUID(),
    type: "tool-audit",
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    schemaVersion: SCHEMA_VERSION,
    toolName,
    category: categorizeToolName(toolName),
    ok: opts?.isError !== true,
    argsSummary: summarizeArgs(args),
  };

  const filePath = signalPath(TOOL_AUDIT_FILE);

  // Rotate if file too large
  await rotateFile(filePath, MAX_AUDIT_SIZE_BYTES);

  await appendSignal(filePath, entry as unknown as AnySignal);
}

// ── Capture minimal tool audit (from ToolAudit.hook.ts hot path) ──

export interface MinimalToolAudit {
  ts: string;
  tool: string;
  ok: boolean;
  category: ToolCategory;
}

export function buildMinimalAudit(
  toolName: string,
  isError: boolean,
): MinimalToolAudit {
  return {
    ts: new Date().toISOString(),
    tool: toolName,
    ok: !isError,
    category: categorizeToolName(toolName),
  };
}
