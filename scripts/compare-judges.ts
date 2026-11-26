#!/usr/bin/env bun
/**
 * compare-judges (#327) — which judge model agrees with the owner's thumbs?
 *
 * Answer key: thumbs rows in ratings.jsonl whose transcript still exists. Each
 * model grades the rated exchange (rated-exchange.ts, #324) through the
 * production path — judgeTrace with provider "vertex" and the starter rubric —
 * without seeing the thumb. A model is good when its weighted score separates
 * thumbs-down from thumbs-up (AUC), says the same thing twice, and parses.
 *
 *   bun scripts/compare-judges.ts --dry-run                  # sends nothing
 *   bun scripts/compare-judges.ts --limit 20 --repeat 10     # pilot, all models
 *   bun scripts/compare-judges.ts --models a,b --repeat 30   # full set, chosen models
 *
 * Options: --project (default jhorn-pai) --location (default global)
 *          --concurrency per model (default 3) --seed (default 1) --out FILE
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getBaseDir, hostDir, resolveSignalDir } from "../src/adapters/paths";
import type { RubricConfig, Score } from "../src/adapters/types";
import { judgeTrace, type JudgeConfig, type Trace } from "../src/evaluate/judge";
import { findTranscript, ratedExchange } from "../src/evaluate/rated-exchange";
import { loadRubric } from "../src/evaluate/rubric";

const DEFAULT_MODELS = [
  "gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.5-pro",
  "gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-3.1-pro-preview",
  "gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-3.7-flash", "gemini-3.8-flash",
  "gemini-4-argon", "gemini-4-carbon", "gemini-4-hydrogen", "gemini-4-neon",
];

export interface Item { id: string; up: boolean; input: string; output: string }

// ── metrics ────────────────────────────────────────────────────────────────

/** P(score of a random positive > score of a random negative), ties count half. NaN when a class is empty. */
export function auc(scores: number[], labels: boolean[]): number {
  const pos = scores.filter((_, i) => labels[i]);
  const neg = scores.filter((_, i) => !labels[i]);
  if (pos.length === 0 || neg.length === 0) return Number.NaN;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

/** Deterministic PRNG so a seed reproduces a sample and a bootstrap. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** 95% interval of the AUC from resampling positives and negatives separately. */
export function bootstrapAuc(scores: number[], labels: boolean[], rounds = 2000, seed = 1): [number, number] {
  const rand = mulberry32(seed);
  const pos = scores.filter((_, i) => labels[i]);
  const neg = scores.filter((_, i) => !labels[i]);
  if (pos.length === 0 || neg.length === 0) return [Number.NaN, Number.NaN];
  const draws: number[] = [];
  for (let r = 0; r < rounds; r++) {
    const p = pos.map(() => pos[Math.floor(rand() * pos.length)]);
    const n = neg.map(() => neg[Math.floor(rand() * neg.length)]);
    draws.push(auc([...p, ...n], [...p.map(() => true), ...n.map(() => false)]));
  }
  draws.sort((a, b) => a - b);
  return [draws[Math.floor(rounds * 0.025)], draws[Math.floor(rounds * 0.975)]];
}

/** Weighted mean of the dimensions the judge returned, renormalised over those present. */
export function weightedScore(scores: Score[], rubric: RubricConfig): number | null {
  let sum = 0; let weight = 0;
  for (const d of rubric.dimensions) {
    const s = scores.find((x) => x.dimension === d.name);
    if (s) { sum += s.value * d.weight; weight += d.weight; }
  }
  return weight > 0 ? sum / weight : null;
}

/** Same up/down ratio as the whole set, chosen by seed. */
export function stratifiedSample(items: Item[], n: number, seed: number): Item[] {
  if (n >= items.length) return items;
  const rand = mulberry32(seed);
  const shuffle = <T>(xs: T[]) => xs.map((x) => [rand(), x] as const).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
  const up = shuffle(items.filter((i) => i.up));
  const down = shuffle(items.filter((i) => !i.up));
  const nDown = Math.max(1, Math.round((n * down.length) / items.length));
  return [...down.slice(0, nDown), ...up.slice(0, n - nDown)];
}

// ── data ───────────────────────────────────────────────────────────────────

async function loadItems(): Promise<{ items: Item[]; thumbs: number; missing: number }> {
  const rows = readFileSync(join(resolveSignalDir(), "ratings.jsonl"), "utf-8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
    .filter((r): r is Record<string, unknown> => r !== null && r.source === "thumbs");
  const roots = [join(hostDir(), "projects")];
  const items: Item[] = []; let missing = 0;
  for (const r of rows) {
    const rating = Number(r.rating); const sid = String(r.session_id ?? ""); const at = String(r.timestamp ?? "");
    if (!(rating >= 6 || rating <= 4)) continue;
    const path = findTranscript(sid, roots);
    const ex = path ? await ratedExchange(path, at) : null;
    if (!ex) { missing++; continue; }
    items.push({ id: String(r.id ?? `${sid}@${at}`), up: rating >= 6, input: ex.input, output: ex.output });
  }
  return { items, thumbs: rows.length, missing };
}

async function pool<T, R>(xs: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (next < xs.length) { const i = next++; out[i] = await fn(xs[i]); } }));
  return out;
}

// ── run ────────────────────────────────────────────────────────────────────

interface Graded { id: string; score: number | null; ms: number }
interface ModelResult { model: string; graded: Graded[]; repeat: Graded[]; auc: number; ci: [number, number]; failed: number; meanMs: number; repeatMeanAbsDiff: number | null; repeatExact: number | null }

