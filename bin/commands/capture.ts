import { existsSync, mkdirSync, appendFileSync, readFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { execSync } from "child_process";
import { parseRating, computeComposite, parseBareNumberRating, parsePraiseRating, parseThumbsRating, captureSessionSentiment, readToolAuditForSession } from "../../src/capture/rating";
import type { Turn } from "../../src/capture/rating";
import { writeSessionContext } from "../../src/graph/context";
import { parseTranscript, extractDebrief } from "../../src/capture/debrief";
import { SCHEMA_VERSION } from "../../src/adapters/types";
import type { RatingSignal } from "../../src/adapters/types";
import { loadConfig, resolveSignalDir, resolveMemoryDir } from "../../src/adapters/paths";
import { generateFeedback, generateSuccess } from "../../src/daemon/feedback";
import { inference, type InferenceOptions, type InferenceResult } from "../../src/adapters/inference";
import { captureToolUse } from "../../src/capture/tool-audit";

export type InferenceFn = (opts: InferenceOptions) => Promise<InferenceResult>;

const NOISE_PATTERNS: RegExp[] = [
  /\bno\s+problem\b/i,
  /\bno\s+worries\b/i,
  /\bno\s+rush\b/i,
  /\bno\s+need\b/i,
  /\bno\s+thanks\b/i,
  /\bno\s+big\s+deal\b/i,
  /\bnot\s+(?:yet|now|sure|necessarily|bad)\b/i,
  /\bno\s+issue\b/i,
];

const CORRECTION_STARTERS: RegExp[] = [
  /^no\s/i,
  /^wrong\b/i,
  /^stop\b/i,
  /^don'?t\b/i,
  /^not\s+that\b/i,
  /^fix\b/i,
  /^undo\b/i,
  /^revert\b/i,
];

function getSignalDir(): string {
  return resolveSignalDir();
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function appendJsonl(file: string, record: Record<string, unknown>): void {
  const dir = require("path").dirname(file);
  ensureDir(dir);
  appendFileSync(file, JSON.stringify(record) + "\n");
}

function readStdin(): string {
  try {
    const buf = require("fs").readFileSync("/dev/stdin", "utf-8");
    return buf;
  } catch {
    return "";
  }
}

async function maybeGenerateLearning(rating: number, ratingSignal: RatingSignal): Promise<void> {
  try {
    const memoryDir = resolveMemoryDir();
    if (rating >= 8) {
      await generateSuccess([ratingSignal], memoryDir);
    } else if (rating <= 4) {
      await generateFeedback([ratingSignal], memoryDir);
    }
  } catch (err) {
    process.stderr.write(`[agentgrit] auto-feedback error: ${err}\n`);
  }
}

async function captureRatingCommand(): Promise<void> {
  const raw = readStdin();
  if (!raw) return;

  let input: { session_id?: string; message?: { content?: string } };
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  const content = input.message?.content;
  if (typeof content !== "string") return;

  const dir = getSignalDir();
  const sessionId = input.session_id || "unknown";
  const ts = new Date().toISOString();

  // 1. Explicit /rate M:N S:N Q:N (highest priority)
  const parsed = parseRating(content);
  if (parsed) {
    const composite = computeComposite(parsed.mode, parsed.scope, parsed.quality);
    const recordId = randomUUID();
    appendJsonl(join(dir, "ratings.jsonl"), {
      id: recordId,
      type: "rating",
      timestamp: ts,
      session_id: sessionId,
      schemaVersion: SCHEMA_VERSION,
      rating: composite,
      source: "explicit",
      mode: parsed.mode,
      scope: parsed.scope,
      quality: parsed.quality,
      comment: parsed.comment,
    });
    await maybeGenerateLearning(composite, {
      id: recordId, type: "rating", timestamp: ts, session_id: sessionId,
      schemaVersion: SCHEMA_VERSION, rating: composite, source: "explicit",
    });
    return;
  }

  // 2. Bare number (e.g., "7", "8 - nice work")
  const bareNumber = parseBareNumberRating(content);
  if (bareNumber !== null) {
    const recordId = randomUUID();
    appendJsonl(join(dir, "ratings.jsonl"), {
      id: recordId,
      type: "rating",
      timestamp: ts,
      session_id: sessionId,
      schemaVersion: SCHEMA_VERSION,
      rating: bareNumber,
      source: "implicit",
    });
    await maybeGenerateLearning(bareNumber, {
      id: recordId, type: "rating", timestamp: ts, session_id: sessionId,
      schemaVersion: SCHEMA_VERSION, rating: bareNumber, source: "implicit",
    });
    return;
  }

  // 3. Praise keywords (≤5 words, e.g., "great", "perfect", "love it")
  const config = loadConfig();
  const praise = parsePraiseRating(content, config);
  if (praise) {
    const recordId = randomUUID();
    appendJsonl(join(dir, "ratings.jsonl"), {
      id: recordId,
      type: "rating",
      timestamp: ts,
      session_id: sessionId,
      schemaVersion: SCHEMA_VERSION,
      rating: praise.score,
      source: "praise",
    });
    await maybeGenerateLearning(praise.score, {
      id: recordId, type: "rating", timestamp: ts, session_id: sessionId,
      schemaVersion: SCHEMA_VERSION, rating: praise.score, source: "praise",
    });
    return;
  }

  // 4. Thumbs up/down
  const thumbs = parseThumbsRating(content, config);
  if (thumbs) {
    const recordId = randomUUID();
    appendJsonl(join(dir, "ratings.jsonl"), {
      id: recordId,
      type: "rating",
      timestamp: ts,
      session_id: sessionId,
      schemaVersion: SCHEMA_VERSION,
      rating: thumbs.score,
      source: "thumbs",
    });
    await maybeGenerateLearning(thumbs.score, {
      id: recordId, type: "rating", timestamp: ts, session_id: sessionId,
      schemaVersion: SCHEMA_VERSION, rating: thumbs.score, source: "thumbs",
    });
    return;
  }
}

async function captureCorrectionCommand(): Promise<void> {
  const raw = readStdin();
  if (!raw) return;

  let input: { session_id?: string; message?: { content?: string } };
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  const content = input.message?.content;
  if (typeof content !== "string") return;

  if (NOISE_PATTERNS.some((p) => p.test(content))) return;

  const isCorrection = CORRECTION_STARTERS.some((p) => p.test(content.trim()));
  if (!isCorrection) return;

  const dir = getSignalDir();
  const record = {
    id: randomUUID(),
    type: "correction",
    timestamp: new Date().toISOString(),
    session_id: input.session_id || "unknown",
    schemaVersion: SCHEMA_VERSION,
    correction_phrase: content.slice(0, 300),
  };

  appendJsonl(join(dir, "corrections.jsonl"), record);
}

async function captureToolCommand(): Promise<void> {
  const raw = readStdin();
  if (!raw) return;

  let input: {
    session_id?: string;
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    tool_response?: { is_error?: boolean };
  };
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  if (!input.tool_name) return;

  const args = input.tool_input ?? {};
  const isError = input.tool_response?.is_error === true;

  await captureToolUse(
    input.tool_name,
    args,
    input.session_id || "unknown",
    { isError },
  );
}

async function captureSkillCommand(): Promise<void> {
  const raw = readStdin();
  if (!raw) return;

  let input: { session_id?: string; tool_name?: string; tool_input?: { skill?: string } };
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  if (input.tool_name !== "Skill") return;

  const skillName = input.tool_input?.skill;
  if (!skillName) return;

  const dir = getSignalDir();
  const record = {
    id: randomUUID(),
    type: "skill-invocation",
    timestamp: new Date().toISOString(),
    session_id: input.session_id || "unknown",
    schemaVersion: SCHEMA_VERSION,
    skill: skillName,
  };

  appendJsonl(join(dir, "skill-invocations.jsonl"), record);
}

// ── Keyword-based sentiment fallback ──

const NEGATIVE_KEYWORDS: RegExp[] = [
  /\bstop\b/i,
  /\bwrong\b/i,
  /\bdon'?t\b/i,
  /\bnot\s+that\b/i,
  /\bbroken\b/i,
  /\bbug\b/i,
  /\bfix\b/i,
];

const POSITIVE_KEYWORDS: RegExp[] = [
  /\bgreat\b/i,
  /\bperfect\b/i,
  /\bexactly\b/i,
  /\bgood\b/i,
  /\bthanks\b/i,
  /\bnice\b/i,
];

export function keywordSentiment(text: string): number {
  if (NOISE_PATTERNS.some((p) => p.test(text))) return 0;

  let score = 0;
  let hits = 0;
  for (const p of NEGATIVE_KEYWORDS) {
    if (p.test(text)) { score -= 1; hits++; }
  }
  for (const p of POSITIVE_KEYWORDS) {
    if (p.test(text)) { score += 1; hits++; }
  }
  if (hits === 0) return 0;
  return Math.max(-1, Math.min(1, score / hits));
}

async function captureSentimentCommand(infer: InferenceFn = inference): Promise<void> {
  const raw = readStdin();
  if (!raw) return;

  let input: { session_id?: string; message?: { content?: string } };
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  const content = input.message?.content;
  if (typeof content !== "string" || !content.trim()) return;

  let score: number;

  const inferResult = await infer({
    systemPrompt:
      "Score the user message sentiment from -1 (frustrated) to +1 (satisfied). " +
      'Respond with JSON: {"score": <number>}',
    userPrompt: content.slice(0, 500),
    level: "fast",
    expectJson: true,
    timeout: 10_000,
  });

  if (inferResult.success && inferResult.parsed) {
    const parsed = inferResult.parsed as { score?: number };
    if (typeof parsed.score === "number" && parsed.score >= -1 && parsed.score <= 1) {
      score = Math.round(parsed.score * 100) / 100;
    } else {
      score = keywordSentiment(content);
    }
  } else {
    score = keywordSentiment(content);
  }

  const dir = getSignalDir();
  const record = {
    id: randomUUID(),
    type: "sentiment",
    timestamp: new Date().toISOString(),
    session_id: input.session_id || "unknown",
    schemaVersion: SCHEMA_VERSION,
    score,
    message_preview: content.slice(0, 100),
  };

  appendJsonl(join(dir, "sentiment.jsonl"), record);
}

async function captureHarvestCommand(): Promise<void> {
  const { harvest } = await import("../../src/capture/harvester");
  const { resolveSignalDir } = await import("../../src/adapters/paths");
  const { join } = await import("path");
  const { homedir } = await import("os");

  const claudeDir = join(homedir(), ".claude");
  const cwdSlug = claudeDir.replace(/[\/\.]/g, "-");
  const projectsDir = join(claudeDir, "projects", cwdSlug);
  const learningDir = join(resolveSignalDir(), "..", "learning");

  const result = harvest(projectsDir, learningDir, { recent: 10 });
  if (result.learnings.length > 0) {
    process.stderr.write(
      `[harvest] ${result.learnings.length} learning(s) from ${result.sessionsScanned} session(s)\n`,
    );
  }
}

async function captureIncidentCommand(): Promise<void> {
  const raw = readStdin();
  if (!raw) return;

  let input: { session_id?: string; tool_response?: { output?: string }; tool_input?: { command?: string } };
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  const output = input.tool_response?.output ?? "";
  const command = input.tool_input?.command ?? "";
  const sessionId = input.session_id ?? "";

  if (!output) return;

  const { monitorToolOutput } = await import("../../src/capture/incidents");
  const { resolveSignalDir } = await import("../../src/adapters/paths");
  const { join } = await import("path");

  const incidentsPath = join(resolveSignalDir(), "incidents.jsonl");
  monitorToolOutput(output, command, sessionId, incidentsPath);
}

async function captureSessionScoreCommand(): Promise<void> {
  const raw = readStdin();
  if (!raw) return;

  let input: { session_id?: string; transcript_path?: string };
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  const sessionId = input.session_id;
  const transcriptPath = input.transcript_path;
  if (!sessionId || !transcriptPath) return;

  if (!existsSync(transcriptPath)) return;

  const transcript = readFileSync(transcriptPath, "utf-8");
  if (!transcript.trim()) return;

  const rawTurns = parseTranscript(transcript);
  const turns: Turn[] = rawTurns.map((t) => ({
    role: t.role,
    text: t.text,
    charCount: t.text.length,
  }));

  if (turns.length === 0) return;

  const dir = getSignalDir();
  const ratingsPath = join(dir, "ratings.jsonl");
  if (existsSync(ratingsPath)) {
    const lines = readFileSync(ratingsPath, "utf-8").trim().split("\n");
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.session_id === sessionId && entry.source === "explicit") {
          return;
        }
      } catch {
        // skip malformed lines
      }
    }
  }

  await captureSessionSentiment(turns, sessionId);

  // Enrich session context with tool-audit data
  try {
    const sessionTimestamp = new Date().toISOString();
    const audit = readToolAuditForSession(sessionTimestamp, join(getSignalDir(), "tool-audit.jsonl"));
    if (audit.toolNames.length > 0 || audit.filePaths.length > 0) {
      writeSessionContext([], [], "keyword", 0, {
        toolCallPatterns: audit.toolNames,
        filePathsTouched: audit.filePaths,
      });
    }
  } catch {
    // session context enrichment is non-critical
  }

  // Post-session reconciliation — advisory, never blocks session end
  try {
    const { reconcile } = await import("../../src/daemon/reconcile");
    const report = await reconcile();
    if (report.overall !== "pass") {
      process.stderr.write(
        `[reconcile] ${report.overall}: ${report.checks.filter((c) => c.status !== "pass").map((c) => `${c.name}=${c.status}`).join(", ")}\n`,
      );
    }
  } catch {
    // reconciliation is advisory — never block session end
  }
}

