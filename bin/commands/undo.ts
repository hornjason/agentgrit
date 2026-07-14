import { getBaseDir, stateDir } from "../../src/adapters/paths";
import { undoPromotions, getPromotionHistory } from "../../src/promote/ledger";
import { relativeTime } from "../../src/adapters/time";
import { join } from "path";

export async function undoCommand(args: string[]): Promise<void> {
  const base = getBaseDir();
  const state = join(base, "state");

  console.log("\nagentgrit undo\n");

  const history = getPromotionHistory(state);

  if (history.length === 0) {
    console.log("  No promotion history to undo.\n");
    return;
  }

  const positional = args.filter((a) => !a.startsWith("--"));
  const count = positional[0] ? parseInt(positional[0], 10) : 1;
  if (isNaN(count) || count < 1) {
    console.log("  Usage: agentgrit undo [count] [--yes]\n");
    return;
  }

  const toUndo = history.slice(-count);

  console.log(`  Will undo ${toUndo.length} promotion(s):\n`);
  for (const record of toUndo) {
    console.log(`    - ${record.ruleId} → ${record.tier} (${relativeTime(record.timestamp)})`);
  }

  if (!args.includes("--yes")) {
    console.log(`\n  Pass --yes to confirm.\n`);
    return;
  }

  const undone = await undoPromotions(count, state);
  console.log(`\n  ✓ Undid ${undone.length} promotion(s).\n`);
}
