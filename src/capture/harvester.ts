/**
 * harvester.ts — Extract learnings from Claude Code session transcripts
 *
 * Ported from PAI Tools/SessionHarvester.ts.
 * Reads session JSONL files, detects correction/error/insight patterns,
 * and writes structured learning files to the learning directory.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, basename } from "path";
import { parseTranscript } from "./debrief";

// ── Types ──

export interface HarvestedLearning {
  sessionId: string;
  timestamp: string;
  category: "system" | "algorithm";
  type: "correction" | "error" | "insight";
  context: string;
  content: string;
  source: string;
}

export interface HarvestResult {
  learnings: HarvestedLearning[];
  sessionsScanned: number;
}

// ── Pattern lists ──

const CORRECTION_PATTERNS: RegExp[] = [
  /actually,?\s+/i,
  /wait,?\s+/i,
  /no,?\s+i meant/i,
  /let me clarify/i,
  /that's not (quite )?right/i,
  /you misunderstood/i,
  /i was wrong/i,
  /my mistake/i,
];

const ERROR_PATTERNS: RegExp[] = [
  /error:/i,
  /failed:/i,
  /exception:/i,
  /stderr:/i,
  /command failed/i,
  /permission denied/i,
];

const INSIGHT_PATTERNS: RegExp[] = [
  /learned that/i,
  /realized that/i,
  /discovered that/i,
  /key insight/i,
  /important:/i,
  /note to self/i,
  /for next time/i,
  /lesson:/i,
];

// ── Category classification ──

const SYSTEM_PATTERNS: RegExp[] = [
  /hook|crash|broken/i,
  /tool|config|deploy|path/i,
  /import|module|file.*not.*found/i,
  /typescript|javascript|npm|bun/i,
];

export function classifyCategory(text: string): "system" | "algorithm" {
  for (const p of SYSTEM_PATTERNS) {
    if (p.test(text)) return "system";
  }
  return "algorithm";
}

// ── Pattern matching ──

function matchesAny(text: string, patterns: RegExp[]): string | null {
  for (const p of patterns) {
    if (p.test(text)) return p.source;
  }
  return null;
}

// ── Session file discovery ──

export function getSessionFiles(
  projectsDir: string,
  opts: { recent?: number; sessionId?: string },
): string[] {
  if (!existsSync(projectsDir)) return [];

  const files = readdirSync(projectsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({
      name: f,
      path: join(projectsDir, f),
      mtime: statSync(join(projectsDir, f)).mtime.getTime(),
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (opts.sessionId) {
    const match = files.find((f) => f.name.includes(opts.sessionId!));
    return match ? [match.path] : [];
  }

  const limit = opts.recent ?? 10;
  return files.slice(0, limit).map((f) => f.path);
}

// ── Core extraction ──

export function harvestFromTranscript(
  transcript: string,
  sessionId: string,
): HarvestedLearning[] {
  const turns = parseTranscript(transcript);
  const learnings: HarvestedLearning[] = [];
  let previousContext = "";

  for (const turn of turns) {
    const text = turn.text;
    if (text.length < 20) continue;

    const timestamp = new Date().toISOString();

    if (turn.role === "user") {
      const corrMatch = matchesAny(text, CORRECTION_PATTERNS);
      if (corrMatch) {
        learnings.push({
          sessionId,
          timestamp,
          category: classifyCategory(text),
          type: "correction",
          context: previousContext.slice(0, 200),
          content: text.slice(0, 500),
          source: corrMatch,
        });
      }
      previousContext = text;
    }

    if (turn.role === "assistant") {
      const errMatch = matchesAny(text, ERROR_PATTERNS);
      if (errMatch) {
        const hasLearningSignal =
          /problem|issue|bug|error|failed|broken/i.test(text) &&
          /fixed|solved|resolved|discovered|realized|learned/i.test(text);
        if (hasLearningSignal) {
          learnings.push({
            sessionId,
            timestamp,
            category: classifyCategory(text),
            type: "error",
            context: previousContext.slice(0, 200),
            content: text.slice(0, 500),
            source: errMatch,
          });
        }
      }

      const insMatch = matchesAny(text, INSIGHT_PATTERNS);
      if (insMatch) {
        learnings.push({
          sessionId,
          timestamp,
          category: classifyCategory(text),
          type: "insight",
          context: previousContext.slice(0, 200),
          content: text.slice(0, 500),
          source: insMatch,
        });
      }

      previousContext = text;
    }
  }

  return learnings;
}

// ── Learning file generation ──

export function formatLearningFile(learning: HarvestedLearning): string {
  const typeLabel = learning.type.charAt(0).toUpperCase() + learning.type.slice(1);
  return [
    `# ${typeLabel} Learning`,
    "",
    `**Session:** ${learning.sessionId}`,
    `**Timestamp:** ${learning.timestamp}`,
    `**Category:** ${learning.category}`,
    `**Source Pattern:** ${learning.source}`,
    "",
    "---",
    "",
    "## Context",
    "",
    learning.context,
    "",
    "## Learning",
    "",
    learning.content,
    "",
  ].join("\n");
}

export function writeLearnings(
  learnings: HarvestedLearning[],
  learningDir: string,
): string[] {
  const written: string[] = [];

  for (const learning of learnings) {
    const subDir = join(learningDir, learning.category);
    if (!existsSync(subDir)) mkdirSync(subDir, { recursive: true });

    const date = new Date(learning.timestamp);
    const dateStr = date.toISOString().split("T")[0];
    const timeStr = date.toISOString().split("T")[1].slice(0, 5).replace(":", "");
    const sessionShort = learning.sessionId.slice(0, 8);
    const filename = `${dateStr}_${timeStr}_${learning.type}_${sessionShort}.md`;
    const filepath = join(subDir, filename);

    if (existsSync(filepath)) continue;

    writeFileSync(filepath, formatLearningFile(learning));
    written.push(filepath);
  }

  return written;
}

// ── High-level harvest ──

export function harvest(
  projectsDir: string,
  learningDir: string,
  opts: { recent?: number; sessionId?: string } = {},
): HarvestResult {
  const sessionFiles = getSessionFiles(projectsDir, opts);

  const allLearnings: HarvestedLearning[] = [];
  for (const file of sessionFiles) {
    const sessionId = basename(file, ".jsonl");
    const content = readFileSync(file, "utf-8");
    const learnings = harvestFromTranscript(content, sessionId);
    allLearnings.push(...learnings);
  }

  if (allLearnings.length > 0) {
    writeLearnings(allLearnings, learningDir);
  }

  return { learnings: allLearnings, sessionsScanned: sessionFiles.length };
}
