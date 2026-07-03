import { appendSignal } from "../adapters/jsonl";
import { signalPath } from "../adapters/paths";
import { SCHEMA_VERSION } from "../adapters/types";
import { randomUUID } from "crypto";
import type { AnySignal } from "../adapters/types";

const TOOL_AUDIT_FILE = "tool-audit.jsonl";

interface ToolAuditEntry {
  id: string;
  type: "tool-audit";
  timestamp: string;
  session_id: string;
  schemaVersion: number;
  toolName: string;
  argsSummary: string;
}

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

export async function captureToolUse(
  toolName: string,
  args: Record<string, unknown>,
  sessionId: string,
): Promise<void> {
  const entry: ToolAuditEntry = {
    id: randomUUID(),
    type: "tool-audit",
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    schemaVersion: SCHEMA_VERSION,
    toolName,
    argsSummary: summarizeArgs(args),
  };

  await appendSignal(
    signalPath(TOOL_AUDIT_FILE),
    entry as unknown as AnySignal,
  );
}
