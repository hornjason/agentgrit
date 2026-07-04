import { existsSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { parseRating, computeComposite } from "../../src/capture/rating";
import { SCHEMA_VERSION } from "../../src/adapters/types";
import { resolveSignalDir } from "../../src/adapters/paths";

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

  const parsed = parseRating(content);
  if (!parsed) return;

  const composite = computeComposite(parsed.mode, parsed.scope, parsed.quality);
  const dir = getSignalDir();
  const record = {
    id: randomUUID(),
    type: "rating",
    timestamp: new Date().toISOString(),
    session_id: input.session_id || "unknown",
    schemaVersion: SCHEMA_VERSION,
    rating: composite,
    source: "explicit",
    mode: parsed.mode,
    scope: parsed.scope,
    quality: parsed.quality,
    comment: parsed.comment,
  };

  appendJsonl(join(dir, "ratings.jsonl"), record);
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

  let input: { session_id?: string; tool_name?: string };
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  if (!input.tool_name) return;

  const dir = getSignalDir();
  const record = {
    id: randomUUID(),
    type: "tool-use",
    timestamp: new Date().toISOString(),
    session_id: input.session_id || "unknown",
    schemaVersion: SCHEMA_VERSION,
    tool_name: input.tool_name,
  };

  appendJsonl(join(dir, "tool-audit.jsonl"), record);
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

const SUBCOMMANDS: Record<string, () => Promise<void>> = {
  rating: captureRatingCommand,
  correction: captureCorrectionCommand,
  tool: captureToolCommand,
  skill: captureSkillCommand,
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
