import { createReadStream } from "fs";
import { createInterface } from "readline";

export interface ExtractedTask {
  text: string;
  source: "issue-ref" | "git-context" | "substantive-message" | "first-message";
  confidence: number;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
        return String(block.text);
      }
    }
  }
  return "";
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

const ACK_PREFIXES = [
  "yes", "no", "sure", "ok", "right", "yeah", "yep", "nah",
  "another claude session", "got it", "go ahead", "do it",
  "sounds good", "let's go", "proceed", "continue",
];

const GARBAGE_PREFIXES = [
  "context:",
  "<local-command-caveat>",
  "analyze these source file changes",
];

const ACTION_VERBS = [
  "fix", "add", "build", "ship", "create", "implement", "debug",
  "investigate", "refactor", "update", "remove", "deploy", "migrate",
  "test", "review", "configure", "optimize", "replace", "wire",
  "integrate", "delete", "merge", "rewrite", "extract", "move",
];

const ISSUE_REF_PATTERN = /(?:^|\s)#(\d{1,5})(?:\s|$|[.,;!?)])/;
const GH_ISSUE_VIEW_PATTERN = /gh\s+issue\s+view\s+(\d+)/;
const BRANCH_PATTERN = /(?:checkout|merge|branch)\s+(?:-b\s+)?(\d+-[a-z0-9-]+)/i;
const BRANCH_NAME_PATTERN = /\b(\d{2,4}-[a-z][a-z0-9-]{4,})\b/;

export function scoreMessage(text: string): number {
  const lower = text.toLowerCase().trim();
  const words = lower.split(/\s+/);

  for (const prefix of GARBAGE_PREFIXES) {
    if (lower.startsWith(prefix)) return 0.1;
  }

  for (const ack of ACK_PREFIXES) {
    if (lower === ack || lower.startsWith(ack + " ") && words.length <= 6) return 0.1;
  }

  if (words.length <= 3) return 0.15;

  let score = 0;

  if (words.length > 20) score += 0.3;
  else if (words.length > 10) score += 0.15;

  for (const verb of ACTION_VERBS) {
    if (lower.includes(verb)) {
      score += 0.3;
      break;
    }
  }

  let isAck = false;
  for (const ack of ACK_PREFIXES) {
    if (lower.startsWith(ack)) { isAck = true; break; }
  }
  if (!isAck) score += 0.2;

  let isGarbage = false;
  for (const prefix of GARBAGE_PREFIXES) {
    if (lower.includes(prefix)) { isGarbage = true; break; }
  }
  if (!isGarbage) score += 0.2;

  return Math.min(score, 1.0);
}

interface TranscriptEntry {
  type: string;
  text: string;
}

async function readTranscriptEntries(filePath: string, maxEntries: number): Promise<TranscriptEntry[]> {
  const entries: TranscriptEntry[] = [];
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });

  for await (const line of rl) {
    if (entries.length >= maxEntries) break;
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const type = entry.type;
      if (type !== "user" && type !== "assistant") continue;
      const text = entry.message?.content ? extractTextContent(entry.message.content) : "";
      if (text) entries.push({ type, text });
    } catch {}
  }
  rl.close();
  return entries;
}

function isGarbageEntry(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return GARBAGE_PREFIXES.some((p) => lower.startsWith(p));
}

function findIssueRef(entries: TranscriptEntry[]): ExtractedTask | null {
  const scanLimit = Math.min(entries.length, 20);
  for (let i = 0; i < scanLimit; i++) {
    const text = entries[i].text;
    if (isGarbageEntry(text)) continue;

    const ghMatch = GH_ISSUE_VIEW_PATTERN.exec(text);
    if (ghMatch) {
      const issueNum = ghMatch[1];
      const surrounding = entries[i].type === "user" ? text : "";
      return {
        text: truncate(surrounding ? `#${issueNum}: ${surrounding}` : `Issue #${issueNum}`, 2000),
        source: "issue-ref",
        confidence: 0.9,
      };
    }

    const issueMatch = ISSUE_REF_PATTERN.exec(text);
    if (issueMatch && entries[i].type === "user") {
      const issueNum = issueMatch[1];
      return {
        text: truncate(text, 2000),
        source: "issue-ref",
        confidence: 0.9,
      };
    }
  }
  return null;
}

function findGitContext(entries: TranscriptEntry[]): ExtractedTask | null {
  const scanLimit = Math.min(entries.length, 20);
  for (let i = 0; i < scanLimit; i++) {
    const text = entries[i].text;

    const branchMatch = BRANCH_PATTERN.exec(text);
    if (branchMatch) {
      const branchName = branchMatch[1];
      return {
        text: truncate(`Branch: ${branchName}`, 2000),
        source: "git-context",
        confidence: 0.7,
      };
    }

    const nameMatch = BRANCH_NAME_PATTERN.exec(text);
    if (nameMatch) {
      const branchName = nameMatch[1];
      return {
        text: truncate(`Branch: ${branchName}`, 2000),
        source: "git-context",
        confidence: 0.7,
      };
    }
  }
  return null;
}

function findSubstantiveMessage(entries: TranscriptEntry[]): ExtractedTask | null {
  const userMessages = entries
    .filter((e) => e.type === "user")
    .slice(0, 10);

  let bestText = "";
  let bestScore = 0;

  for (const msg of userMessages) {
    const s = scoreMessage(msg.text);
    if (s > bestScore) {
      bestScore = s;
      bestText = msg.text;
    }
  }

  if (bestScore > 0.3) {
    return {
      text: truncate(bestText, 2000),
      source: "substantive-message",
      confidence: Math.min(bestScore, 0.8),
    };
  }

  return null;
}

export async function extractTaskFromTranscript(filePath: string): Promise<ExtractedTask> {
  const entries = await readTranscriptEntries(filePath, 40);

  if (entries.length === 0) {
    return { text: "(no messages)", source: "first-message", confidence: 0.1 };
  }

  const issueRef = findIssueRef(entries);
  if (issueRef) return issueRef;

  const gitContext = findGitContext(entries);

  const substantive = findSubstantiveMessage(entries);

  if (substantive && (!gitContext || substantive.confidence > gitContext.confidence)) {
    return substantive;
  }

  if (gitContext) return gitContext;

  const firstUser = entries.find((e) => e.type === "user");
  return {
    text: truncate(firstUser?.text ?? "(no user message)", 2000),
    source: "first-message",
    confidence: 0.2,
  };
}
