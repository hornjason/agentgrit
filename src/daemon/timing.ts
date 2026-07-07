/**
 * timing.ts — Session timing utilities
 *
 * Ported from PAI hooks/lib/notifications.ts (session timing only).
 * Records session start time and computes duration.
 * Push notifications (ntfy) intentionally excluded — PAI-specific.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";

const DEFAULT_SESSION_FILE = "/tmp/agentgrit-session-start.txt";

export function recordSessionStart(
  filepath: string = DEFAULT_SESSION_FILE,
): void {
  try {
    writeFileSync(filepath, Date.now().toString());
  } catch {
    // non-blocking
  }
}

export function getSessionDurationMinutes(
  filepath: string = DEFAULT_SESSION_FILE,
): number {
  try {
    if (existsSync(filepath)) {
      const startTime = parseInt(readFileSync(filepath, "utf-8"));
      if (!isNaN(startTime)) {
        return (Date.now() - startTime) / 1000 / 60;
      }
    }
  } catch {
    // non-blocking
  }
  return 0;
}

export function getSessionStartTime(
  filepath: string = DEFAULT_SESSION_FILE,
): number | null {
  try {
    if (existsSync(filepath)) {
      const startTime = parseInt(readFileSync(filepath, "utf-8"));
      if (!isNaN(startTime)) return startTime;
    }
  } catch {
    // non-blocking
  }
  return null;
}
