#!/usr/bin/env node
export {};

import { captureCommand } from "./commands/capture";
import { daemonCommand } from "./commands/daemon";
import { doctorCommand } from "./commands/doctor";
import { evalCommand } from "./commands/eval";
import { exportCommand } from "./commands/export";
import { graphCommand } from "./commands/graph";
import { inboxCommand } from "./commands/inbox";
import { initCommand } from "./commands/init";
import { optimizeCommand } from "./commands/optimize";
import { reviewCommand } from "./commands/review";
import { rulesCommand } from "./commands/rules";
import { signalsCommand } from "./commands/signals";
import { statusCommand } from "./commands/status";
import { undoCommand } from "./commands/undo";
import { upgradeCommand } from "./commands/upgrade";

const VERSION = "0.1.0";

const HANDLERS: Record<string, (args: string[]) => Promise<void>> = {
  capture: captureCommand,
  daemon: daemonCommand,
  doctor: doctorCommand,
  eval: evalCommand,
  export: exportCommand,
  graph: graphCommand,
  inbox: inboxCommand,
  init: initCommand,
  optimize: optimizeCommand,
  review: reviewCommand,
  rules: rulesCommand,
  signals: signalsCommand,
  status: statusCommand,
  undo: undoCommand,
  upgrade: upgradeCommand,
};

const DESCRIPTIONS: Record<string, string> = {
  capture: "Capture signals from Claude Code hooks",
  daemon: "Run, start, stop daemon cycle",
  doctor: "Health check — verify every link in the chain",
  eval: "Evaluate traces, sessions, or recall",
  export: "Export graph + rules + rubrics",
  graph: "Build, query, or inspect knowledge graph",
  inbox: "Review and approve pending rule candidates",
  init: "Interactive setup wizard",
  optimize: "Hill-climb optimize prompts or skills",
  review: "Run manual weekly learning review",
  rules: "List, rebalance, or compact rules",
  signals: "Signal file sizes and rotation",
  status: "Signal counts, score trends, rule budget",
  undo: "Undo recent rule promotions",
  upgrade: "Switch adoption speed (quick/standard/full)",
};

function printUsage(): void {
  console.log(`agentgrit v${VERSION} — self-learning engine for AI agents\n`);
  console.log("Usage: agentgrit <command> [options]\n");
  console.log("Commands:");
  const names = Object.keys(DESCRIPTIONS);
  const maxLen = Math.max(...names.map((k) => k.length));
  for (const name of names) {
    console.log(`  ${name.padEnd(maxLen + 2)}${DESCRIPTIONS[name]}`);
  }
  console.log(`\nOptions:`);
  console.log(`  --help, -h     Show this help message`);
  console.log(`  --version, -v  Show version`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    return;
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  const handler = HANDLERS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}\n`);
    printUsage();
    process.exit(1);
  }

  await handler(commandArgs);
}

await main();