async function captureDebriefCommand(): Promise<void> {
  const raw = readStdin();
  if (!raw) return;

  let input: { session_id?: string; transcript_path?: string };
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  const sessionId = input.session_id;
  const transcriptPath = input.transcript_path;
  if (!sessionId || !transcriptPath) return;

  if (!existsSync(transcriptPath)) return;

  const transcript = readFileSync(transcriptPath, "utf-8");
  if (!transcript.trim()) return;

  const result = await extractDebrief(transcript, sessionId);

  if (result.corrections.length === 0 && result.approvals.length === 0) return;

  const dir = getSignalDir();
  const outPath = join(dir, "correction-captures.jsonl");

  for (const c of result.corrections) {
    appendJsonl(outPath, {
      type: "correction",
      user_text: c.correction_phrase,
      assistant_context: c.context,
      turn_index: c.turn_index ?? 0,
      session_id: sessionId,
      timestamp: c.timestamp,
    });
  }

  for (const a of result.approvals) {
    appendJsonl(outPath, {
      type: "approval",
      phrase: a.phrase,
      context: a.context,
      turn_index: a.turnIndex,
      session_id: sessionId,
      timestamp: new Date().toISOString(),
    });
  }
}

async function captureIncidentAnalysisCommand(): Promise<void> {
  const raw = readStdin();
  if (!raw) return;

  let input: { session_id?: string };
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  const sessionId = input.session_id;
  if (!sessionId) return;

  const { analyzeSessionPatterns } = await import("../../src/capture/incidents");
  const { resolveSignalDir, stateDir } = await import("../../src/adapters/paths");

  const incidentsPath = join(resolveSignalDir(), "incidents.jsonl");
  const pendingRulesPath = join(stateDir(), "pending-rules.md");

  const result = analyzeSessionPatterns(incidentsPath, pendingRulesPath, sessionId);
  if (result.patternsFound > 0) {
    process.stderr.write(
      `[incident-analysis] ${result.patternsFound} pattern(s), ${result.rulesProposed} rule(s) proposed\n`,
    );
  }
}

