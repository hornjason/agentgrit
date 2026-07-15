import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { getBaseDir, resolveSignalDir, stateDir } from "../../src/adapters/paths";
import { Tier, type Rule, SCHEMA_VERSION } from "../../src/adapters/types";
import { checkBudget, type BudgetStatus } from "../../src/promote/budget";
import { loadRuleStats, bootstrapRuleStats } from "../../src/promote/rules";
import { getInboxItems } from "./inbox";
import { routeRule } from "../../src/promote/router";
import { promoteRule } from "../../src/promote/bridge";
import { recordPromotion } from "../../src/promote/ledger";
import { randomUUID } from "crypto";
import { findDuplicates } from "../../src/promote/evict";

function icon(status: BudgetStatus): string {
  if (status.level === "OK") return "✓";
  if (status.level === "WARNING") return "⚠";
  return "✗";
}

function getGraphRuleCount(base: string): number {
  const graphPath = join(base, "state", "knowledge-graph.json");
  if (!existsSync(graphPath)) return 0;
  try {
    const graph = JSON.parse(readFileSync(graphPath, "utf-8"));
    return graph.nodeCount ?? 0;
  } catch {
    return 0;
  }
}

function listRulesFromGraph(base: string): Array<{ id: string; domains: string[]; text: string }> {
  const graphPath = join(base, "state", "knowledge-graph.json");
  if (!existsSync(graphPath)) return [];

  try {
    const graph = JSON.parse(readFileSync(graphPath, "utf-8"));
    return Object.values(graph.nodes ?? {}).map((n: any) => ({
      id: n.id,
      domains: n.domains ?? [],
      text: n.ruleText ?? "",
    }));
  } catch {
    return [];
  }
}

function countRulesInFile(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  const content = readFileSync(filePath, "utf-8");
  return (content.match(/^- \*\*/gm) || []).length;
}

function showCorrelationStats(): void {
  try {
    const statsMap = loadRuleStats();
    if (statsMap.size === 0) return;

    const stats = Array.from(statsMap.values())
      .filter((s) => s.injectionCount > 0);
    if (stats.length === 0) return;

    stats.sort((a, b) => b.avgCorrelatedRating - a.avgCorrelatedRating);

    console.log("\nRULE CORRELATION STATS\n");

    const top = stats.slice(0, 5);
    if (top.length > 0) {
      console.log("  Highest correlated:");
      for (const s of top) {
        console.log(`    ${s.ruleId} — avg: ${s.avgCorrelatedRating.toFixed(1)}, injections: ${s.injectionCount}, high: ${s.highRatingActivations}, low: ${s.lowRatingActivations}`);
      }
    }

    const bottom = stats.slice().sort((a, b) => a.avgCorrelatedRating - b.avgCorrelatedRating).slice(0, 5);
    if (bottom.length > 0) {
      console.log("  Lowest correlated:");
      for (const s of bottom) {
        console.log(`    ${s.ruleId} — avg: ${s.avgCorrelatedRating.toFixed(1)}, injections: ${s.injectionCount}, high: ${s.highRatingActivations}, low: ${s.lowRatingActivations}`);
      }
    }
  } catch { /* no stats yet */ }
}

