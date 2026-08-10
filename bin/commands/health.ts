import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { loadConfig, stateDir, signalPath, getBaseDir } from "../../src/adapters/paths";
import { readSessionContext } from "../../src/graph/context";
import type { ReconcileReport } from "../../src/daemon/reconcile";
import { runDoctor as runDoctorSrc } from "../../src/daemon/doctor";
import type { DoctorReport } from "../../src/daemon/doctor";

interface RuleStatEntry {
  id: string;
  text_preview: string;
  injection_count: number;
  avg_correlated_rating: number;
  last_seen: string;
  high_rating_activations: number;
  low_rating_activations: number;
}

interface ToolAuditEntry {
  toolName: string;
  filePath?: string;
  category?: string;
  timestamp: string;
  session_id?: string;
}

interface HealthData {
  session: SessionSection;
  ruleLifecycle: RuleLifecycleSection;
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
  const statsPath = join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".claude", "MEMORY", "LEARNING", "STATE", "rule-stats.json",
  );
  if (!existsSync(statsPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(statsPath, "utf-8"));
    if (raw.rules && typeof raw.rules === "object") return raw.rules;
    if (typeof raw === "object" && !Array.isArray(raw)) return raw;
    return null;
  } catch {
    return null;
  }
}

function gatherRuleLifecycle(): RuleLifecycleSection {
  const stats = loadRuleStats();
  if (!stats) return { available: false, promotions30d: "no data", evictions: "no data" };

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
  };
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
  const filesRead = gatherFilesRead(opts.issue);
  const reconciliation = gatherReconciliation();
  const doctor = await gatherDoctor();

  const data: HealthData = { session, ruleLifecycle, filesRead, reconciliation, doctor };

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    printHuman(data);
  }
}
