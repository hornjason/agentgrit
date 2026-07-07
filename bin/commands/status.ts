import { existsSync, statSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { getBaseDir, resolveSignalDir, resolveSignalFile, stateDir } from "../../src/adapters/paths";
import { readSignals } from "../../src/adapters/jsonl";
import { relativeTime } from "../../src/adapters/time";
import { Tier } from "../../src/adapters/types";
import { checkBudget } from "../../src/promote/budget";
import { readSessionContext, readSessionHistory } from "../../src/graph/context";
import { loadRuleStats } from "../../src/promote/rules";

const SIGNAL_FILES = [
  "ratings.jsonl",
  "corrections.jsonl",
  "sentiment.jsonl",
  "skills.jsonl",
  "tool-audit.jsonl",
];

interface SignalSummary {
  name: string;
  count: number;
  sizeKb: number;
}

async function getSignalSummaries(dir: string): Promise<SignalSummary[]> {
  const summaries: SignalSummary[] = [];
  for (const file of SIGNAL_FILES) {
    const path = resolveSignalFile(dir, file);
    if (!existsSync(path)) {
      summaries.push({ name: file, count: 0, sizeKb: 0 });
      continue;
    }
    const signals = await readSignals(path);
    const stat = statSync(path);
    summaries.push({
      name: file,
      count: signals.length,
      sizeKb: Math.round(stat.size / 1024),
    });
  }
  return summaries;
}

function getScoreTrend(dir: string): { recent: number; prior: number } | null {
  const ratingsPath = join(dir, "ratings.jsonl");
  if (!existsSync(ratingsPath)) return null;

  const content = readFileSync(ratingsPath, "utf-8");
  const entries: { timestamp: string; rating: number }[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj.rating === "number" && obj.timestamp) {
        entries.push({ timestamp: obj.timestamp, rating: obj.rating });
      }
    } catch { /* skip */ }
  }

  if (entries.length < 2) return null;

  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  const recent = entries.filter((e) => now - new Date(e.timestamp).getTime() < sevenDays);
  const prior = entries.filter((e) => {
    const age = now - new Date(e.timestamp).getTime();
    return age >= sevenDays && age < sevenDays * 2;
  });

  const avg = (arr: { rating: number }[]) =>
    arr.length > 0 ? arr.reduce((s, e) => s + e.rating, 0) / arr.length : 0;

  return { recent: avg(recent), prior: avg(prior) };
}

function getRuleCounts(base: string): Record<string, number> {
  const counts: Record<string, number> = { global: 0, project: 0, graph: 0 };

  const graphPath = join(base, "state", "knowledge-graph.json");
  if (existsSync(graphPath)) {
    try {
      const graph = JSON.parse(readFileSync(graphPath, "utf-8"));
      counts.graph = graph.nodeCount ?? 0;
    } catch { /* skip */ }
  }

  return counts;
}

function getLastTimestamp(base: string, filename: string): string | null {
  const path = join(base, "state", filename);
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  return stat.mtime.toISOString();
}

export async function statusCommand(_args: string[]): Promise<void> {
  const base = getBaseDir();

  if (!existsSync(base)) {
    console.log("agentgrit not initialized. Run 'agentgrit init' first.");
    return;
  }

  console.log("\nagentgrit status\n");

  // Signals
  const sigDir = resolveSignalDir();
  console.log("SIGNALS");
  if (existsSync(sigDir)) {
    const summaries = await getSignalSummaries(sigDir);
    for (const s of summaries) {
      const status = s.count > 0 ? `${s.count} entries, ${s.sizeKb}KB` : "empty";
      console.log(`  ${s.name.padEnd(24)}${status}`);
    }
  } else {
    console.log("  No signals directory");
  }

  // Score trends
  console.log("\nSCORE TRENDS");
  const trend = getScoreTrend(sigDir);
  if (trend) {
    const dir = trend.recent > trend.prior ? "↑" : trend.recent < trend.prior ? "↓" : "→";
    console.log(`  Last 7 days: ${trend.recent.toFixed(1)} ${dir}  Prior 7 days: ${trend.prior.toFixed(1)}`);
  } else {
    console.log("  Not enough data");
  }

  // Rule budget
  console.log("\nRULE BUDGET");
  const ruleCounts = getRuleCounts(base);
  for (const [tier, count] of Object.entries(ruleCounts)) {
    const t = tier as Tier;
    const budget = checkBudget(t === "graph" ? Tier.Graph : t === "global" ? Tier.Global : Tier.Project, count);
    const cap = Number.isFinite(budget.cap) ? `/ ${budget.cap}` : "(no cap)";
    const indicator = budget.level === "OK" ? "✓" : budget.level === "WARNING" ? "⚠" : "✗";
    console.log(`  ${indicator} ${tier.padEnd(10)} ${count} ${cap}`);
  }

  // Rule Load
  console.log("\nRULE LOAD");
  const currentCtx = readSessionContext();
  if (currentCtx) {
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const history = readSessionHistory(100);
    const recentSessions = history.filter(
      (s) => Date.now() - new Date(s.timestamp).getTime() < sevenDaysMs,
    );
    let avgLine = "";
    if (recentSessions.length > 0) {
      const avgCount = recentSessions.reduce((s, e) => s + (e.rulesInjectedCount ?? 0), 0) / recentSessions.length;
      const avgKB = recentSessions.reduce((s, e) => s + (e.rulesInjectedKB ?? 0), 0) / recentSessions.length;
      avgLine = ` | 7-day avg: ${Math.round(avgCount)} (${avgKB.toFixed(1)} KB)`;
    }
    console.log(`  Rules loaded: ${currentCtx.rulesInjectedCount ?? 0} (${(currentCtx.rulesInjectedKB ?? 0).toFixed(1)} KB)${avgLine}`);
  } else {
    console.log("  No session context");
  }

  // Rule Correlation
  console.log("\nRULE CORRELATION");
  const statsMap = loadRuleStats();
  const allStats = Array.from(statsMap.values()).filter((s) => s.injectionCount >= 5);
  if (allStats.length > 0) {
    const sorted = [...allStats].sort((a, b) => b.avgCorrelatedRating - a.avgCorrelatedRating);
    const top5 = sorted.slice(0, 5);
    const bottom5 = sorted.slice(-5).reverse();

    console.log("  Highest Correlated:");
    for (const s of top5) {
      console.log(`    ${s.ruleId.padEnd(40)} ${s.avgCorrelatedRating.toFixed(1)}`);
    }
    console.log("  Lowest Correlated:");
    for (const s of bottom5) {
      console.log(`    ${s.ruleId.padEnd(40)} ${s.avgCorrelatedRating.toFixed(1)}`);
    }
  } else {
    console.log("  Not enough data (rules need 5+ injections)");
  }

  // Timestamps
  console.log("\nTIMESTAMPS");
  const graphTs = getLastTimestamp(base, "knowledge-graph.json");
  const ledgerTs = getLastTimestamp(base, "promotions.jsonl");
  console.log(`  Last graph build:   ${graphTs ? relativeTime(graphTs) : "never"}`);
  console.log(`  Last promotion:     ${ledgerTs ? relativeTime(ledgerTs) : "never"}`);

  console.log("");
}