async function gradeAll(model: string, items: Item[], rubric: RubricConfig, base: Omit<JudgeConfig, "model">, conc: number): Promise<Graded[]> {
  return pool(items, conc, async (it) => {
    const t0 = Date.now();
    const scores = await judgeTrace({ id: it.id, input: it.input, output: it.output } as Trace, rubric, { ...base, model });
    return { id: it.id, score: weightedScore(scores, rubric), ms: Date.now() - t0 };
  });
}

function arg(name: string): string | undefined { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; }

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry-run");
  const models = (arg("models")?.split(",").map((s) => s.trim()).filter(Boolean)) ?? DEFAULT_MODELS;
  const limit = arg("limit") ? Number(arg("limit")) : Infinity;
  const repeatN = Number(arg("repeat") ?? 0);
  const seed = Number(arg("seed") ?? 1);
  const conc = Number(arg("concurrency") ?? 3);
  const base = { provider: "vertex" as const, project: arg("project") ?? "jhorn-pai", location: arg("location") ?? "global", maxRetries: 2 };
  const rubric = loadRubric(join(getBaseDir(), "rubrics", "starter.json"));

  const { items: all, thumbs, missing } = await loadItems();
  const items = stratifiedSample(all, limit, seed);
  const repeatItems = stratifiedSample(items, repeatN, seed + 1).slice(0, repeatN);
  const up = items.filter((i) => i.up).length;
  const calls = models.length * (items.length + repeatItems.length);
  const chars = items.reduce((s, i) => s + Math.min(i.input.length, 2000) + Math.min(i.output.length, 4000) + 900, 0);

  console.log(`thumbs rows: ${thumbs}  resolved to an exchange: ${all.length}  no transcript: ${missing}`);
  console.log(`sample: ${items.length} (${up} up, ${items.length - up} down)  repeat subset: ${repeatItems.length}`);
  console.log(`models (${models.length}): ${models.join(", ")}`);
  console.log(`judge: vertex ${base.project}/${base.location}  rubric: starter.json (${rubric.dimensions.map((d) => `${d.name} ${d.weight}`).join(", ")})`);
  console.log(`calls: ${calls}  prompt size per model pass: ~${Math.round(chars / 4).toLocaleString()} input tokens (chars/4; output and thinking tokens not counted)`);
  if (dry) {
    const ex = items[0];
    console.log(`\nDRY RUN — nothing sent. First item (${ex.up ? "up" : "down"}):\n  input:  ${ex.input.slice(0, 160).replace(/\s+/g, " ")}\n  output: ${ex.output.slice(-160).replace(/\s+/g, " ")}`);
    return;
  }

  const lengths = items.map((i) => i.output.length); const labels = items.map((i) => i.up);
  const lenAuc = auc(lengths, labels); const baseline = Math.max(lenAuc, 1 - lenAuc);

  const results: ModelResult[] = await Promise.all(models.map(async (model): Promise<ModelResult> => {
    const graded = await gradeAll(model, items, rubric, base, conc);
    const repeat = repeatItems.length ? await gradeAll(model, repeatItems, rubric, base, conc) : [];
    const ok = graded.map((g, i) => ({ g, up: items[i].up })).filter((x) => x.g.score !== null);
    const s = ok.map((x) => x.g.score!); const l = ok.map((x) => x.up);
    const pairs = repeat.map((r) => [graded.find((g) => g.id === r.id)?.score ?? null, r.score] as const).filter(([a, b]) => a !== null && b !== null) as Array<readonly [number, number]>;
    process.stderr.write(`  done: ${model}\n`);
    return {
      model, graded, repeat, auc: auc(s, l), ci: bootstrapAuc(s, l, 2000, seed), failed: graded.length - ok.length,
      meanMs: Math.round(graded.reduce((a, g) => a + g.ms, 0) / graded.length),
      repeatMeanAbsDiff: pairs.length ? pairs.reduce((a, [x, y]) => a + Math.abs(x - y), 0) / pairs.length : null,
      repeatExact: pairs.length ? pairs.filter(([x, y]) => Math.abs(x - y) < 1e-9).length / pairs.length : null,
    };
  }));

  results.sort((a, b) => (Number.isNaN(b.auc) ? -1 : b.auc) - (Number.isNaN(a.auc) ? -1 : a.auc));
  const f = (x: number | null, d = 3) => (x === null || Number.isNaN(x) ? "  -  " : x.toFixed(d));
  console.log(`\nbaseline (reply length, better direction): AUC ${baseline.toFixed(3)}\n`);
  console.log("model                    AUC    95% CI          failed  repeat |Δ|  repeat same  mean ms");
  for (const r of results) {
    console.log(`${r.model.padEnd(24)} ${f(r.auc)}  [${f(r.ci[0])}, ${f(r.ci[1])}]  ${String(r.failed).padStart(4)}/${r.graded.length}   ${f(r.repeatMeanAbsDiff, 2).padStart(6)}     ${r.repeatExact === null ? "  -  " : `${Math.round(r.repeatExact * 100)}%`.padStart(4)}      ${String(r.meanMs).padStart(6)}`);
  }

  const outDir = join(getBaseDir(), "state", "judge-compare");
  const out = arg("out") ?? join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), seed, base, sample: items.map(({ id, up: u }) => ({ id, up: u })), baseline, results }, null, 2));
  console.log(`\nper-item results: ${out}`);
}

if (import.meta.main) await main();
