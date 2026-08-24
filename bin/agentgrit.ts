#!/usr/bin/env node
export {};

import { backfillCommand } from "./commands/backfill";
import { baselineCommand } from "./commands/baseline";
import { captureCommand } from "./commands/capture";
import { contextCommand } from "./commands/context";
import { dashboardCommand } from "./commands/dashboard";
import { dashboardExportCommand } from "./commands/dashboard-export";
import { daemonCommand } from "./commands/daemon";
import { doctorCommand } from "./commands/doctor";
import { evalCommand } from "./commands/eval";
import { evictCommand } from "./commands/evict";
import { exportCommand } from "./commands/export";
import { graphCommand } from "./commands/graph";
import { healthCommand } from "./commands/health";
import { inboxCommand } from "./commands/inbox";
import { initCommand } from "./commands/init";
import { memoryCommand } from "./commands/memory";
import { optimizeCommand } from "./commands/optimize";
import { patternsCommand } from "./commands/patterns";
import { reviewCommand } from "./commands/review";
import { rulesCommand } from "./commands/rules";
import { signalsCommand } from "./commands/signals";
import { statusCommand } from "./commands/status";
import { showcaseCommand } from "./commands/showcase";
import { testCommand } from "./commands/test";
import { undoCommand } from "./commands/undo";
import { upgradeCommand } from "./commands/upgrade";

const VERSION = "0.1.9";

const HANDLERS: Record<string, (args: string[]) => Promise<void>> = {
  backfill: backfillCommand,
  baseline: baselineCommand,
  capture: captureCommand,
  context: contextCommand,
  dashboard: dashboardCommand,
  "dashboard-export": dashboardExportCommand,
  daemon: daemonCommand,
  doctor: doctorCommand,
  eval: evalCommand,
  evict: evictCommand,
  export: exportCommand,
  graph: graphCommand,
  health: healthCommand,
  inbox: inboxCommand,
  init: initCommand,
  memory: memoryCommand,
  optimize: optimizeCommand,
  patterns: patternsCommand,
  review: reviewCommand,
  rules: rulesCommand,
  showcase: showcaseCommand,
  signals: signalsCommand,
  test: testCommand,
  status: statusCommand,
  undo: undoCommand,
  upgrade: upgradeCommand,
};

const DESCRIPTIONS: Record<string, string> = {
  backfill: "Run full pipeline on existing data",
  baseline: "Capture or show baseline measurement snapshot",
  capture: "Capture signals from Claude Code hooks",
  context: "Refresh session context from task text",
  dashboard: "Migration pipeline health dashboard (HTML)",
  "dashboard-export": "Export dashboard data as JSON for control plane",
  daemon: "Run, start, stop daemon cycle",
  doctor: "Health check — verify every link in the chain",
  eval: "Evaluate traces, sessions, or recall",
  evict: "Dry-run or apply auto-eviction on rule stats",
  export: "Export graph + rules + rubrics",
  graph: "Build, query, or inspect knowledge graph",
  health: "Context health — rules, budget, lifecycle, doctor",
  inbox: "Review and approve pending rule candidates",
  init: "Interactive setup wizard",
  memory: "MEMORY.md lifecycle — staleness detection",
  optimize: "Hill-climb optimize prompts or skills",
  patterns: "Generate or show domain keyword patterns",
  review: "Run manual weekly learning review",
  rules: "List, rebalance, or compact rules",
  showcase: "Generate living system dashboard (HTML)",
  signals: "Signal file sizes and rotation",
  test: "Run tests and cache results for dashboard",
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

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
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
