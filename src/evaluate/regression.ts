import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { stateDir } from "../adapters/paths";
import { getContextRules } from "../graph/context";
import type { Graph, BM25Index } from "../graph/types";
import type { GoldSet } from "./gold";

export interface EvalRegressionResult {
  pass: boolean;
  precision: number;
  previousPrecision: number | null;
}

const WATERMARK_FILE = "eval-watermark.json";

interface Watermark {
  precision: number;
  timestamp: string;
  sessionCount: number;
}

function watermarkPath(): string {
  return join(stateDir(), WATERMARK_FILE);
}

function readWatermark(): Watermark | null {
  const p = watermarkPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Watermark;
  } catch {
    return null;
  }
}

function writeWatermark(wm: Watermark): void {
  const p = watermarkPath();
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(wm, null, 2), "utf-8");
}

export function checkEvalRegression(
  goldSetPath: string,
  watermarkFilePath: string | undefined,
  graph: Graph,
  index: BM25Index,
): EvalRegressionResult {
  const goldRaw = readFileSync(goldSetPath, "utf-8");
  const goldSet = JSON.parse(goldRaw) as GoldSet;

  const wmPath = watermarkFilePath ?? watermarkPath();
  const previousWatermark = existsSync(wmPath)
    ? (JSON.parse(readFileSync(wmPath, "utf-8")) as Watermark)
    : null;

  let totalPrecision = 0;
  let sessionCount = 0;

  for (const session of Object.values(goldSet.labeled)) {
    const rawSession = session as GoldSession & { relevant_rules?: string[] };
    const relevantRules = rawSession.relevantRules ?? rawSession.relevant_rules ?? [];
    if (relevantRules.length === 0) continue;

    const domains = session.domains ?? [];
    const queryText = session.task_context ?? session.description ?? "";
    const retrieved = getContextRules(graph, index, domains, 5, undefined, queryText);
    const retrievedIds = new Set(retrieved.map(r => r.id));
    const relevantSet = new Set(relevantRules);

    let hits = 0;
    for (const id of retrievedIds) {
      if (relevantSet.has(id)) hits++;
    }
    const precision = retrievedIds.size > 0 ? hits / retrievedIds.size : 0;
    totalPrecision += precision;
    sessionCount++;
  }

  const avgPrecision = sessionCount > 0 ? totalPrecision / sessionCount : 0;
  const previousPrecision = previousWatermark?.precision ?? null;

  const newWatermark: Watermark = {
    precision: avgPrecision,
    timestamp: new Date().toISOString(),
    sessionCount,
  };

  if (previousPrecision === null) {
    writeFileSync(wmPath, JSON.stringify(newWatermark, null, 2), "utf-8");
    return { pass: true, precision: avgPrecision, previousPrecision: null };
  }

  const drop = previousPrecision - avgPrecision;
  if (drop >= 0.05) {
    return { pass: false, precision: avgPrecision, previousPrecision };
  }

  writeFileSync(wmPath, JSON.stringify(newWatermark, null, 2), "utf-8");
  return { pass: true, precision: avgPrecision, previousPrecision };
}
