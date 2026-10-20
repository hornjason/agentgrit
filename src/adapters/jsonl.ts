import { existsSync, mkdirSync, statSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import type { AnySignal, SignalAdapter } from "./types";

export interface ReadOptions {
  offset?: number;
  limit?: number;
}

export async function appendSignal(file: string, signal: AnySignal): Promise<void> {
  await appendSignals(file, [signal]);
}

/**
 * Append many signals in one atomic rewrite.
 *
 * Every append here rewrites the whole file, so a bulk writer that loops over
 * appendSignal is quadratic: the ratings backfill (#260) recovers ~800 records
 * and would rewrite the file 800 times. One call, one rewrite.
 */
export async function appendSignals(file: string, signals: AnySignal[]): Promise<void> {
  if (signals.length === 0) return;

  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const lines = signals.map((s) => JSON.stringify(s) + "\n").join("");
  const tmpPath = file + ".tmp." + process.pid;

  writeFileSync(tmpPath, "");
  const existing = existsSync(file) ? readFileSync(file, "utf-8") : "";
  writeFileSync(tmpPath, existing + lines);
  try {
    renameSync(tmpPath, file);
  } catch {
    try { unlinkSync(tmpPath); } catch {}
    throw new Error(`Failed to atomically write signal to ${file}`);
  }
}

export async function readSignals(
  file: string,
  opts?: ReadOptions,
): Promise<AnySignal[]> {
  if (!existsSync(file)) return [];

  const content = readFileSync(file, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());

  const start = opts?.offset ?? 0;
  const end = opts?.limit !== undefined ? start + opts.limit : lines.length;
  const slice = lines.slice(start, end);

  const signals: AnySignal[] = [];
  for (const line of slice) {
    try {
      signals.push(JSON.parse(line) as AnySignal);
    } catch {
      // skip malformed lines
    }
  }
  return signals;
}

export async function rotateFile(
  file: string,
  maxSizeBytes: number,
): Promise<{ rotated: boolean; archivePath?: string }> {
  if (!existsSync(file)) return { rotated: false };

  const stat = statSync(file);
  if (stat.size <= maxSizeBytes) return { rotated: false };

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const archivePath = file + "." + ts + ".bak";

  renameSync(file, archivePath);
  writeFileSync(file, "");

  return { rotated: true, archivePath };
}

export function createJsonlAdapter(): SignalAdapter {
  return {
    append: appendSignal,
    read: readSignals,
    rotate: rotateFile,
  };
}
