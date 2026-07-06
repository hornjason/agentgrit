import { existsSync, mkdirSync, statSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import type { AnySignal, RatingSignal, SignalAdapter } from "./types";

export interface ReadOptions {
  offset?: number;
  limit?: number;
}

export function normalizeRating(entry: Record<string, unknown>): Record<string, unknown> {
  if (entry.M != null && entry.mode == null) entry.mode = entry.M;
  if (entry.S != null && entry.scope == null) entry.scope = entry.S;
  if (entry.Q != null && entry.quality == null) entry.quality = entry.Q;
  if (entry.avg != null && entry.rating == null) entry.rating = entry.avg;
  return entry;
}

export async function appendSignal(file: string, signal: AnySignal): Promise<void> {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const line = JSON.stringify(signal) + "\n";
  const tmpPath = file + ".tmp." + process.pid;

  writeFileSync(tmpPath, "");
  const existing = existsSync(file) ? readFileSync(file, "utf-8") : "";
  writeFileSync(tmpPath, existing + line);
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
      const parsed = JSON.parse(line);
      if (parsed.type === "rating") {
        normalizeRating(parsed);
      }
      signals.push(parsed as AnySignal);
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
