import { getBaseDir } from "../../src/adapters/paths";
import { join } from "path";

export async function optimizeCommand(args: string[]): Promise<void> {
  const base = getBaseDir();
  const sub = args[0];

  console.log("\nagentgrit optimize\n");

  if (!sub || sub === "--help") {
    console.log("  Usage:");
    console.log("    agentgrit optimize prompts [--dimension <name>] [--rounds <n>]");
    console.log("    agentgrit optimize skills [--skill <name>] [--rounds <n>]");
    console.log("    agentgrit optimize prompts --auto");
    console.log("");
    console.log("  Runs hill-climbing optimization on the specified target.");
    console.log("  Requires judge API key (standard or full mode).\n");
    return;
  }

  const roundsIdx = args.indexOf("--rounds");
  const rounds = roundsIdx !== -1 && args[roundsIdx + 1] ? parseInt(args[roundsIdx + 1], 10) : 3;

  if (sub === "prompts") {
    const dimIdx = args.indexOf("--dimension");
    const dimension = dimIdx !== -1 ? args[dimIdx + 1] : undefined;
    console.log(`  Target: prompts`);
    console.log(`  Rounds: ${rounds}`);
    if (dimension) console.log(`  Dimension: ${dimension}`);
    console.log(`  State dir: ${join(base, "state")}`);
    console.log(`\n  Optimization requires a configured judge. Run 'agentgrit doctor' to verify.\n`);
  } else if (sub === "skills") {
    const skillIdx = args.indexOf("--skill");
    const skill = skillIdx !== -1 ? args[skillIdx + 1] : undefined;
    console.log(`  Target: skills`);
    console.log(`  Rounds: ${rounds}`);
    if (skill) console.log(`  Skill: ${skill}`);
    console.log(`\n  Optimization requires a configured judge. Run 'agentgrit doctor' to verify.\n`);
  } else {
    console.log(`  Unknown optimize target: ${sub}`);
    console.log(`  Valid targets: prompts, skills\n`);
  }
}
