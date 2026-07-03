import { existsSync } from "fs";
import { join } from "path";
import { getBaseDir } from "../../src/adapters/paths";

export async function evalCommand(args: string[]): Promise<void> {
  const base = getBaseDir();
  const sub = args[0];

  console.log("\nagentgrit eval\n");

  if (!sub || sub === "--help") {
    console.log("  Usage:");
    console.log("    agentgrit eval traces [--backfill] [--local]");
    console.log("    agentgrit eval session");
    console.log("    agentgrit eval recall");
    console.log("");
    console.log("  Evaluates traces, sessions, or recall against rubrics.");
    console.log("  Requires judge API key (standard or full mode).\n");
    return;
  }

  if (!existsSync(base)) {
    console.log("  agentgrit not initialized. Run 'agentgrit init' first.\n");
    return;
  }

  if (sub === "traces") {
    const backfill = args.includes("--backfill");
    const local = args.includes("--local");
    console.log(`  Mode: traces${backfill ? " (backfill)" : ""}${local ? " (local)" : ""}`);
    console.log(`  Signals dir: ${join(base, "signals")}`);
    console.log(`\n  Trace evaluation requires a configured judge.`);
    console.log(`  Run 'agentgrit doctor' to verify setup.\n`);
  } else if (sub === "session") {
    console.log(`  Mode: session quality scoring`);
    console.log(`  Aggregates signals from current session.`);
    console.log(`  Run 'agentgrit doctor' to verify setup.\n`);
  } else if (sub === "recall") {
    console.log(`  Mode: recall accuracy`);
    console.log(`  Evaluates whether the right rules and skills fired.`);
    console.log(`  Run 'agentgrit doctor' to verify setup.\n`);
  } else {
    console.log(`  Unknown eval target: ${sub}`);
    console.log(`  Valid targets: traces, session, recall\n`);
  }
}
