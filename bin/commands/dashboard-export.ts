import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawnSync } from "child_process";
import { getBaseDir, stateDir, signalPath, loadConfig } from "../../src/adapters/paths";
import { runDoctor } from "../../src/daemon/doctor";
import type { DoctorReport } from "../../src/daemon/doctor";

// ── Types (match AgentGritHealth in control-plane) ──

interface HealthCheck {
  label: string;
  status: "green" | "amber" | "red";
  detail: string;
}

interface DomainEntry {
  name: string;
  count: number;
}

interface RulePerformer {
  id: string;
  rating: number;
  injections: number;
  differentialLift: number;
}

interface LearningStage {
  name: string;
  color: string;
  metric: string;
}

interface LifecycleCounts {
  graduated: number;
  evicted: number;
  active: number;
  undersampled: number;
  total: number;
}

interface FunnelStage {
  stage: string;
  count: number;
  description: string;
}

interface DashboardResults {
  scannedAt: string;
  doctor: HealthCheck;
  compliance: HealthCheck;
  wiring: HealthCheck;
  graph: HealthCheck;
  tests: HealthCheck;
  version: HealthCheck;
  metrics: {
    ratingCount: number;
    correctionCount: number;
    nodeCount: number;
    edgeCount: number;
    effectiveness: number;
    hitRate: number;
    rulesPerSession: number;
    avgCorrelatedRating: number;
    recallAt15: number;
    precisionAt5: number;
    mrr: number;
    globalBudget: string;
    domainCount: number;
    testCount: number;
    ratingTrend30: number | null;
    evictionLogEntries: number;
    evictionLogUniqueRules: number;
  };
  domains: DomainEntry[];
  topPerformers: RulePerformer[];
  bottomPerformers: RulePerformer[];
  healthChecks: HealthCheck[];
  learningLoop: LearningStage[];
  lifecycle: LifecycleCounts;
  lifecycleFunnel: FunnelStage[];
}

// ── Helpers ──

