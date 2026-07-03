#!/usr/bin/env bun
export {};

const VERSION = "0.1.0";

const COMMANDS: Record<string, { description: string; module: string }> = {
  init: { description: "Interactive setup wizard", module: "./commands/init" },
  status: { description: "Signal counts, score trends, rule budget", module: "./commands/status" },
  doctor: { description: "Health check — verify every link in the chain", module: "./commands/doctor" },
  inbox: { description: "Review and approve pending rule candidates", module: "./commands/inbox" },
  rules: { description: "List, rebalance, or compact rules", module: "./commands/rules" },
  signals: { description: "Signal file sizes and rotation", module: "./commands/signals" },
  undo: { description: "Undo recent rule promotions", module: "./commands/undo" },
  optimize: { description: "Hill-climb optimize prompts or skills", module: "./commands/optimize" },
  graph: { description: "Build, query, or inspect knowledge graph", module: "./commands/graph" },
  eval: { description: "Evaluate traces, sessions, or recall", module: "./commands/eval" },
  review: { description: "Run manual weekly learning review", module: "./commands/review" },
  export: { description: "Export graph + rules + rubrics", module: "./commands/export" },
  upgrade: { description: "Switch adoption speed (quick/standard/full)", module: "./commands/upgrade" },
  daemon: { description: "Run, start, stop daemon cycle", module: "./commands/daemon" },
};

function printUsage(): void {
  console.log(`agentgrit v${VERSION} — self-learning engine for AI agents\n`);
  console.log("Usage: agentgrit <command> [options]\n");
  console.log("Commands:");
  const maxLen = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  for (const [name, { description }] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(maxLen + 2)}${description}`);
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

  const entry = COMMANDS[command];
  if (!entry) {
    console.error(`Unknown command: ${command}\n`);
    printUsage();
    process.exit(1);
  }

  const mod = await import(entry.module);
  const handlerName = `${command}Command`;
  const handler = mod[handlerName] ?? mod.default;

  if (typeof handler !== "function") {
    console.error(`Command "${command}" does not export a handler`);
    process.exit(1);
  }

  await handler(commandArgs);
}

await main();