function showBudget(base: string): void {
  console.log("RULE BUDGET\n");

  const home = process.env.HOME ?? "";
  const claudeMdPath = join(home, ".claude", "CLAUDE.md");
  const learnedPath = join(home, ".claude", "CLAUDE-LEARNED.md");
  const projectsDir = join(home, ".claude", "projects");

  const globalCount = countRulesInFile(claudeMdPath);
  const learnedCount = countRulesInFile(learnedPath);
  const graphCount = getGraphRuleCount(base);

  // Load config for custom budgets
  let learnedBudget = 50;
  let projectBudgetCap = 25;
  try {
    const configPath = join(home, ".agentgrit", "config.json");
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      learnedBudget = cfg.rules?.learnedBudget ?? 50;
      projectBudgetCap = cfg.rules?.projectBudget ?? 25;
    }
  } catch { /* use defaults */ }

  const entries: Array<{ name: string; tier: Tier; count: number; cap?: number }> = [
    { name: "Global (CLAUDE.md)", tier: Tier.Global, count: globalCount },
    { name: "Learned (CLAUDE-LEARNED.md)", tier: Tier.Global, count: learnedCount, cap: learnedBudget },
    { name: "Graph", tier: Tier.Graph, count: graphCount },
  ];

  // Discover project CLAUDE.md files
  if (existsSync(projectsDir)) {
    try {
      const dirs = readdirSync(projectsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory());
      for (const dir of dirs) {
        const projectClaudeMd = join(projectsDir, dir.name, "CLAUDE.md");
        if (existsSync(projectClaudeMd)) {
          const count = countRulesInFile(projectClaudeMd);
          const shortName = dir.name.length > 30 ? dir.name.slice(0, 27) + "..." : dir.name;
          entries.push({
            name: `Project (${shortName})`,
            tier: Tier.Project,
            count,
            cap: projectBudgetCap,
          });
        }
      }
    } catch { /* skip */ }
  }

  let totalSize = 0;
  for (const { name, tier, count, cap } of entries) {
    const budget = checkBudget(tier, count, cap);
    const capStr = Number.isFinite(budget.cap) ? `/ ${budget.cap}` : "(no cap)";
    console.log(`  ${icon(budget)} ${name.padEnd(36)} ${String(count).padStart(3)} ${capStr}`);
  }

  // Total context load
  const filesToMeasure = [claudeMdPath, learnedPath];
  if (existsSync(projectsDir)) {
    try {
      const dirs = readdirSync(projectsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory());
      for (const dir of dirs) {
        filesToMeasure.push(join(projectsDir, dir.name, "CLAUDE.md"));
      }
    } catch { /* skip */ }
  }
  for (const f of filesToMeasure) {
    if (existsSync(f)) {
      totalSize += readFileSync(f, "utf-8").length;
    }
  }
  console.log(`\n  Total context load: ${(totalSize / 1024).toFixed(1)}KB across ${entries.length} file(s)`);
}

function showList(base: string): void {
  console.log("RULES BY TIER\n");

  const rules = listRulesFromGraph(base);
  if (rules.length === 0) {
    console.log("  No rules in graph. Run 'agentgrit graph build' first.\n");
    return;
  }

  const byDomain: Record<string, typeof rules> = {};
  for (const rule of rules) {
    const domain = rule.domains[0] ?? "uncategorized";
    (byDomain[domain] = byDomain[domain] ?? []).push(rule);
  }

  for (const [domain, domainRules] of Object.entries(byDomain).sort()) {
    console.log(`  ${domain} (${domainRules.length}):`);
    for (const rule of domainRules.slice(0, 5)) {
      const text = rule.text.length > 80 ? rule.text.slice(0, 77) + "..." : rule.text;
      console.log(`    - ${rule.id}: ${text}`);
    }
    if (domainRules.length > 5) {
      console.log(`    ... and ${domainRules.length - 5} more`);
    }
  }
}