function readJson(filePath: string): unknown {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function countLines(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  const content = readFileSync(filePath, "utf-8").trim();
  if (!content) return 0;
  return content.split("\n").length;
}

interface RuleStatEntry {
  ruleId: string;
  injectionCount: number;
  avgCorrelatedRating: number;
  highRatingActivations?: number;
  differentialLift?: number;
}

interface RecallEvalData {
  meanRecall15?: number;
  meanPrecision5?: number;
  meanMrr?: number;
}

interface GraphData {
  nodeCount?: number;
  edgeCount?: number;
  nodes?: Record<string, { name?: string; description?: string; domains?: string[]; tier?: string; status?: string }>;
}

// ── Export logic ──

export function generateDashboardResults(): DashboardResults {
  const agRoot = join(homedir(), "agentgrit");
  const agHome = join(homedir(), ".agentgrit");
  const state = stateDir();
  const config = loadConfig();
  const configRaw = readJson(join(agHome, "config.json")) as { signalDir?: string; thresholds?: { globalBudgetCap?: number } } | null;
  const sigDir = configRaw?.signalDir ?? join(agHome, "signals");

  // ── Graph ──
  const graph = readJson(join(state, "knowledge-graph.json")) as GraphData | null;
  const nodeCount = graph?.nodeCount ?? Object.keys(graph?.nodes ?? {}).length;
  const edgeCount = graph?.edgeCount ?? 0;

  const domainMap = new Map<string, number>();
  if (graph?.nodes) {
    for (const node of Object.values(graph.nodes)) {
      for (const d of node.domains ?? []) {
        domainMap.set(d, (domainMap.get(d) ?? 0) + 1);
      }
    }
  }
  const domains: DomainEntry[] = [...domainMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  // ── Rule stats ──
  const ruleStats = (readJson(join(state, "rule-stats.json")) ?? []) as RuleStatEntry[];
  const activeStats = ruleStats.filter((s) => s.injectionCount > 0);
  const avgHitRate = activeStats.length > 0
    ? activeStats.reduce((sum, s) => sum + ((s.highRatingActivations ?? 0) / s.injectionCount), 0) / activeStats.length
    : 0;
  const hitRate = Math.round(avgHitRate * 100);

  const effectivenessSummary = readJson(join(state, "effectiveness-summary.json")) as { effectiveRate?: number } | null;
  const effectiveness = effectivenessSummary?.effectiveRate != null
    ? Math.round(effectivenessSummary.effectiveRate)
    : hitRate;

  let rulesPerSession = 0;
  const sessionHistoryPath = join(state, "session-context-history.jsonl");
  if (existsSync(sessionHistoryPath)) {
    try {
      const lines = readFileSync(sessionHistoryPath, "utf-8").trim().split("\n").filter(Boolean);
      const counts = lines.map(line => {
        const entry = JSON.parse(line);
        return entry.rulesInjectedCount ?? (entry.ruleIds?.length ?? 0);
      });
      if (counts.length > 0) {
        rulesPerSession = Math.round(counts.reduce((a: number, b: number) => a + b, 0) / counts.length * 10) / 10;
      }
    } catch { /* skip */ }
  }

  const avgCorrelatedRating = activeStats.length > 0
    ? Math.round((activeStats.reduce((sum, s) => sum + s.avgCorrelatedRating, 0) / activeStats.length) * 10) / 10
    : 0;

  // ── Recall/Precision — PAI eval first, then AgentGrit eval ──
  interface PaiRecallData { mean_recall15?: number; mean_precision5?: number; mean_mrr?: number }
  const paiRecallPath = join(homedir(), ".claude", "MEMORY", "LEARNING", "STATE", "recall-scores.json");
  const paiRecall = readJson(paiRecallPath) as PaiRecallData | null;
  const recallEval = paiRecall
    ? { meanRecall15: paiRecall.mean_recall15, meanPrecision5: paiRecall.mean_precision5, meanMrr: paiRecall.mean_mrr } as RecallEvalData
    : readJson(join(state, "recall-eval.json")) as RecallEvalData | null;
  const recallAt15 = recallEval?.meanRecall15 ?? 0;
  const precisionAt5 = recallEval?.meanPrecision5 ?? 0;
  const mrr = recallEval?.meanMrr ?? 0;

  // ── Signals ──
  const ratingCount = countLines(join(sigDir, "ratings.jsonl"));
  const correctionCount = countLines(join(sigDir, "correction-captures.jsonl"));

  // ── Rule performers ──
  function resolveRuleName(ruleId: string): string {
    const node = graph?.nodes?.[ruleId];
    if (node?.name && node.name !== ruleId) return node.name;
    if (node?.description) return node.description.length > 60 ? node.description.substring(0, 57) + "..." : node.description;
    return ruleId.replace(/^feedback_|^success_|^project_|^traj-/, "").replace(/[_-]/g, " ");
  }

  const validStats = activeStats.filter((s) => {
    if (s.ruleId.startsWith("traj-") && !graph?.nodes?.[s.ruleId]) return false;
    return true;
  });
  const sorted = [...validStats].sort((a, b) => (b.differentialLift ?? 0) - (a.differentialLift ?? 0));
  const topPerformers: RulePerformer[] = sorted.slice(0, 5).map((s) => ({
    id: resolveRuleName(s.ruleId),
    rating: Math.round(s.avgCorrelatedRating * 10) / 10,
    injections: s.injectionCount,
    differentialLift: Math.round((s.differentialLift ?? 0) * 1000) / 1000,
  }));
  const bottomPerformers: RulePerformer[] = sorted.slice(-5).reverse().map((s) => ({
    id: resolveRuleName(s.ruleId),
    rating: Math.round(s.avgCorrelatedRating * 10) / 10,
    injections: s.injectionCount,
    differentialLift: Math.round((s.differentialLift ?? 0) * 1000) / 1000,
  }));

  // ── Health checks ──
  const healthChecks: HealthCheck[] = [];

  healthChecks.push({
    label: "Knowledge Graph",
    status: nodeCount > 0 ? "green" : "red",
    detail: `${nodeCount} nodes, ${edgeCount} edges`,
  });
  healthChecks.push({
    label: "Signal Capture",
    status: ratingCount > 0 ? "green" : "amber",
    detail: `${ratingCount} ratings, ${correctionCount} corrections`,
  });
  healthChecks.push({
    label: "Precision@5",
    status: precisionAt5 >= 0.7 ? "green" : precisionAt5 >= 0.5 ? "amber" : "red",
    detail: precisionAt5 > 0 ? precisionAt5.toFixed(3) : "No eval data",
  });
  healthChecks.push({
    label: "Recall@15",
    status: recallAt15 >= 0.55 ? "green" : recallAt15 >= 0.3 ? "amber" : "red",
    detail: recallAt15 > 0 ? recallAt15.toFixed(3) : "No eval data",
  });
  healthChecks.push({
    label: "Rule Effectiveness",
    status: effectiveness >= 60 ? "green" : effectiveness >= 40 ? "amber" : "red",
    detail: `${effectiveness}% of tracked rules effective`,
  });

  // ── Compliance ──
  let complianceCheck: HealthCheck;
  const compDir = join(agRoot, "test", "compliance");
  if (existsSync(compDir)) {
    try {
      const result = spawnSync("bun", ["test", compDir], {
        cwd: agRoot,
        timeout: 30_000,
        encoding: "utf-8",
      });
      const output = (result.stdout ?? "") + (result.stderr ?? "");
      const passM = output.match(/(\d+)\s+pass/);
      const skipM = output.match(/(\d+)\s+skip/);
      const failM = output.match(/(\d+)\s+fail/);
      const pass = passM ? parseInt(passM[1], 10) : 0;
      const skip = skipM ? parseInt(skipM[1], 10) : 0;
      const fail = failM ? parseInt(failM[1], 10) : 0;
      complianceCheck = {
        label: "Compliance Tests",
        status: fail > 0 ? "red" : (pass === 0 && skip > 0) ? "amber" : "green",
        detail: `${pass} pass, ${skip} skip, ${fail} fail`,
      };
    } catch {
      complianceCheck = { label: "Compliance Tests", status: "red", detail: "Failed to run" };
    }
  } else {
    complianceCheck = { label: "Compliance Tests", status: "amber", detail: "No compliance directory" };
  }
  healthChecks.push(complianceCheck);

  // ── Doctor + Wiring ──
  let wiringCheck: HealthCheck;
  let doctorCheck: HealthCheck;
  try {
    const result = spawnSync("bun", ["run", join(agRoot, "bin", "agentgrit.ts"), "doctor"], {
      cwd: agRoot,
      timeout: 30_000,
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const output = (result.stdout ?? "") + (result.stderr ?? "");

    const errorCount = (output.match(/\berror\b/gi) || []).length;
    const warningCount = (output.match(/\bwarning\b/gi) || []).length;
    const okCount = (output.match(/\bok\b/gi) || []).length;
    doctorCheck = {
      label: "Doctor",
      status: errorCount > 2 ? "red" : warningCount > 5 ? "amber" : "green",
      detail: `${okCount} ok, ${warningCount} warn, ${errorCount} error`,
    };

    const orphanSummary = output.match(/(\d+)\s+orphan\s+export\(s\)\s+found\s+out\s+of\s+(\d+)\s+total/);
    const orphanCount = orphanSummary ? parseInt(orphanSummary[1], 10) : 0;
    const totalExports = orphanSummary ? parseInt(orphanSummary[2], 10) : 0;
    const orphanRate = totalExports > 0 ? orphanCount / totalExports : 0;
    wiringCheck = {
      label: "Wiring",
      status: orphanCount === 0 ? "green" : orphanRate < 0.15 ? "amber" : "red",
      detail: orphanCount === 0 ? `All ${totalExports} exports wired` : `${orphanCount} orphan export(s) of ${totalExports} (${Math.round(orphanRate * 100)}%)`,
    };

    const divergeSummary = output.match(/(\d+)\s+divergent\s+path/);
    const divergeCount = divergeSummary ? parseInt(divergeSummary[1], 10) : 0;
    healthChecks.push({
      label: "Data Integrity",
      status: divergeCount === 0 ? "green" : "amber",
      detail: divergeCount === 0 ? "No path divergence" : `${divergeCount} divergent path(s)`,
    });
  } catch {
    doctorCheck = { label: "Doctor", status: "red", detail: "Doctor failed to run" };
    wiringCheck = { label: "Wiring", status: "red", detail: "Wiring check failed" };
  }
  healthChecks.push(wiringCheck);

  // ── Tests (from cache) ──
  let testsCheck: HealthCheck;
  let testCount = 0;
  const testCache = readJson(join(state, "test-results.json")) as { pass?: number; fail?: number; timestamp?: string } | null;
  if (testCache && testCache.pass != null) {
    testCount = testCache.pass;
    const totalFail = testCache.fail ?? 0;
    const age = testCache.timestamp ? Math.round((Date.now() - new Date(testCache.timestamp).getTime()) / 3600_000) : 0;
    const staleLabel = age > 24 ? ` (${age}h ago)` : "";
    const failRate = (testCount + totalFail) > 0 ? totalFail / (testCount + totalFail) : 0;
    testsCheck = {
      label: "Tests",
      status: failRate > 0.05 ? "red" : totalFail > 0 ? "amber" : testCount > 0 ? "green" : "amber",
      detail: `${testCount} pass, ${totalFail} fail${staleLabel}`,
    };
  } else {
    testsCheck = { label: "Tests", status: "amber", detail: "No cached results — run agentgrit test" };
  }

  // ── Version ──
  const pkgPath = join(agRoot, "package.json");
  const pkg = readJson(pkgPath) as { version?: string } | null;
  const versionStr = pkg?.version ?? "unknown";
  const versionCheck: HealthCheck = {
    label: "Version",
    status: versionStr !== "unknown" ? "green" : "amber",
    detail: versionStr,
  };

  // ── Budget ──
  const budgetCap = configRaw?.thresholds?.globalBudgetCap ?? 25;
  const globalBudget = `${ruleStats.length}/${budgetCap}`;

  // ── Lifecycle ──
  const lifecycleData = readJson(join(state, "rule-lifecycle.json")) as { rules?: Record<string, { state: string }> } | null;
  const lifecycleRules = lifecycleData?.rules ?? {};
  const stateCounts: Record<string, number> = {};
  for (const entry of Object.values(lifecycleRules)) {
    stateCounts[entry.state] = (stateCounts[entry.state] || 0) + 1;
  }
  const lifecycleTotal = Object.values(stateCounts).reduce((a, b) => a + b, 0);

  const lifecycle: LifecycleCounts = {
    graduated: stateCounts["graduated"] || 0,
    evicted: stateCounts["evicted"] || 0,
    active: stateCounts["active"] || 0,
    undersampled: stateCounts["undersampled"] || 0,
    total: lifecycleTotal,
  };

  const lifecycleFunnel: FunnelStage[] = [
    { stage: "Signals", count: ratingCount, description: "Raw ratings captured" },
    { stage: "Undersampled", count: lifecycle.undersampled, description: "Less than 10 injections — needs more data" },
    { stage: "Active", count: lifecycle.active, description: "10+ injections — enough data for lift scoring" },
    { stage: "Graduated", count: lifecycle.graduated, description: "Promoted to permanent CLAUDE.md rules" },
    { stage: "Evicted", count: lifecycle.evicted, description: "Removed for low performance or negative lift" },
  ];

  // ── Eviction log ──
  const evictionLogPath = join(state, "eviction-log.jsonl");
  let evictionLogEntries = 0;
  let evictionLogUniqueRules = 0;
  if (existsSync(evictionLogPath)) {
    try {
      const lines = readFileSync(evictionLogPath, "utf-8").trim().split("\n").filter(Boolean);
      evictionLogEntries = lines.length;
      const uniqueIds = new Set<string>();
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.ruleId) uniqueIds.add(entry.ruleId);
        } catch { /* skip */ }
      }
      evictionLogUniqueRules = uniqueIds.size;
    } catch { /* skip */ }
  }

  // ── Rating trend ──
  const ratingsPath = join(homedir(), ".claude", "MEMORY", "LEARNING", "SIGNALS", "ratings.jsonl");
  let ratingTrend30: number | null = null;
  if (existsSync(ratingsPath)) {
    try {
      const lines = readFileSync(ratingsPath, "utf-8").trim().split("\n").filter(Boolean);
      const rated = lines
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((e): e is { rating: number } => e !== null && typeof e.rating === "number" && e.rating > 0);
      const last30 = rated.slice(-30);
      if (last30.length > 0) {
        ratingTrend30 = Math.round((last30.reduce((s, e) => s + e.rating, 0) / last30.length) * 100) / 100;
      }
    } catch { /* skip */ }
  }

  // ── Learning Loop ──
  const lowCorrelation = ruleStats.filter((s) => s.injectionCount > 0 && s.avgCorrelatedRating < 3).length;
  const pendingPatterns = graph?.nodes
    ? Object.values(graph.nodes).filter((n) => n.tier === "candidate" || n.status === "candidate").length
    : 0;

  const learningLoop: LearningStage[] = [
    { name: "Capture", color: "#2563eb", metric: `${ratingCount} ratings, ${correctionCount} corrections` },
    { name: "Detect", color: "#7c3aed", metric: pendingPatterns > 0 ? `${pendingPatterns} candidate patterns` : `${nodeCount} nodes clustered` },
    { name: "Promote", color: "#0891b2", metric: `${nodeCount} nodes, ${domainMap.size} domains` },
    { name: "Inject", color: "#059669", metric: `${rulesPerSession} rules/session` },
    { name: "Measure", color: "#d97706", metric: `${effectiveness}% effectiveness` },
    { name: "Evict", color: "#dc2626", metric: lowCorrelation > 0 ? `${lowCorrelation} low-correlation rules` : "no evictions pending" },
  ];

  return {
    scannedAt: new Date().toISOString(),
    doctor: doctorCheck,
    compliance: complianceCheck,
    wiring: wiringCheck,
    graph: {
      label: "Graph",
      status: nodeCount > 0 ? "green" : "red",
      detail: `${nodeCount} nodes, ${edgeCount} edges, ${domainMap.size} domains`,
    },
    tests: testsCheck,
    version: versionCheck,
    metrics: {
      ratingCount,
      correctionCount,
      nodeCount,
      edgeCount,
      effectiveness,
      hitRate,
      rulesPerSession,
      avgCorrelatedRating,
      recallAt15,
      precisionAt5,
      mrr,
      globalBudget,
      domainCount: domainMap.size,
      testCount,
      ratingTrend30,
      evictionLogEntries,
      evictionLogUniqueRules,
    },
    domains,
    topPerformers,
    bottomPerformers,
    healthChecks,
    learningLoop,
    lifecycle,
    lifecycleFunnel,
  };
}

export async function dashboardExportCommand(args: string[]): Promise<void> {
  console.log("\nagentgrit dashboard-export\n");

  const results = generateDashboardResults();
  const outDir = stateDir();
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const outPath = join(outDir, "dashboard-results.json");
  writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");

  console.log(`  Written: ${outPath}`);
  console.log(`  Keys: ${Object.keys(results).length}`);
  console.log(`  Metrics: ${Object.keys(results.metrics).length}`);
  console.log(`  Health checks: ${results.healthChecks.length}`);
  console.log("");
}
