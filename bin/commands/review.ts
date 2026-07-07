import { existsSync } from "fs";
import { join } from "path";
import { getBaseDir, resolveSignalDir, statePath } from "../../src/adapters/paths";
import { runReview } from "../../src/promote/review";
import { getFailurePatterns } from "../../src/capture/failure-surfacing";

export async function reviewCommand(args: string[]): Promise<void> {
  const base = getBaseDir();
  const sigDir = resolveSignalDir();
  const state = join(base, "state");

  console.log("\nagentgrit review\n");

  const sub = args[0];

  if (sub === "failures") {
    const skillName = args[1] ?? "ship";
    const patternsPath = statePath("patterns.json");

    console.log(`  Failure patterns for skill: ${skillName}\n`);

    const result = getFailurePatterns(skillName, patternsPath);

    if (result.sections.length === 0) {
      console.log("  No failure patterns found.\n");
      return;
    }

    console.log(result.text);
    console.log("");
    return;
  }

  if (!existsSync(sigDir)) {
    console.log("  No signals directory. Run 'agentgrit init' first.\n");
    return;
  }

  console.log("  Running weekly learning review...\n");

  const result = await runReview(sigDir, state);

  console.log(`  Patterns found:      ${result.patternsFound}`);
  console.log(`  Candidates proposed: ${result.candidatesProposed}`);
  console.log(`  Skipped:             ${result.skipped}`);

  const { scoreTrend } = result;
  const dir = scoreTrend.direction === "up" ? "↑" : scoreTrend.direction === "down" ? "↓" : "→";
  console.log(`\n  Score trend: ${scoreTrend.avg.toFixed(1)} avg (${scoreTrend.count} ratings) ${dir}`);

  if (result.candidates.length > 0) {
    console.log(`\n  Candidates:`);
    for (const c of result.candidates) {
      console.log(`    - [sev:${c.severity}] ${c.candidateRule?.slice(0, 80)}`);
    }
    console.log(`\n  Run 'agentgrit inbox' to review and approve.`);
  }

  console.log("");
}
