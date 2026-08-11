import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { loadConfig, stateDir, signalPath, getBaseDir } from "../../src/adapters/paths";
import { readSessionContext } from "../../src/graph/context";
import type { ReconcileReport } from "../../src/daemon/reconcile";
import { runDoctor as runDoctorSrc } from "../../src/daemon/doctor";
import type { DoctorReport } from "../../src/daemon/doctor";
import { readEvictionLog } from "../../src/promote/auto-eviction";

interface RuleStatEntry {
  id: string;
  text_preview: string;
  injection_count: number;
  avg_correlated_rating: number;
  last_seen: string;
  high_rating_activations: number;
  low_rating_activations: number;
}

function normalizeRuleStats(raw: unknown): Record<string, RuleStatEntry> | null {
  if (Array.isArray(raw)) {
    const result: Record<string, RuleStatEntry> = {};
    for (const entry of raw) {
      const id = entry.ruleId || entry.id || "";
      if (!id) continue;
      result[id] = {
        id,
        text_preview: entry.text_preview || id,
        injection_count: entry.injectionCount ?? entry.injection_count ?? 0,
        avg_correlated_rating: entry.avgCorrelatedRating ?? entry.avg_correlated_rating ?? 0,
        last_seen: entry.lastSeen ?? entry.last_seen ?? "",
        high_rating_activations: entry.highRatingActivations ?? entry.high_rating_activations ?? 0,
        low_rating_activations: entry.lowRatingActivations ?? entry.low_rating_activations ?? 0,
      };
    }
    return Object.keys(result).length > 0 ? result : null;
  }
  if (raw && typeof raw === "object" && "rules" in raw) {
    return (raw as { rules: Record<string, RuleStatEntry> }).rules;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, RuleStatEntry>;
  }
  return null;
}

interface ToolAuditEntry {
  toolName: string;
  filePath?: string;
  category?: string;
  timestamp: string;
  session_id?: string;
}

interface RedAlert {
  severity: "warning" | "critical";
  message: string;
}

interface RedAlertSection {
  alerts: RedAlert[];
  evictionsLast24h: number;
  trajPendingReview: number;
}

interface HealthData {
  session: SessionSection;
  ruleLifecycle: RuleLifecycleSection;
  redAlerts: RedAlertSection;
  filesRead: FilesReadSection;
  reconciliation: ReconciliationSection;
  doctor: DoctorSectionSummary;
}

interface SessionSection {
  available: boolean;
  rulesInjected?: number;
  rulesInjectedKB?: number;
  budgetUsed?: string;
  budgetCeiling?: number;
  learnedCount?: number;
  learnedBudget?: number;
  contextLines?: number;
  domains?: string[];
  domainSource?: string;
}

interface RuleLifecycleSection {
  available: boolean;
  topByCorrelation?: Array<{ id: string; avgRating: number; injections: number }>;
  bottomByCorrelation?: Array<{ id: string; avgRating: number; injections: number }>;
  promotions30d: string;
  evictions: string;
  precision5?: number;
}

interface FilesReadSection {
  available: boolean;
  files?: string[];
  totalUnique?: number;
}

interface ReconciliationSection {
  available: boolean;
  lastRun?: string;
  overall?: string;
  checks?: Array<{ name: string; status: string; detail: string }>;
}

interface DoctorSectionSummary {
  available: boolean;
  errors?: number;
  warnings?: number;
  ok?: number;
  sections?: Array<{ name: string; status: string; checkCount: number }>;
}

function parseArgs(args: string[]): { json: boolean; issue?: number } {
  let json = false;
  let issue: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") json = true;
    if (args[i] === "--issue" && args[i + 1]) {
      issue = parseInt(args[++i], 10);
    }
  }

  return { json, issue };
}

