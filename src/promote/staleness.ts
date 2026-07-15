import { existsSync, readFileSync, statSync } from "fs";
import { dirname, join, resolve } from "path";

export interface StaleEntry {
  /** Display name from the markdown link */
  name: string;
  /** Resolved absolute path to the linked file */
  filePath: string;
  /** Days since last modification (0 if missing) */
  daysStale: number;
  /** "stale" if file exists but old, "missing" if file doesn't exist */
  status: "stale" | "missing";
}

export interface StalenessOptions {
  /** Number of days before an entry is considered stale (default: 60) */
  thresholdDays?: number;
}

const LINK_RE = /- \[([^\]]+)\]\(([^)]+)\)/g;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Reads a MEMORY.md file, extracts linked file paths, checks mtime,
 * and returns entries not updated within the threshold.
 */
export async function detectStaleMemories(
  memoryMdPath: string,
  options?: StalenessOptions,
): Promise<StaleEntry[]> {
  const threshold = options?.thresholdDays ?? 60;

  if (!existsSync(memoryMdPath)) return [];

  const content = readFileSync(memoryMdPath, "utf-8");
  const baseDir = dirname(resolve(memoryMdPath));
  const now = Date.now();
  const stale: StaleEntry[] = [];

  for (const match of content.matchAll(LINK_RE)) {
    const name = match[1];
    const rawPath = match[2];

    // Skip URLs
    if (rawPath.startsWith("http://") || rawPath.startsWith("https://")) continue;

    const resolved = resolve(baseDir, rawPath);

    if (!existsSync(resolved)) {
      stale.push({ name, filePath: resolved, daysStale: 0, status: "missing" });
      continue;
    }

    const stat = statSync(resolved);
    const ageMs = now - stat.mtime.getTime();
    const ageDays = Math.floor(ageMs / MS_PER_DAY);

    if (ageDays >= threshold) {
      stale.push({ name, filePath: resolved, daysStale: ageDays, status: "stale" });
    }
  }

  return stale;
}