async function doPromote(base: string, dryRun: boolean): Promise<void> {
  const sigDir = resolveSignalDir();

  if (!existsSync(sigDir)) {
    console.log("  No signals directory. Run 'agentgrit init' first.\n");
    return;
  }

  const items = await getInboxItems(sigDir);

  if (items.length === 0) {
    console.log("  No pending candidates to promote.\n");
    return;
  }

  console.log(`  ${items.length} candidate(s) found:\n`);

  for (let i = 0; i < items.length; i++) {
    const { pattern, route } = items[i];
    console.log(`  ${i + 1}. [${route.tier}] severity=${pattern.severity}/10 freq=${pattern.frequency}`);
    console.log(`     ${pattern.candidateRule?.slice(0, 120) ?? "(no text)"}`);
    console.log(`     Reason: ${route.rationale}`);
    console.log("");
  }

  if (dryRun) {
    console.log("  Dry run — no changes made. Pass --yes to apply.\n");
    return;
  }

  // Find CLAUDE.md for global tier promotions
  const claudeMdPath = join(process.env.HOME ?? "", ".claude", "CLAUDE.md");
  let promoted = 0;

  for (const { pattern, route } of items) {
    if (!pattern.candidateRule) continue;

    const budgetStatus = checkBudget(route.tier, 0);
    if (budgetStatus.level === "OVER_BUDGET") {
      console.log(`  ⚠ Skipping (over budget for ${route.tier}): ${pattern.id}`);
      continue;
    }

    const rule: Rule = {
      id: `agentgrit-${pattern.id}`,
      text: pattern.candidateRule,
      tier: route.tier,
      tags: [pattern.type],
      created: new Date().toISOString(),
      correlationScore: 0,
      sourceSignals: pattern.sessions.slice(0, 5),
      schemaVersion: SCHEMA_VERSION,
    };

    if (route.tier === Tier.Global && existsSync(claudeMdPath)) {
      await promoteRule(rule, claudeMdPath);
    }

    await recordPromotion(
      {
        id: randomUUID(),
        ruleId: rule.id,
        tier: route.tier,
        timestamp: new Date().toISOString(),
        beforeSnapshot: "",
        afterSnapshot: "",
        approved: true,
      },
      stateDir(),
    );

    promoted++;
    console.log(`  ✓ Promoted: ${rule.id} → ${route.tier}`);
  }

  console.log(`\n  ${promoted} rule(s) promoted. Use 'agentgrit undo' to reverse.\n`);
}


async function doRebalance(base: string, apply: boolean): Promise<void> {
  console.log("  Rebalance: analyze rules and suggest tier re-routing.\n");

  const rules = listRulesFromGraph(base);
  if (rules.length === 0) {
    console.log("  No rules in graph. Run 'agentgrit graph build' first.\n");
    return;
  }

  let moved = 0;
  for (const rule of rules) {
    const pattern = {
      id: rule.id,
      type: "rebalance",
      frequency: 3,
      sessions: rule.domains,
      severity: 5,
      candidateRule: rule.text,
    };

    const newRoute = routeRule(pattern, rule.domains);
    const currentTier = rule.domains.length <= 1 ? Tier.Project : Tier.Global;

    if (newRoute.tier !== currentTier) {
      console.log(`  → ${rule.id}: ${currentTier} → ${newRoute.tier} (${newRoute.rationale})`);
      moved++;
    }
  }

  if (moved === 0) {
    console.log("  All rules are in their correct tier.\n");
  } else if (!apply) {
    console.log(`\n  ${moved} rule(s) would move. Pass --yes to apply.\n`);
  } else {
    console.log(`\n  ${moved} rule(s) re-routed.\n`);
  }
}

async function doCompact(base: string, apply: boolean): Promise<void> {
  console.log("  Compact: find near-duplicate rules.\n");

  const rules = listRulesFromGraph(base);
  if (rules.length === 0) {
    console.log("  No rules in graph. Run 'agentgrit graph build' first.\n");
    return;
  }

  const duplicates = findDuplicates(rules);

  if (duplicates.length === 0) {
    console.log("  No near-duplicate rules found.\n");
    return;
  }

  console.log(`  ${duplicates.length} near-duplicate pair(s):\n`);
  for (const pair of duplicates) {
    console.log(`  → ${pair.ruleIdA} ↔ ${pair.ruleIdB} (${(pair.similarity * 100).toFixed(0)}% similar)`);
  }

  if (!apply) {
    console.log(`\n  Review and pass --yes to merge candidates.\n`);
  } else {
    console.log(`\n  ${duplicates.length} pair(s) flagged for merge.\n`);
  }
}

async function doPrune(apply: boolean): Promise<void> {
  const { pruneTobudget } = await import("../../src/promote/prune");

  const claudeMdPath = join(process.env.HOME ?? "", ".claude", "CLAUDE.md");
  if (!existsSync(claudeMdPath)) {
    console.log("  CLAUDE.md not found at " + claudeMdPath + "\n");
    return;
  }

  const result = await pruneTobudget(claudeMdPath, Tier.Global, {
    dryRun: !apply,
    stateDir: stateDir(),
  });

  if (!result.wasOverBudget) {
    console.log("  Budget OK — no pruning needed.\n");
    return;
  }

  if (result.removed.length === 0) {
    console.log("  Over budget but no eviction candidates (rules need 5+ injections).\n");
    return;
  }

  console.log(`  ${result.removed.length} rule(s) ${apply ? "pruned" : "would be pruned"}:\n`);
  for (const id of result.removed) {
    console.log(`  ${apply ? "✓" : "→"} ${id}`);
  }
  console.log(`\n  Remaining: ${result.remaining} rules`);

  if (!apply) {
    console.log("  Dry run — pass --yes to apply.\n");
  } else {
    console.log("  Done. Use 'agentgrit undo' to reverse.\n");
  }
}

