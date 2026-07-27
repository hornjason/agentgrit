import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getBaseDir, stateDir, loadConfig, resolveSignalFile } from "../../src/adapters/paths";
import { renderShowcase } from "../../src/showcase/template";
import type { ShowcaseMetrics, DomainEntry, RulePerformer, HealthCheck } from "../../src/showcase/template";

function countLines(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  const content = readFileSync(filePath, "utf-8").trim();
  if (!content) return 0;
  return content.split("\n").length;
}

function readJson(filePath: string): unknown {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

interface RuleStatEntry {
  ruleId: string;
  injectionCount: number;
  avgCorrelatedRating: number;
  sessionRatings: number[];
  highRatingActivations: number;
  lowRatingActivations: number;
  lastSeen: string;
}

interface RecallEvalData {
  meanRecall15?: number;
  meanPrecision5?: number;
  meanMrr?: number;
}

interface GraphData {
  nodeCount?: number;
  edgeCount?: number;
  nodes?: Record<string, { domains: string[] }>;
}

function gatherMetrics(): ShowcaseMetrics {
  const config = loadConfig();
  const base = getBaseDir();
  const state = stateDir();
  const signalDir = config.signalDir ?? join(base, "signals");

  const ratingsPath = resolveSignalFile(signalDir, "ratings.jsonl");
  const correctionsPath = resolveSignalFile(signalDir, "correction-captures.jsonl");

  const ratingCount = countLines(ratingsPath);
  const correctionCount = countLines(correctionsPath);

  const graph = readJson(join(state, "knowledge-graph.json")) as GraphData | null;
  const nodeCount = graph?.nodeCount ?? 0;
  const edgeCount = graph?.edgeCount ?? 0;

  const domains = new Map<string, number>();
  if (graph?.nodes) {
    for (const node of Object.values(graph.nodes)) {
      for (const d of node.domains ?? []) {
        domains.set(d, (domains.get(d) ?? 0) + 1);
      }
    }
  }
  const domainEntries: DomainEntry[] = [...domains.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  const ruleStats = (readJson(join(state, "rule-stats.json")) ?? []) as RuleStatEntry[];
  const activeStats = ruleStats.filter((s) => s.injectionCount > 0);

  const effective = activeStats.filter((s) => s.avgCorrelatedRating >= 5).length;
  const effectiveness = activeStats.length > 0 ? Math.round((effective / activeStats.length) * 100) : 0;

  const totalInjections = activeStats.reduce((sum, s) => sum + s.injectionCount, 0);
  const rulesPerSession = activeStats.length > 0 ? Math.round(totalInjections / activeStats.length) : 0;

  const overallAvg = activeStats.length > 0
    ? activeStats.reduce((sum, s) => sum + s.avgCorrelatedRating, 0) / activeStats.length
    : 0;

  const recallEval = readJson(join(state, "recall-eval.json")) as RecallEvalData | null;

  const graphNodes = graph?.nodes as Record<string, { name?: string; description?: string; domains?: string[] }> | undefined;
  function resolveRuleName(ruleId: string): string {
    const node = graphNodes?.[ruleId];
    if (node?.name && node.name !== ruleId) return node.name;
    if (node?.description) return node.description.length > 60 ? node.description.substring(0, 57) + "..." : node.description;
    return ruleId.replace(/^feedback_|^success_|^project_|^traj-/, "").replace(/[_-]/g, " ");
  }

  const validStats = activeStats.filter((s) => {
    if (s.ruleId.startsWith("traj-") && !graphNodes?.[s.ruleId]) return false;
    return true;
  });

  const sorted = [...validStats].sort((a, b) => b.avgCorrelatedRating - a.avgCorrelatedRating);
  const topPerformers: RulePerformer[] = sorted.slice(0, 5).map((s) => ({
    id: resolveRuleName(s.ruleId),
    rating: s.avgCorrelatedRating,
    injections: s.injectionCount,
  }));
  const bottomPerformers: RulePerformer[] = sorted.slice(-5).reverse().map((s) => ({
    id: resolveRuleName(s.ruleId),
    rating: s.avgCorrelatedRating,
    injections: s.injectionCount,
  }));

  const healthChecks: HealthCheck[] = [];

  healthChecks.push({
    label: "Knowledge Graph",
    status: nodeCount > 0 ? "green" : "red",
    detail: nodeCount > 0 ? `${nodeCount} nodes, ${edgeCount} edges` : "No graph built",
  });

  healthChecks.push({
    label: "Signal Capture",
    status: ratingCount > 0 ? "green" : "amber",
    detail: `${ratingCount} ratings, ${correctionCount} corrections`,
  });

  const p5 = recallEval?.meanPrecision5 ?? 0;
  healthChecks.push({
    label: "Precision@5",
    status: p5 >= 0.7 ? "green" : p5 >= 0.5 ? "amber" : "red",
    detail: p5 > 0 ? p5.toFixed(3) : "No eval data",
  });

  const r15 = recallEval?.meanRecall15 ?? 0;
  healthChecks.push({
    label: "Recall@15",
    status: r15 >= 0.55 ? "green" : r15 >= 0.3 ? "amber" : "red",
    detail: r15 > 0 ? r15.toFixed(3) : "No eval data",
  });

  healthChecks.push({
    label: "Rule Effectiveness",
    status: effectiveness >= 60 ? "green" : effectiveness >= 40 ? "amber" : "red",
    detail: `${effectiveness}% of tracked rules effective`,
  });

  const budgetUsed = ruleStats.length;
  const budgetCap = config.rules?.globalBudget ?? 25;

  let testCount = 0;
  const pkgPath = join(base, "..", "agentgrit", "package.json");
  const altPkgPath = join(process.cwd(), "package.json");
  const pkg = readJson(existsSync(pkgPath) ? pkgPath : altPkgPath) as { version?: string } | null;

  try {
    const specContent = readFileSync(join(base, "..", "agentgrit", "docs", "SYSTEM-SPEC.md"), "utf-8");
    const testMatch = specContent.match(/(\d[\d,]+)\s+(?:tests?\s+)?pass/i);
    if (testMatch) testCount = parseInt(testMatch[1].replace(/,/g, ""), 10);
  } catch {
    // fall through
  }

  return {
    generatedAt: new Date().toISOString(),
    ratingCount,
    correctionCount,
    nodeCount,
    edgeCount,
    domainCount: domains.size,
    effectiveness,
    rulesPerSession,
    scoreTrend: overallAvg,
    recallAt15: recallEval?.meanRecall15 ?? 0,
    precisionAt5: recallEval?.meanPrecision5 ?? 0,
    mrr: recallEval?.meanMrr ?? 0,
    budgetGlobal: `${budgetUsed}/${budgetCap}`,
    domains: domainEntries,
    topPerformers,
    bottomPerformers,
    healthChecks,
    version: pkg?.version ?? "0.1.4",
    testCount,
  };
}

export async function generateShowcase(): Promise<string> {
  const metrics = gatherMetrics();
  const html = renderShowcase(metrics);
  const outDir = stateDir();
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "showcase.html");
  writeFileSync(outPath, html, "utf-8");
  return outPath;
}

export async function showcaseCommand(args: string[]): Promise<void> {
  console.log("\nagentgrit showcase\n");

  const base = getBaseDir();
  if (!existsSync(base)) {
    console.log("  agentgrit not initialized. Run 'agentgrit init' first.\n");
    return;
  }

  if (args.includes("--stdout")) {
    const metrics = gatherMetrics();
    const html = renderShowcase(metrics);
    process.stdout.write(html);
    return;
  }

  const outPath = await generateShowcase();
  console.log(`  Generated: ${outPath}`);

  if (args.includes("--open")) {
    const { exec } = await import("child_process");
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    exec(`${cmd} "${outPath}"`);
    console.log("  Opened in browser.");
  }

  console.log("");
}
