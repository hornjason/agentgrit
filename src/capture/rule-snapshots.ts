import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { statePath } from "../adapters/paths";

export interface RuleSnapshot {
  turn: number;
  activeRules: string[];
  timestamp: string;
  sessionId: string;
}

const SNAPSHOTS_FILE = "rule-snapshots.jsonl";

export function captureRuleSnapshot(snapshot: RuleSnapshot): void {
  const filePath = statePath(SNAPSHOTS_FILE);
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const line = JSON.stringify(snapshot) + "\n";
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
  writeFileSync(filePath, existing + line);
}

function loadSnapshots(): RuleSnapshot[] {
  const filePath = statePath(SNAPSHOTS_FILE);
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, "utf-8");
  const snapshots: RuleSnapshot[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      snapshots.push(JSON.parse(line) as RuleSnapshot);
    } catch { /* skip malformed */ }
  }
  return snapshots.sort((a, b) => a.turn - b.turn);
}

export function getActiveRulesAtTurn(turn: number): string[] {
  const snapshots = loadSnapshots();
  if (snapshots.length === 0) return [];

  // Binary search for most recent snapshot at or before given turn
  let lo = 0;
  let hi = snapshots.length - 1;
  let result = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (snapshots[mid].turn <= turn) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (result === -1) return [];
  return snapshots[result].activeRules;
}
