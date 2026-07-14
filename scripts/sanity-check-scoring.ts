#!/usr/bin/env bun
/**
 * Sanity check: compares scoreSessionObjective output against 29 explicit /rate sessions.
 * Reads ratings.jsonl for explicit ratings, correction-captures.jsonl for per-session corrections.
 */

import { readFileSync } from "fs";
import { scoreSessionObjective } from "../src/capture/rating";
import type { ObjectiveScoreInput } from "../src/capture/rating";

const RATINGS_PATH = `${process.env.HOME}/.claude/MEMORY/LEARNING/SIGNALS/ratings.jsonl`;
const CORRECTIONS_PATH = `${process.env.HOME}/.claude/MEMORY/LEARNING/SIGNALS/correction-captures.jsonl`;

interface RatingEntry {
  session_id: string;
  rating: number;
  source: string;
  type: string;
}

interface CorrectionEntry {
  session_id: string;
  type: string;
}

const ratingsRaw = readFileSync(RATINGS_PATH, "utf-8").trim().split("\n");
const correctionsRaw = readFileSync(CORRECTIONS_PATH, "utf-8").trim().split("\n");

const explicitRatings = ratingsRaw
  .map((line) => JSON.parse(line) as RatingEntry)
  .filter((r) => r.source === "explicit" && r.type === "rating");

const correctionsBySession = new Map<string, { corrections: number; approvals: number }>();
for (const line of correctionsRaw) {
  const entry = JSON.parse(line) as CorrectionEntry;
  const sid = entry.session_id;
  if (!correctionsBySession.has(sid)) {
    correctionsBySession.set(sid, { corrections: 0, approvals: 0 });
  }
  const bucket = correctionsBySession.get(sid)!;
  if (entry.type === "correction") bucket.corrections++;
  else if (entry.type === "approval") bucket.approvals++;
}

console.log(`Explicit ratings: ${explicitRatings.length}`);
console.log(`Sessions with corrections data: ${correctionsBySession.size}`);
console.log("─".repeat(70));

let totalDivergence = 0;
let count = 0;
const results: { session: string; explicit: number; objective: number; diff: number }[] = [];

const sessionsSeen = new Set<string>();
for (const rating of explicitRatings) {
  if (sessionsSeen.has(rating.session_id)) continue;
  sessionsSeen.add(rating.session_id);

  const corr = correctionsBySession.get(rating.session_id);
  const input: ObjectiveScoreInput = {
    corrections: corr?.corrections ?? 0,
    reprompts: 0,
    iterations: 0,
    firstPassGates: 0,
    uninterruptedRuns: 0,
    shortFrustrated: 0,
  };

  const result = scoreSessionObjective(input);
  const diff = Math.abs(rating.rating - result.score);
  totalDivergence += diff;
  count++;

  results.push({
    session: rating.session_id.slice(0, 8),
    explicit: rating.rating,
    objective: result.score,
    diff: Math.round(diff * 10) / 10,
  });
}

results.sort((a, b) => b.diff - a.diff);

console.log(`${"Session".padEnd(12)} ${"Explicit".padEnd(10)} ${"Objective".padEnd(10)} Diff`);
console.log("─".repeat(50));
for (const r of results) {
  console.log(
    `${r.session.padEnd(12)} ${String(r.explicit).padEnd(10)} ${String(r.objective).padEnd(10)} ${r.diff}`,
  );
}

console.log("─".repeat(50));
const avgDivergence = count > 0 ? Math.round((totalDivergence / count) * 100) / 100 : 0;
const divergencePct = count > 0 ? Math.round((totalDivergence / (count * 10)) * 10000) / 100 : 0;
console.log(`Sessions compared: ${count}`);
console.log(`Average divergence: ${avgDivergence} points`);
console.log(`Divergence %: ${divergencePct}%`);
