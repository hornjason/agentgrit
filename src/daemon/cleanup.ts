import { existsSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { rotateFile } from "../adapters/jsonl";

const DEFAULT_MAX_SIZE_MB = 10;
const STALE_STATE_DAYS = 30;
const MS_PER_DAY = 86_400_000;

export interface CleanupResult {
  staleFilesRemoved: number;
  sessionStatesCleared: number;
  errors: string[];
}

export async function cleanupSession(
  signalDir: string,
  stateDir: string,
): Promise<CleanupResult> {
  const result: CleanupResult = {
    staleFilesRemoved: 0,
    sessionStatesCleared: 0,
    errors: [],
  };

  // Clean stale session state files
  if (existsSync(stateDir)) {
    try {
      const files = readdirSync(stateDir);
      const now = Date.now();

      for (const file of files) {
        if (!file.startsWith("current-work-") && file !== "current-work.json") continue;

        const path = join(stateDir, file);
        try {
          const stat = statSync(path);
          const ageMs = now - stat.mtimeMs;

          if (ageMs > STALE_STATE_DAYS * MS_PER_DAY) {
            unlinkSync(path);
            result.staleFilesRemoved++;
          }
        } catch (err) {
          result.errors.push(
            `Failed to check ${file}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      result.errors.push(
        `Failed to read state dir: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Clean stale session digest files
  if (existsSync(stateDir)) {
    try {
      const files = readdirSync(stateDir);

      for (const file of files) {
        if (!file.endsWith(".tmp") && !file.endsWith(".bak")) continue;

        const path = join(stateDir, file);
        try {
          const stat = statSync(path);
          const ageMs = Date.now() - stat.mtimeMs;

          if (ageMs > 7 * MS_PER_DAY) {
            unlinkSync(path);
            result.sessionStatesCleared++;
          }
        } catch (err) {
          result.errors.push(
            `Failed to clean ${file}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      result.errors.push(
        `Failed to clean state dir: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}

export async function rotateSignals(
  signalDir: string,
  maxSizeMB: number = DEFAULT_MAX_SIZE_MB,
): Promise<number> {
  if (!existsSync(signalDir)) return 0;

  const maxSizeBytes = maxSizeMB * 1024 * 1024;
  const files = readdirSync(signalDir).filter((f) => f.endsWith(".jsonl"));
  let rotated = 0;

  for (const file of files) {
    const path = join(signalDir, file);
    const result = await rotateFile(path, maxSizeBytes);
    if (result.rotated) rotated++;
  }

  return rotated;
}
