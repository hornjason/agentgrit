import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { getBaseDir } from "../../src/adapters/paths";
import { Tier } from "../../src/adapters/types";
import { checkBudget, type BudgetStatus } from "../../src/promote/budget";

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

function showBudget(base: string): void {
  console.log("RULE BUDGET\n");

  const globalCount = 0;
  const projectCount = 0;
  const graphCount = getGraphRuleCount(base);

  const tiers: Array<{ name: string; tier: Tier; count: number }> = [
    { name: "Global", tier: Tier.Global, count: globalCount },
    { name: "Project", tier: Tier.Project, count: projectCount },
    { name: "Graph", tier: Tier.Graph, count: graphCount },
  ];

  for (const { name, tier, count } of tiers) {
    const budget = checkBudget(tier, count);
    const cap = Number.isFinite(budget.cap) ? `/ ${budget.cap}` : "(no cap)";
    console.log(`  ${icon(budget)} ${name.padEnd(10)} ${count} ${cap}`);
  }
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
  } else if (sub === "rebalance") {
    console.log("  Rebalance: analyze rules and suggest tier re-routing.");
    console.log("  (Requires rules in graph — run 'agentgrit graph build' first)\n");
    const rules = listRulesFromGraph(base);
    console.log(`  ${rules.length} rules found in graph.`);
    console.log("  Rebalancing not yet implemented — coming in v0.2.\n");
  } else if (sub === "compact") {
    console.log("  Compact: evict low-value rules to archive.");
    console.log("  (Requires correlation data — run scoring first)\n");
    console.log("  Not yet implemented — coming in v0.2.\n");
  } else {
    showList(base);
    console.log("");
    showBudget(base);
  }

  console.log("");
}