function gatherSession(): SessionSection {
  const ctx = readSessionContext();
  if (!ctx) return { available: false };

  const config = loadConfig();
  const budgetCeiling = config.rules?.globalBudget ?? 20;
  const learnedBudget = config.rules?.learnedBudget ?? 50;

  let learnedCount = 0;
  const rulesBase = join(getBaseDir(), "rules");
  if (existsSync(rulesBase)) {
    try {
      const files = readdirSync(rulesBase).filter(f => f.endsWith(".md"));
      for (const file of files) {
        try {
          const content = readFileSync(join(rulesBase, file), "utf-8");
          if (/^type:\s*learned/m.test(content)) learnedCount++;
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  const pct = budgetCeiling > 0 ? Math.round((ctx.rulesInjectedCount / budgetCeiling) * 100) : 0;

  return {
    available: true,
    rulesInjected: ctx.rulesInjectedCount,
    rulesInjectedKB: ctx.rulesInjectedKB,
    budgetUsed: `${ctx.rulesInjectedCount}/${budgetCeiling} (${pct}%)`,
    budgetCeiling,
    learnedCount,
    learnedBudget,
    contextLines: ctx.totalContextLines,
    domains: ctx.domains,
    domainSource: ctx.domain_source,
  };
}

function loadRuleStats(): Record<string, RuleStatEntry> | null {
  const statsPath = join(stateDir(), "rule-stats.json");
  if (!existsSync(statsPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(statsPath, "utf-8"));
    return normalizeRuleStats(raw);
  } catch {
    return null;
  }
}

function loadPrecisionEval(): number | undefined {
  const precisionPath = join(getBaseDir(), "state", "precision-eval.json");
  if (!existsSync(precisionPath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(precisionPath, "utf-8"));
    return typeof raw.meanPrecision5 === "number" ? raw.meanPrecision5 : undefined;
  } catch {
    return undefined;
  }
}

function gatherRuleLifecycle(): RuleLifecycleSection {
  const stats = loadRuleStats();
  const precision5 = loadPrecisionEval();

  if (!stats) return { available: false, promotions30d: "no data", evictions: "no data", precision5 };

  const entries = Object.values(stats)
    .filter(e => typeof e.avg_correlated_rating === "number" && e.injection_count > 0);

  const sorted = [...entries].sort((a, b) => b.avg_correlated_rating - a.avg_correlated_rating);

  const top5 = sorted.slice(0, 5).map(e => ({
    id: e.id,
    avgRating: Math.round(e.avg_correlated_rating * 100) / 100,
    injections: e.injection_count,
  }));

  const bottom5 = sorted.slice(-5).reverse().map(e => ({
    id: e.id,
    avgRating: Math.round(e.avg_correlated_rating * 100) / 100,
    injections: e.injection_count,
  }));

  return {
    available: true,
    topByCorrelation: top5,
    bottomByCorrelation: bottom5,
    promotions30d: "no data",
    evictions: "no data",
    precision5,
  };
}

function gatherRedAlerts(): RedAlertSection {
  const alerts: RedAlert[] = [];
  const stats = loadRuleStats();

  // High-volume underperformers
  if (stats) {
    for (const e of Object.values(stats)) {
      if (e.injection_count > 200 && e.avg_correlated_rating < 4.0) {
        alerts.push({
          severity: "critical",
          message: `Rule ${e.id}: ${e.injection_count} injections, ${e.avg_correlated_rating.toFixed(1)} avg — eviction candidate`,
        });
      }
    }
  }

  // Volume drift: compare current signal count against 7-day average
  const ratingsPath = join(getBaseDir(), "signals", "ratings.jsonl");
  if (existsSync(ratingsPath)) {
    try {
      const lines = readFileSync(ratingsPath, "utf-8").split("\n").filter(l => l.trim());
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;
      const todayCount = lines.filter(l => {
        try {
          const ts = new Date(JSON.parse(l).timestamp).getTime();
          return now - ts < dayMs;
        } catch { return false; }
      }).length;
      const weekCount = lines.filter(l => {
        try {
          const ts = new Date(JSON.parse(l).timestamp).getTime();
          return now - ts < 7 * dayMs;
        } catch { return false; }
      }).length;
      const weekDailyAvg = weekCount / 7;
      if (weekDailyAvg > 0) {
        const drift = ((todayCount - weekDailyAvg) / weekDailyAvg) * 100;
        if (Math.abs(drift) > 20) {
          alerts.push({
            severity: "warning",
            message: `Signal volume drift: ${drift > 0 ? "+" : ""}${drift.toFixed(0)}% from 7-day baseline (today: ${todayCount}, avg: ${weekDailyAvg.toFixed(1)})`,
          });
        }
      }
    } catch { /* skip */ }
  }

  // Eviction count (last 24h)
  const evictionEntries = readEvictionLog();
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const evictionsLast24h = evictionEntries.filter(e => {
    try { return now - new Date(e.timestamp).getTime() < dayMs; } catch { return false; }
  }).length;

  // traj-* flagging
  let trajCount = 0;
  if (stats) {
    for (const id of Object.keys(stats)) {
      if (id.startsWith("traj-")) trajCount++;
    }
  }

  // Flat BM25 detection
  const precisionPath = join(getBaseDir(), "state", "precision-eval.json");
  if (existsSync(precisionPath)) {
    try {
      const raw = JSON.parse(readFileSync(precisionPath, "utf-8"));
      if (typeof raw.meanPrecision5 === "number" && raw.meanPrecision5 === 0) {
        alerts.push({
          severity: "critical",
          message: "BM25 scores undifferentiated — P@5=0 in last precision eval",
        });
      }
    } catch { /* skip */ }
  }

  return { alerts, evictionsLast24h, trajPendingReview: trajCount };
}

function loadToolAudit(issueFilter?: number): ToolAuditEntry[] {
  const auditPath = signalPath("tool-audit.jsonl");
  if (!existsSync(auditPath)) return [];
  try {
    const raw = readFileSync(auditPath, "utf-8");
    const lines = raw.split("\n").filter(l => l.trim());
    const entries: ToolAuditEntry[] = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch { /* skip */ }
    }

    if (issueFilter != null) {
      const now = Date.now();
      const windowMs = 4 * 60 * 60 * 1000;
      const cutoff = now - windowMs;
      return entries.filter(e => {
        const ts = new Date(e.timestamp).getTime();
        return ts >= cutoff;
      });
    }

    return entries;
  } catch {
    return [];
  }
}

function gatherFilesRead(issueFilter?: number): FilesReadSection {
  const entries = loadToolAudit(issueFilter);
  if (entries.length === 0) return { available: false };

  const uniqueFiles = new Set<string>();
  for (const e of entries) {
    if (e.filePath) uniqueFiles.add(e.filePath);
  }

  const sorted = [...uniqueFiles].sort();

  return {
    available: true,
    files: sorted,
    totalUnique: sorted.length,
  };
}

function gatherReconciliation(): ReconciliationSection {
  const reportPath = join(stateDir(), "reconciliation-report.json");
  if (!existsSync(reportPath)) return { available: false };

  try {
    const report: ReconcileReport = JSON.parse(readFileSync(reportPath, "utf-8"));
    return {
      available: true,
      lastRun: report.timestamp,
      overall: report.overall,
      checks: report.checks.map(c => ({
        name: c.name,
        status: c.status,
        detail: c.detail,
      })),
    };
  } catch {
    return { available: false };
  }
}

async function gatherDoctor(): Promise<DoctorSectionSummary> {
  try {
    const config = loadConfig();
    if (!config.signalDir) config.signalDir = join(getBaseDir(), "signals");
    if (!config.rules) config.rules = { globalBudget: 25, projectBudget: 25, autoPromote: false };
    if (!config.rubrics) config.rubrics = [];
    if (!config.daemon) config.daemon = { interval: "30m", weeklyDay: "sunday" };

    const report: DoctorReport = await runDoctorSrc(config);

    let errors = 0;
    let warnings = 0;
    let ok = 0;

    for (const section of report.sections) {
      for (const check of section.checks) {
        if (check.status === "error") errors++;
        else if (check.status === "warning") warnings++;
        else ok++;
      }
    }

    return {
      available: true,
      errors,
      warnings,
      ok,
      sections: report.sections.map(s => ({
        name: s.name,
        status: s.status,
        checkCount: s.checks.length,
      })),
    };
  } catch {
    return { available: false };
  }
}

function printHuman(data: HealthData): void {
  console.log("\nagentgrit health\n");

  // SESSION
  console.log("SESSION");
  if (!data.session.available) {
    console.log("  no session data\n");
  } else {
    console.log(`  Rules injected: ${data.session.rulesInjected} (${data.session.rulesInjectedKB} KB)`);
    console.log(`  Budget: ${data.session.budgetUsed}`);
    const learnedOver = (data.session.learnedCount ?? 0) > (data.session.learnedBudget ?? 50);
    console.log(`  Learned: ${data.session.learnedCount}/${data.session.learnedBudget}${learnedOver ? " (over budget!)" : ""}`);
    console.log(`  Context lines: ${data.session.contextLines}`);
    console.log(`  Domains: ${data.session.domains?.join(", ") ?? "none"}`);
    console.log(`  Domain source: ${data.session.domainSource ?? "unknown"}`);
    console.log("");
  }

  // RULE LIFECYCLE
  console.log("RULE LIFECYCLE");
  if (!data.ruleLifecycle.available) {
    console.log("  no rule data\n");
  } else {
    console.log("  Top 5 by correlation:");
    for (let i = 0; i < (data.ruleLifecycle.topByCorrelation?.length ?? 0); i++) {
      const r = data.ruleLifecycle.topByCorrelation![i];
      console.log(`    ${i + 1}. ${r.id}  (${r.avgRating}, ${r.injections} injections)`);
    }
    console.log("  Bottom 5:");
    for (let i = 0; i < (data.ruleLifecycle.bottomByCorrelation?.length ?? 0); i++) {
      const r = data.ruleLifecycle.bottomByCorrelation![i];
      console.log(`    ${i + 1}. ${r.id}  (${r.avgRating}, ${r.injections} injections)`);
    }
    console.log(`  Promotions (30d): ${data.ruleLifecycle.promotions30d}`);
    console.log(`  Evictions: ${data.ruleLifecycle.evictions}`);
    const p5 = data.ruleLifecycle.precision5;
    console.log(`  Precision@5: ${p5 != null ? `${p5.toFixed(3)} (from last eval)` : "no precision data"}`);
    console.log("");
  }

  // RED ALERTS
  console.log("RED ALERTS");
  if (data.redAlerts.alerts.length === 0 && data.redAlerts.evictionsLast24h === 0 && data.redAlerts.trajPendingReview === 0) {
    console.log("  no alerts\n");
  } else {
    for (const alert of data.redAlerts.alerts) {
      const icon = alert.severity === "critical" ? "✗" : "⚠";
      console.log(`  ${icon} ${alert.message}`);
    }
    console.log(`  Auto-evicted (24h): ${data.redAlerts.evictionsLast24h} rules`);
    if (data.redAlerts.trajPendingReview > 0) {
      console.log(`  ⚠ traj-* rules pending review: ${data.redAlerts.trajPendingReview}`);
    }
    console.log("");
  }

  // FILES READ
  console.log("FILES READ (this session)");
  if (!data.filesRead.available) {
    console.log("  no tool audit data\n");
  } else {
    for (const f of data.filesRead.files ?? []) {
      console.log(`  ${f}`);
    }
    console.log(`  Total: ${data.filesRead.totalUnique} unique files`);
    console.log("");
  }

  // RECONCILIATION
  console.log("RECONCILIATION");
  if (!data.reconciliation.available) {
    console.log("  no reconciliation data\n");
  } else {
    console.log(`  Last run: ${data.reconciliation.lastRun}`);
    console.log(`  Overall: ${data.reconciliation.overall}`);
    for (const c of data.reconciliation.checks ?? []) {
      const icon = c.status === "pass" ? "✓" : c.status === "warn" ? "⚠" : "✗";
      console.log(`  ${icon} ${c.name} ${c.detail ? `(${c.detail})` : ""}`);
    }
    console.log("");
  }

  // DOCTOR
  console.log("DOCTOR");
  if (!data.doctor.available) {
    console.log("  no doctor data\n");
  } else {
    console.log(`  Errors: ${data.doctor.errors}`);
    console.log(`  Warnings: ${data.doctor.warnings}`);
    console.log(`  OK: ${data.doctor.ok}`);
    console.log("");
  }
}

export async function healthCommand(args: string[]): Promise<void> {
  const opts = parseArgs(args);

  const session = gatherSession();
  const ruleLifecycle = gatherRuleLifecycle();
  const redAlerts = gatherRedAlerts();
  const filesRead = gatherFilesRead(opts.issue);
  const reconciliation = gatherReconciliation();
  const doctor = await gatherDoctor();

  const data: HealthData = { session, ruleLifecycle, redAlerts, filesRead, reconciliation, doctor };

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    printHuman(data);
  }
}
