import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { createHash } from "crypto";

export interface BenchmarkTask {
  id: string;
  task: string;
  rating: number;
  gold_q1: string;
  gold_q2: string;
  domain: string;
}

export interface Benchmark {
  generated: string;
  content_hash: string;
  tasks: BenchmarkTask[];
}

export interface SignalEntry {
  timestamp: string;
  task_description: string;
  implied_sentiment: number;
  effort_level: string;
  reflection_q1: string;
  reflection_q2: string;
  [key: string]: unknown;
}

function hashTask(description: string): string {
  return createHash("sha256").update(description).digest("hex").slice(0, 16);
}

function computeContentHash(tasks: BenchmarkTask[]): string {
  const joined = tasks.map((t) => t.task).join("|");
  return createHash("sha256").update(joined).digest("hex");
}

export function verifyBenchmark(benchmark: Benchmark): boolean {
  const expected = computeContentHash(benchmark.tasks);
  return expected === benchmark.content_hash;
}

export async function buildBenchmark(
  signalDir: string,
  opts?: { minSentiment?: number; skillKeywords?: string[] },
): Promise<Benchmark> {
  const { join } = await import("path");
  const reflectionsPath = join(signalDir, "algorithm-reflections.jsonl");

  if (!existsSync(reflectionsPath)) {
    return {
      generated: new Date().toISOString(),
      content_hash: computeContentHash([]),
      tasks: [],
    };
  }

  const content = await Bun.file(reflectionsPath).text();
  const lines = content.split("\n").filter((l) => l.trim());
  const minSentiment = opts?.minSentiment ?? 7;

  const entries: SignalEntry[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as SignalEntry;
      entries.push(entry);
    } catch {}
  }

  let filtered = entries.filter((e) => e.implied_sentiment >= minSentiment);

  if (opts?.skillKeywords && opts.skillKeywords.length > 0) {
    const kws = opts.skillKeywords.map((k) => k.toLowerCase());
    filtered = filtered.filter((e) => {
      const text = [e.task_description, e.reflection_q1, e.reflection_q2].join(" ").toLowerCase();
      return kws.some((kw) => text.includes(kw));
    });
  }

  const tasks: BenchmarkTask[] = filtered.map((entry) => ({
    id: hashTask(entry.task_description),
    task: entry.task_description,
    rating: entry.implied_sentiment,
    gold_q1: entry.reflection_q1,
    gold_q2: entry.reflection_q2,
    domain: entry.effort_level,
  }));

  return {
    generated: new Date().toISOString(),
    content_hash: computeContentHash(tasks),
    tasks,
  };
}

export function loadBenchmark(path: string): Benchmark {
  if (!existsSync(path)) {
    throw new Error(`Benchmark file not found: ${path}`);
  }

  const { readFileSync } = require("fs") as typeof import("fs");
  const text = readFileSync(path, "utf8");
  const benchmark = JSON.parse(text) as Benchmark;

  if (!verifyBenchmark(benchmark)) {
    throw new Error("Benchmark content hash mismatch — file may have been tampered with");
  }

  return benchmark;
}

export async function saveBenchmark(benchmark: Benchmark, path: string): Promise<void> {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  await Bun.write(path, JSON.stringify(benchmark, null, 2));
}
