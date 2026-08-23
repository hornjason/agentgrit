import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { stateDir } from "../../src/adapters/paths";
import { loadRuleStats } from "../../src/promote/rules";
import { shouldEvict, loadEvictionAllowlist, loadEvictedRegistry } from "../../src/promote/auto-eviction";

function countSessionLines(dir: string): number {
  const historyPath = join(dir, "session-context-history.jsonl");
  if (!existsSync(historyPath)) return 0;
  try {
    const content = readFileSync(historyPath, "utf-8");
    return content.split("\n").filter(l => l.trim()).length;
  } catch {
    return 0;
  }
}

export async function evictCommand(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run") || !args.includes("--yes");

  console.log(`\nagentgrit evict${dryRun ? " (dry-run)" : ""}\n`);

  const dir = stateDir();
  const statsMap = loadRuleStats();
  if (statsMap.size === 0) {
    console.log("  No rule stats found. Run 'agentgrit rules bootstrap-stats' first.\n");
    return;
  }

  const allowlist = loadEvictionAllowlist();
  const alreadyEvicted = loadEvictedRegistry();
  const totalSessions = countSessionLines(dir);

  console.log(`  Rules: ${statsMap.size} | Sessions: ${totalSessions} | Allowlisted: ${allowlist.size} | Already evicted: ${alreadyEvicted.size}\n`);

  const candidates: Array<{ ruleId: string; trigger: string; reason: string }> = [];

  for (const stats of statsMap.values()) {
    if (alreadyEvicted.has(stats.ruleId)) continue;
    const result = shouldEvict(stats, allowlist, totalSessions);
    if (result) {
      candidates.push({
        ruleId: stats.ruleId,
        trigger: result.trigger,
        reason: result.reason,
      });
    }
  }

  if (candidates.length === 0) {
    console.log("  No eviction candidates found.\n");
    return;
  }

  candidates.sort((a, b) => a.trigger.localeCompare(b.trigger));

  console.log(`  ${candidates.length} eviction candidate(s):\n`);
  for (const c of candidates) {
    console.log(`  ${dryRun ? "→" : "✓"} [${c.trigger}] ${c.ruleId}`);
    console.log(`    ${c.reason}`);
  }

  if (dryRun) {
    console.log(`\n  Dry run — pass --yes to apply evictions.\n`);
  }
}
