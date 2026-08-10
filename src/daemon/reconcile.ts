/**
 * reconcile.ts — Post-session reconciliation hook
 *
 * Runs 3 checks after session end:
 *   1. Budget: injected rules ≤20
 *   2. Telemetry: last history entry has non-zero rules or totalContextLines
 *   3. ROI floor: flags rules with ≥100 injections AND avgCorrelatedRating <3.0
 *
 * Writes report to stateDir()/reconciliation-report.json.
 * NEVER throws — errors logged to stderr, partial report returned.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { stateDir } from "../adapters/paths";

// ── Types ──

export type ReconcileStatus = "pass" | "warn" | "fail";

export interface ReconcileCheck {
  name: string;
  status: ReconcileStatus;
  detail: string;
}

export interface ReconcileReport {
  timestamp: string;
  checks: ReconcileCheck[];
  overall: ReconcileStatus;
}

// ── Constants ──

const BUDGET_CEILING = 20;
const ROI_INJECTION_THRESHOLD = 100;
const ROI_RATING_FLOOR = 3.0;
const REPORT_FILE = "reconciliation-report.json";

// ── Helpers ──

function worstStatus(statuses: ReconcileStatus[]): ReconcileStatus {
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("warn")) return "warn";
  return "pass";
}

function readJsonSafe<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function readLastJsonlEntry<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, "utf-8").trim();
    if (!content) return null;
    const lines = content.split("\n").filter((l) => l.trim());
    if (lines.length === 0) return null;
    return JSON.parse(lines[lines.length - 1]) as T;
  } catch {
    return null;
  }
}

// ── Checks ──

interface SessionContext {
  ruleIds?: string[];
  rules?: Array<{ id: string; text: string }>;
  rulesInjectedCount?: number;
  totalContextLines?: number;
}

interface RuleStatsEntry {
  ruleId: string;
  injectionCount: number;
  avgCorrelatedRating: number;
}

function checkBudget(dir: string): ReconcileCheck {
  try {
    const ctx = readJsonSafe<SessionContext>(join(dir, "session-context.json"));
    if (!ctx) {
      return { name: "budget", status: "pass", detail: "No session-context.json — skipped" };
    }

    const ruleCount = ctx.ruleIds?.length ?? ctx.rulesInjectedCount ?? 0;
    if (ruleCount > BUDGET_CEILING) {
      return {
        name: "budget",
        status: "fail",
        detail: `${ruleCount} rules injected (ceiling: ${BUDGET_CEILING})`,
      };
    }

    return {
      name: "budget",
      status: "pass",
      detail: `${ruleCount} rules injected (ceiling: ${BUDGET_CEILING})`,
    };
  } catch (err) {
    process.stderr.write(`[reconcile] budget check error: ${err}\n`);
    return { name: "budget", status: "warn", detail: `Error: ${err}` };
  }
}

function checkTelemetry(dir: string): ReconcileCheck {
  try {
    const entry = readLastJsonlEntry<SessionContext>(
      join(dir, "session-context-history.jsonl"),
    );
    if (!entry) {
      return { name: "telemetry", status: "warn", detail: "No session-context-history.jsonl entries" };
    }

    const ruleCount = entry.ruleIds?.length ?? entry.rulesInjectedCount ?? 0;
    const totalLines = entry.totalContextLines ?? 0;

    if (ruleCount === 0 && totalLines === 0) {
      return {
        name: "telemetry",
        status: "warn",
        detail: "Last session recorded 0 rules and 0 totalContextLines — telemetry may be dead",
      };
    }

    return {
      name: "telemetry",
      status: "pass",
      detail: `Last session: ${ruleCount} rules, ${totalLines} totalContextLines`,
    };
  } catch (err) {
    process.stderr.write(`[reconcile] telemetry check error: ${err}\n`);
    return { name: "telemetry", status: "warn", detail: `Error: ${err}` };
  }
}

function checkRoiFloor(dir: string): ReconcileCheck {
  try {
    const stats = readJsonSafe<RuleStatsEntry[]>(join(dir, "rule-stats.json"));
    if (!stats || !Array.isArray(stats)) {
      return { name: "roi-floor", status: "pass", detail: "No rule-stats.json — skipped" };
    }

    const flagged = stats.filter(
      (s) =>
        s.injectionCount >= ROI_INJECTION_THRESHOLD &&
        s.avgCorrelatedRating < ROI_RATING_FLOOR,
    );

    if (flagged.length === 0) {
      return {
        name: "roi-floor",
        status: "pass",
        detail: `All rules above ROI floor (${ROI_RATING_FLOOR} rating, ${ROI_INJECTION_THRESHOLD} injections)`,
      };
    }

    const flaggedIds = flagged.map(
      (s) => `${s.ruleId} (${s.injectionCount} inj, ${s.avgCorrelatedRating.toFixed(1)} avg)`,
    );

    return {
      name: "roi-floor",
      status: "warn",
      detail: `${flagged.length} rule(s) below ROI floor — eviction candidates: ${flaggedIds.join(", ")}`,
    };
  } catch (err) {
    process.stderr.write(`[reconcile] roi-floor check error: ${err}\n`);
    return { name: "roi-floor", status: "warn", detail: `Error: ${err}` };
  }
}

// ── Main ──

export async function reconcile(): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    timestamp: new Date().toISOString(),
    checks: [],
    overall: "pass",
  };

  try {
    const dir = stateDir();

    report.checks.push(checkBudget(dir));
    report.checks.push(checkTelemetry(dir));
    report.checks.push(checkRoiFloor(dir));

    report.overall = worstStatus(report.checks.map((c) => c.status));

    // Write report to stateDir
    try {
      const reportPath = join(dir, REPORT_FILE);
      const reportDir = dirname(reportPath);
      if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
      writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
    } catch (writeErr) {
      process.stderr.write(`[reconcile] failed to write report: ${writeErr}\n`);
    }
  } catch (err) {
    process.stderr.write(`[reconcile] unexpected error: ${err}\n`);
    report.overall = worstStatus(report.checks.map((c) => c.status));
  }

  return report;
}
