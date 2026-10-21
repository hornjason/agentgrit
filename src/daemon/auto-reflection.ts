/**
 * auto-reflection.ts — compose reflection entries from captured rating signals.
 *
 * The optimizer stack (skill-synthesizer, skill-forge, hill-climb) reads
 * `algorithm-reflections.jsonl`, which until now was only ever written by an
 * external system. This module builds the same records from signals the daemon
 * already has, so a standalone install gets reflection-driven optimization.
 *
 * Deliberately free of any LLM call: `implied_sentiment` is the measured mean
 * of the session's ratings, not a self-assessment. Nothing here may import the
 * inference adapter — a test asserts that, and the whole module must run with
 * no API key in the environment.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname } from "path";
import type { RatingSignal } from "../adapters/types";

/**
 * Shape-compatible with `Reflection` in src/optimize/skill-synthesizer.ts.
 * Declared locally rather than imported so this module keeps no edge — not
 * even a type-only one — to a module that pulls in the inference adapter.
 */
export interface AutoReflection {
  timestamp: string;
  effort_level: string;
  task_description: string;
  implied_sentiment: number;
  session_id: string;
  rating_count: number;
  source: "daemon-auto";
  [key: string]: unknown;
}

const MAX_DESCRIPTION_LENGTH = 200;

function isScored(signal: RatingSignal): boolean {
  return typeof signal.rating === "number" && Number.isFinite(signal.rating);
}

/** First non-empty free-text field across the session's ratings, if any. */
function describeSession(sessionId: string, ratings: RatingSignal[]): string {
  for (const r of ratings) {
    const text = (r.comment ?? r.sentimentSummary ?? "").trim();
    if (text) return text.slice(0, MAX_DESCRIPTION_LENGTH);
  }
  return `Autonomous session ${sessionId}`;
}

/** Latest timestamp in the session, falling back to now. */
function latestTimestamp(ratings: RatingSignal[]): string {
  let latest = "";
  for (const r of ratings) {
    const ts = typeof r.timestamp === "string" ? r.timestamp : "";
    if (!ts || Number.isNaN(Date.parse(ts))) continue;
    if (!latest || Date.parse(ts) > Date.parse(latest)) latest = ts;
  }
  return latest || new Date().toISOString();
}

/**
 * One reflection entry per distinct `session_id`, in first-seen order.
 *
 * `implied_sentiment` is the arithmetic mean of that session's `rating`
 * values — unrounded, so 4 and 5 give 4.5. Signals without a finite numeric
 * rating are ignored; a session with no scored signal produces no entry.
 */
export function generateAutoReflection(ratings: RatingSignal[]): AutoReflection[] {
  const bySession = new Map<string, RatingSignal[]>();

  for (const signal of ratings) {
    if (!signal || typeof signal.session_id !== "string" || !signal.session_id) continue;
    if (!isScored(signal)) continue;
    const group = bySession.get(signal.session_id);
    if (group) group.push(signal);
    else bySession.set(signal.session_id, [signal]);
  }

  const reflections: AutoReflection[] = [];
  for (const [sessionId, group] of bySession) {
    const mean = group.reduce((sum, r) => sum + r.rating, 0) / group.length;
    reflections.push({
      timestamp: latestTimestamp(group),
      effort_level: "auto",
      task_description: describeSession(sessionId, group),
      implied_sentiment: mean,
      session_id: sessionId,
      rating_count: group.length,
      source: "daemon-auto",
    });
  }

  return reflections;
}

/**
 * Append reflections as JSONL — one JSON object per line.
 *
 * Creates the parent directory and the file when absent, and appends to an
 * existing file instead of overwriting it. If the existing file does not end
 * in a newline, one is inserted first so the previous last line and the first
 * appended record do not merge into one unparseable line.
 */
export function appendReflections(filePath: string, reflections: AutoReflection[]): void {
  if (reflections.length === 0) return;

  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let prefix = "";
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf-8");
    if (existing.length > 0 && !existing.endsWith("\n")) prefix = "\n";
  }

  const payload = prefix + reflections.map((r) => JSON.stringify(r) + "\n").join("");
  appendFileSync(filePath, payload);
}
