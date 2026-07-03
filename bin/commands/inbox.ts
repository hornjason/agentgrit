import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getBaseDir, stateDir } from "../../src/adapters/paths";
import { detectFailurePatterns } from "../../src/detect/failures";
import { minePatterns } from "../../src/detect/patterns";
import { routeRule, type RouteResult } from "../../src/promote/router";
import type { Pattern } from "../../src/adapters/types";

export interface InboxItem {
  pattern: Pattern;
  route: RouteResult;
}

export async function getInboxItems(signalDir: string): Promise<InboxItem[]> {
  const [failures, patterns] = await Promise.all([
    detectFailurePatterns(signalDir, 3),
    minePatterns(signalDir),
  ]);

  const all = [...failures, ...patterns];
  const seen = new Set<string>();
  const unique: Pattern[] = [];

  for (const p of all) {
    if (!seen.has(p.id)) {
      seen.add(p.id);
      unique.push(p);
    }
  }

  return unique.map((pattern) => ({
    pattern,
    route: routeRule(pattern, pattern.sessions),
  }));
}

function formatItem(item: InboxItem, index: number): string {
  const { pattern, route } = item;
  const lines: string[] = [];

  lines.push(`─── Candidate ${index + 1} ───`);
  lines.push(`  Type:     ${pattern.type}`);
  lines.push(`  Freq:     ${pattern.frequency} occurrences across ${pattern.sessions.length} sessions`);
  lines.push(`  Severity: ${pattern.severity}/10`);
  lines.push(`  Rule:     ${pattern.candidateRule ?? "(no candidate text)"}`);
  lines.push(`  Tier:     ${route.tier}`);
  lines.push(`  Reason:   ${route.rationale}`);

  if (pattern.firstSeen) lines.push(`  First:    ${pattern.firstSeen}`);
  if (pattern.lastSeen) lines.push(`  Last:     ${pattern.lastSeen}`);

  return lines.join("\n");
}

export async function inboxCommand(args: string[]): Promise<void> {
  const base = getBaseDir();
  const sigDir = join(base, "signals");

  if (!existsSync(sigDir)) {
    console.log("No signals directory. Run 'agentgrit init' first.");
    return;
  }

  console.log("\nagentgrit inbox\n");

  const items = await getInboxItems(sigDir);

  if (items.length === 0) {
    console.log("  No pending rule candidates.\n");
    return;
  }

  console.log(`  ${items.length} pending candidate(s):\n`);

  for (let i = 0; i < items.length; i++) {
    console.log(formatItem(items[i], i));
    console.log("");
  }

  console.log(`Use 'agentgrit rules promote' to promote candidates.`);
  console.log(`Use 'agentgrit undo' to reverse recent promotions.\n`);
}
