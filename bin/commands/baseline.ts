import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { readSessionHistory, type SessionContext } from "../../src/graph/context";
import { resolveSignalDir, statePath } from "../../src/adapters/paths";

const SNAPSHOT_FILE = "baseline-snapshot.json";

interface SessionBaseline {
  id: string;
  rulesCount: number;
  rulesKB: number;
  corrections: number;
  rating: number;
  iterationCount: number;
}

interface BaselineSnapshot {
  capturedAt: string;
  sessions: SessionBaseline[];
  averages: {
    rulesCount: number;
    rulesKB: number;
    corrections: number;
    rating: number;
  };
}

function loadJsonlEntries(filePath: string): Record<string, unknown>[] {
  if (!existsSync(filePath)) return [];
  try {
    return readFileSync(filePath, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter((e): e is Record<string, unknown> => e !== null);
  } catch {
    return [];
  }
}

function sessionIdFromTimestamp(ts: string): string {
  return ts.replace(/[:.]/g, "-").slice(0, 19);
}

function captureBaseline(): void {
  const sessions = readSessionHistory(10);
  if (sessions.length === 0) {
    console.log("No session history found. Run agentgrit in a few sessions first.");
    return;
  }

  const sigDir = resolveSignalDir();

  const ratingsEntries = loadJsonlEntries(join(sigDir, "ratings.jsonl"));
  const correctionsEntries = loadJsonlEntries(join(sigDir, "corrections.jsonl"))
    .concat(loadJsonlEntries(join(sigDir, "correction-captures.jsonl")));

  const ratingsBySession = new Map<string, number>();
  for (const e of ratingsEntries) {
    const sid = (e.session_id as string) ?? "";
    const rating = e.rating as number;
    if (sid && typeof rating === "number") {
      ratingsBySession.set(sid, rating);
    }
  }

  const correctionsBySession = new Map<string, number>();
  for (const e of correctionsEntries) {
    const sid = (e.session_id as string) ?? "";
    if (sid) {
      correctionsBySession.set(sid, (correctionsBySession.get(sid) ?? 0) + 1);
    }
  }

  const baselineSessions: SessionBaseline[] = sessions.map((s) => {
    const id = sessionIdFromTimestamp(s.timestamp);
    return {
      id,
      rulesCount: s.rulesInjectedCount ?? 0,
      rulesKB: s.rulesInjectedKB ?? 0,
      corrections: correctionsBySession.get(id) ?? findClosestMatch(correctionsBySession, s.timestamp),
      rating: ratingsBySession.get(id) ?? findClosestMatch(ratingsBySession, s.timestamp),
      iterationCount: s.ruleIds.length,
    };
  });

  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const snapshot: BaselineSnapshot = {
    capturedAt: new Date().toISOString(),
    sessions: baselineSessions,
    averages: {
      rulesCount: Math.round(avg(baselineSessions.map((s) => s.rulesCount)) * 10) / 10,
      rulesKB: Math.round(avg(baselineSessions.map((s) => s.rulesKB)) * 10) / 10,
      corrections: Math.round(avg(baselineSessions.map((s) => s.corrections)) * 10) / 10,
      rating: Math.round(avg(baselineSessions.map((s) => s.rating)) * 10) / 10,
    },
  };

  const outPath = statePath(SNAPSHOT_FILE);
  const dir = dirname(outPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2), "utf-8");
  console.log(`Baseline snapshot written to ${outPath}`);
  console.log(`  Sessions: ${snapshot.sessions.length}`);
  console.log(`  Avg rules: ${snapshot.averages.rulesCount} (${snapshot.averages.rulesKB} KB)`);
  console.log(`  Avg corrections: ${snapshot.averages.corrections}`);
  console.log(`  Avg rating: ${snapshot.averages.rating}`);
}

function findClosestMatch(map: Map<string, number>, timestamp: string): number {
  const ts = new Date(timestamp).getTime();
  let closest = 0;
  let minDist = Infinity;
  for (const [key, val] of map) {
    const keyTs = new Date(key).getTime();
    if (Number.isNaN(keyTs)) continue;
    const dist = Math.abs(keyTs - ts);
    if (dist < minDist) {
      minDist = dist;
      closest = val;
    }
  }
  return minDist < 24 * 60 * 60 * 1000 ? closest : 0;
}

function showBaseline(): void {
  const snapshotPath = statePath(SNAPSHOT_FILE);
  if (!existsSync(snapshotPath)) {
    console.log("No baseline snapshot found. Run 'agentgrit baseline capture' first.");
    return;
  }

  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf-8")) as BaselineSnapshot;
  console.log(`\nBaseline Snapshot (captured ${snapshot.capturedAt})\n`);

  const header = "Session ID           Rules   KB     Corrections  Rating  Iterations";
  const divider = "-".repeat(header.length);
  console.log(header);
  console.log(divider);

  for (const s of snapshot.sessions) {
    console.log(
      `${s.id.padEnd(21)}${String(s.rulesCount).padStart(5)}   ${s.rulesKB.toFixed(1).padStart(5)}   ${String(s.corrections).padStart(11)}  ${String(s.rating).padStart(6)}  ${String(s.iterationCount).padStart(10)}`,
    );
  }

  console.log(divider);
  console.log(
    `${"AVERAGES".padEnd(21)}${String(snapshot.averages.rulesCount).padStart(5)}   ${snapshot.averages.rulesKB.toFixed(1).padStart(5)}   ${String(snapshot.averages.corrections).padStart(11)}  ${String(snapshot.averages.rating).padStart(6)}`,
  );
  console.log("");
}

export async function baselineCommand(args: string[]): Promise<void> {
  const sub = args[0];

  if (sub === "capture") {
    captureBaseline();
  } else if (sub === "show") {
    showBaseline();
  } else {
    console.log("Usage: agentgrit baseline <capture|show>");
    console.log("");
    console.log("  capture    Capture baseline from recent sessions");
    console.log("  show       Display the last captured baseline");
  }
}
