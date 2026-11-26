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
        const text = textOf(entry).replace(SYSTEM_REMINDER, "").trim();
        if (!text) continue;
        lastUserText = text;
        if (isHuman(entry)) lastHuman = text;
        turn = [];
      } else {
        const text = textOf(entry).trim();
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
