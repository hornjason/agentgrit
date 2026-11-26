/**
 * The exchange a rating refers to, read from the session transcript (#324).
 *
 * Ratings rows carry a session id and a timestamp. Since 2026-10-02 they carry
 * no reply text at all (thumbs rows), so the judge's input and output both have
 * to come from the transcript: the last assistant reply at or before the
 * rating, and the last message the human typed before that reply.
 */
import { createReadStream, existsSync, readdirSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";

export interface RatedExchange {
  input: string;
  output: string;
}

type Block = { type?: string; text?: string };
type Entry = {
  type?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  promptSource?: string;
  origin?: { kind?: string } | string;
  message?: { content?: string | Block[] };
};

const SESSION_ID = /^[\w-]+$/;
/** The judge prompt keeps 4000 characters of output; trimming here keeps the END of a long turn instead of its start. */
export const MAX_REPLY_CHARS = 3900;
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/**
 * Credential shapes that show up in pasted messages and echoed replies. The
 * exchange is sent to an external judge, so these never leave the machine.
 * Deliberately no generic long-base64 rule: it would also eat 40-char git SHAs.
 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g,               // Anthropic / OpenAI
  /\bAIza[0-9A-Za-z_-]{30,}/g,                        // Google API key
  /\bya29\.[0-9A-Za-z._-]{10,}/g,                     // Google OAuth access token
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,                  // Slack
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,                    // AWS access key id
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /\b(Bearer)\s+[A-Za-z0-9._~+\/-]{16,}=*/gi,
  /\b((?:api[_-]?key|secret|password|passwd|token|client[_-]?secret)\s*[:=]\s*)["']?[^\s"']{6,}/gi,
];

function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    // A capture group, when the pattern has one, is the label to keep ("Bearer", "password=").
    out = out.replace(re, (_m, keep?: unknown) => (typeof keep === "string" ? `${keep}${/[\s:=]$/.test(keep) ? "" : " "}[REDACTED]` : "[REDACTED]"));
  }
  return out;
}

/** `<root>/<id>.jsonl` or `<root>/<project>/<id>.jsonl` under the first root that has it. */
export function findTranscript(sessionId: string, roots: string[]): string | null {
  if (!SESSION_ID.test(sessionId)) return null;
  const file = `${sessionId}.jsonl`;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const direct = join(root, file);
    if (existsSync(direct)) return direct;
    let dirs: string[];
    try { dirs = readdirSync(root); } catch { continue; }
    for (const d of dirs) {
      const p = join(root, d, file);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function textOf(entry: Entry): string {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  if (content.some((b) => b?.type === "tool_result")) return "";
  return content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}

function isHuman(entry: Entry): boolean {
  const kind = typeof entry.origin === "object" ? entry.origin?.kind : entry.origin;
  return kind === "human" || entry.promptSource === "typed" || entry.promptSource === "queued";
}

export async function ratedExchange(transcriptPath: string, ratedAt: string): Promise<RatedExchange | null> {
  const at = Date.parse(ratedAt);
  if (Number.isNaN(at) || !existsSync(transcriptPath)) return null;

  let lastHuman: string | null = null;
  let lastUserText: string | null = null;
  let turn: string[] = [];
  let pair: RatedExchange | null = null;

  const stream = createReadStream(transcriptPath, { encoding: "utf-8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry: Entry;
      try { entry = JSON.parse(line) as Entry; } catch { continue; }
      if (entry.type !== "user" && entry.type !== "assistant") continue;
      const ts = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
      if (Number.isNaN(ts)) continue;
      if (ts > at) break;
      if (entry.isSidechain) continue;

      if (entry.type === "user") {
        if (entry.isCompactSummary || entry.isMeta) continue;
        const text = redactSecrets(textOf(entry).replace(SYSTEM_REMINDER, "")).trim();
        if (!text) continue;
        lastUserText = text;
        if (isHuman(entry)) lastHuman = text;
        turn = [];
      } else {
        const text = redactSecrets(textOf(entry)).trim();
        if (!text) continue;
        turn.push(text);
        const whole = turn.join("\n\n");
        const output = whole.length > MAX_REPLY_CHARS ? `…${whole.slice(-MAX_REPLY_CHARS)}` : whole;
        pair = { input: lastHuman ?? lastUserText ?? "", output };
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return pair;
}