async function captureWorkCompletionCommand(): Promise<void> {
  const raw = readStdin();
  if (!raw) return;

  let input: { session_id?: string; transcript_path?: string };
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  const sessionId = input.session_id;
  const transcriptPath = input.transcript_path;
  if (!sessionId || !transcriptPath) return;

  let gitSummary = "";
  let filesChanged: string[] = [];
  try {
    gitSummary = execSync("git diff --stat", { encoding: "utf-8", timeout: 5000 }).trim();
    filesChanged = gitSummary.split("\n").filter((l) => l.includes("|")).map((l) => l.split("|")[0].trim());
  } catch {}

  let turnCount = 0;
  if (existsSync(transcriptPath)) {
    const transcript = readFileSync(transcriptPath, "utf-8");
    const lines = transcript.split("\n").filter((l) => l.trim());
    turnCount = lines.length;
  }

  if (filesChanged.length === 0 && turnCount < 3) return;

  const dir = getSignalDir();
  const toolAuditPath = join(dir, "tool-audit.jsonl");
  const toolsUsed: string[] = [];
  if (existsSync(toolAuditPath)) {
    const lines = readFileSync(toolAuditPath, "utf-8").trim().split("\n");
    const seen = new Set<string>();
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const name = entry.toolName || entry.tool_name || entry.tool;
        if (entry.session_id === sessionId && name && !seen.has(name)) {
          seen.add(name);
          toolsUsed.push(name);
        }
      } catch {}
    }
  }

  let durationMinutes = 0;
  if (existsSync(transcriptPath)) {
    const transcript = readFileSync(transcriptPath, "utf-8");
    const lines = transcript.split("\n").filter((l) => l.trim());
    let firstTs: string | null = null;
    let lastTs: string | null = null;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.timestamp) {
          if (!firstTs) firstTs = entry.timestamp;
          lastTs = entry.timestamp;
        }
      } catch {}
    }
    if (firstTs && lastTs) {
      const diff = new Date(lastTs).getTime() - new Date(firstTs).getTime();
      if (diff > 0) durationMinutes = Math.round(diff / 60000);
    }
  }

  const record = {
    id: randomUUID(),
    type: "work-completion",
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    schemaVersion: SCHEMA_VERSION,
    files_changed: filesChanged,
    tools_used: toolsUsed,
    duration_minutes: durationMinutes,
    git_summary: gitSummary,
  };

  appendJsonl(join(dir, "work-completions.jsonl"), record);
}

const SUBCOMMANDS: Record<string, () => Promise<void>> = {
  rating: captureRatingCommand,
  correction: captureCorrectionCommand,
  tool: captureToolCommand,
  skill: captureSkillCommand,
  sentiment: captureSentimentCommand,
  harvest: captureHarvestCommand,
  incident: captureIncidentCommand,
  "session-score": captureSessionScoreCommand,
  debrief: captureDebriefCommand,
  "incident-analysis": captureIncidentAnalysisCommand,
  "work-completion": captureWorkCompletionCommand,
};

export async function captureCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || !SUBCOMMANDS[sub]) {
    console.error(`Usage: agentgrit capture <${Object.keys(SUBCOMMANDS).join("|")}>`);
    process.exit(1);
  }

  try {
    await SUBCOMMANDS[sub]();
  } catch {
    // hooks must not block Claude Code
  }
}