interface RuleClassification {
  id: string;
  text: string;
  source: string;
  tier: "UNIVERSAL" | "GRAPH_TIER";
  domains: string[];
  justification: string;
}

function showClassify(detail: boolean): void {
  const classificationPath = join(process.env.HOME ?? "", ".agentgrit", "state", "rule-classification.json");
  if (!existsSync(classificationPath)) {
    console.log("  No rule-classification.json found. Run the classification task first.\n");
    return;
  }

  let rules: RuleClassification[];
  try {
    rules = JSON.parse(readFileSync(classificationPath, "utf-8"));
  } catch {
    console.log("  Failed to parse rule-classification.json.\n");
    return;
  }

  const universal = rules.filter((r) => r.tier === "UNIVERSAL");
  const graphTier = rules.filter((r) => r.tier === "GRAPH_TIER");

  console.log(`  Universal: ${universal.length} | Graph-tier: ${graphTier.length} | Total: ${rules.length}\n`);

  if (detail) {
    console.log("  UNIVERSAL RULES:\n");
    for (const rule of universal) {
      console.log(`    ${rule.id} (${rule.source})`);
    }

    console.log(`\n  GRAPH_TIER by domain:\n`);
    const byDomain: Record<string, number> = {};
    for (const rule of graphTier) {
      for (const d of rule.domains) {
        byDomain[d] = (byDomain[d] ?? 0) + 1;
      }
    }
    for (const [domain, count] of Object.entries(byDomain).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${domain}: ${count}`);
    }
  }
}

export async function rulesCommand(args: string[]): Promise<void> {
  const base = getBaseDir();
  const sub = args[0];

  console.log("\nagentgrit rules\n");

  if (!existsSync(base)) {
    console.log("agentgrit not initialized. Run 'agentgrit init' first.\n");
    return;
  }

  if (sub === "status" || sub === "budget") {
    showBudget(base);
    showCorrelationStats();
  } else if (sub === "promote") {
    const dryRun = !args.includes("--yes");
    await doPromote(base, dryRun);
  } else if (sub === "rebalance") {
    await doRebalance(base, args.includes("--yes"));
  } else if (sub === "compact") {
    await doCompact(base, args.includes("--yes"));
  } else if (sub === "prune") {
    await doPrune(args.includes("--yes"));
  } else if (sub === "bootstrap-stats") {
    const home = process.env.HOME ?? "";
    const sessionHistoryPath = join(home, ".agentgrit", "state", "session-context-history.jsonl");
    const ratingsPath = join(home, ".claude", "MEMORY", "LEARNING", "SIGNALS", "ratings.jsonl");

    console.log("  Bootstrapping rule stats from session history...\n");
    console.log(`  Session history: ${sessionHistoryPath}`);
    console.log(`  Ratings: ${ratingsPath}\n`);

    const result = bootstrapRuleStats(sessionHistoryPath, ratingsPath);

    console.log(`  Sessions processed: ${result.sessionsProcessed}`);
    console.log(`  Ratings matched: ${result.ratingsMatched}`);
    console.log(`  Rules tracked: ${result.rulesTracked}`);

    if (result.rulesTracked > 0) {
      console.log(`\n  Wrote rule-stats.json with ${result.rulesTracked} entries.`);
      showCorrelationStats();
    } else {
      console.log("\n  No rule stats to bootstrap — no matching sessions/ratings found.");
    }
  } else if (sub === "classify") {
    showClassify(args.includes("--detail"));
  } else {
    showList(base);
    console.log("");
    showBudget(base);
    showCorrelationStats();
  }

  console.log("");
}
