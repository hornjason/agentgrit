import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "fs";
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

export interface PruneOptions {
  /** Path to archive file (default: MEMORY-ARCHIVE.md alongside MEMORY.md) */
  archivePath?: string;
  /** If true, report what would be archived without modifying files */
  dryRun?: boolean;
  /** Days before stale (default: 60) */
  threshold?: number;
}

export interface PruneResult {
  /** Entry names that were (or would be) archived */
  archived: string[];
  /** Entry names that were kept */
  kept: string[];
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

/**
 * Prunes stale entries from MEMORY.md, moving them to MEMORY-ARCHIVE.md.
 * Calls detectStaleMemories() internally to find stale entries, then
 * removes their lines from MEMORY.md and appends them to the archive.
 */
export async function pruneStaleMemories(
  memoryMdPath: string,
  options?: PruneOptions,
): Promise<PruneResult> {
  const archivePath = options?.archivePath ??
    join(dirname(resolve(memoryMdPath)), "MEMORY-ARCHIVE.md");
  const dryRun = options?.dryRun ?? false;
  const threshold = options?.threshold;

  const staleEntries = await detectStaleMemories(
    memoryMdPath,
    threshold !== undefined ? { thresholdDays: threshold } : undefined,
  );

  if (staleEntries.length === 0) {
    // Count all link entries as kept
    const content = readFileSync(memoryMdPath, "utf-8");
    const kept: string[] = [];
    for (const match of content.matchAll(LINK_RE)) {
      kept.push(match[1]);
    }
    return { archived: [], kept };
  }

  const content = readFileSync(memoryMdPath, "utf-8");
  const lines = content.split("\n");
  const staleNames = new Set(staleEntries.map((e) => e.name));

  const keptLines: string[] = [];
  const archivedLines: string[] = [];
  const archivedNames: string[] = [];
  const keptNames: string[] = [];

  for (const line of lines) {
    const linkMatch = line.match(/- \[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      const name = linkMatch[1];
      const rawPath = linkMatch[2];
      // Skip URLs -- they aren't tracked by staleness
      if (rawPath.startsWith("http://") || rawPath.startsWith("https://")) {
        keptLines.push(line);
        keptNames.push(name);
        continue;
      }
      if (staleNames.has(name)) {
        archivedLines.push(line);
        archivedNames.push(name);
        continue;
      }
      keptNames.push(name);
    }
    keptLines.push(line);
  }

  if (!dryRun && archivedLines.length > 0) {
    // Write updated MEMORY.md
    writeFileSync(memoryMdPath, keptLines.join("\n"), "utf-8");

    // Append to archive
    const dateStr = new Date().toISOString().slice(0, 10);
    const archiveBlock = `\n## Archived ${dateStr}\n${archivedLines.join("\n")}\n`;

    if (existsSync(archivePath)) {
      appendFileSync(archivePath, archiveBlock, "utf-8");
    } else {
      writeFileSync(archivePath, `# Memory Archive\n${archiveBlock}`, "utf-8");
    }
  }

  return { archived: archivedNames, kept: keptNames };
}
