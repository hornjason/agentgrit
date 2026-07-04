import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import type { PromotionRecord } from "../adapters/types";

const LEDGER_FILENAME = "promotions.jsonl";

function ledgerPath(stateDir: string): string {
  return join(stateDir, LEDGER_FILENAME);
}

export async function recordPromotion(
  record: PromotionRecord,
  stateDir: string,
): Promise<void> {
  const path = ledgerPath(stateDir);
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

  const line = JSON.stringify(record) + "\n";
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";

  const tmpPath = path + ".tmp." + process.pid;
  try {
    writeFileSync(tmpPath, existing + line);
    renameSync(tmpPath, path);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* cleanup best-effort */ }
    throw new Error(`Failed to record promotion: ${err}`);
  }
}

export function getPromotionHistory(stateDir: string): PromotionRecord[] {
  const path = ledgerPath(stateDir);
  if (!existsSync(path)) return [];

  const content = readFileSync(path, "utf-8");
  const records: PromotionRecord[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as PromotionRecord);
    } catch { /* skip malformed */ }
  }

  return records;
}

export async function undoPromotions(
  count: number,
  stateDir: string,
): Promise<PromotionRecord[]> {
  const history = getPromotionHistory(stateDir);
  if (history.length === 0 || count <= 0) return [];

  const toUndo = history.slice(-count);
  const remaining = history.slice(0, -count);

  const path = ledgerPath(stateDir);
  const newContent = remaining.map((r) => JSON.stringify(r)).join("\n") +
    (remaining.length > 0 ? "\n" : "");

  const tmpPath = path + ".tmp." + process.pid;
  try {
    writeFileSync(tmpPath, newContent);
    renameSync(tmpPath, path);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* cleanup best-effort */ }
    throw new Error(`Failed to undo promotions: ${err}`);
  }

  return toUndo;
}
