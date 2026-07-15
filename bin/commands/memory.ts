import { existsSync } from "fs";
import { join, resolve } from "path";
import { detectStaleMemories } from "../../src/promote/staleness";
import { resolveMemoryDir } from "../../src/adapters/paths";

function printHelp(): void {
  console.log("\nagentgrit memory\n");
  console.log("Subcommands:");
  console.log("  stale [path]         Show stale entries in MEMORY.md");
  console.log("    --threshold=N      Days before stale (default: 60)");
  console.log("    --json             Output as JSON");
  console.log("");
}

export async function memoryCommand(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printHelp();
    return;
  }

  if (sub === "stale") {
    await staleSubcommand(args.slice(1));
    return;
  }

  console.error(`Unknown subcommand: ${sub}`);
  printHelp();
}

async function staleSubcommand(args: string[]): Promise<void> {
  let memoryPath: string | undefined;
  let thresholdDays = 60;
  let jsonOutput = false;

  for (const arg of args) {
    if (arg.startsWith("--threshold=")) {
      thresholdDays = parseInt(arg.slice("--threshold=".length), 10);
      if (isNaN(thresholdDays) || thresholdDays <= 0) {
        console.error("Invalid threshold — must be a positive integer");
        return;
      }
    } else if (arg === "--json") {
      jsonOutput = true;
    } else if (!arg.startsWith("-")) {
      memoryPath = resolve(arg);
    }
  }

  if (!memoryPath) {
    const memDir = resolveMemoryDir();
    const candidate = join(memDir, "MEMORY.md");
    if (existsSync(candidate)) {
      memoryPath = candidate;
    }
  }

  if (!memoryPath || !existsSync(memoryPath)) {
    console.error("MEMORY.md not found. Pass a path or configure memoryDir.");
    return;
  }

  console.log(`\nagentgrit memory stale (threshold: ${thresholdDays} days)\n`);
  console.log(`  Scanning: ${memoryPath}\n`);

  const entries = await detectStaleMemories(memoryPath, { thresholdDays });

  if (entries.length === 0) {
    console.log("  No stale entries found.\n");
    return;
  }

  if (jsonOutput) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  const stale = entries.filter((e) => e.status === "stale");
  const missing = entries.filter((e) => e.status === "missing");

  if (stale.length > 0) {
    console.log(`  STALE (${stale.length}):\n`);
    for (const entry of stale) {
      console.log(`    ${entry.name.padEnd(40)} ${entry.daysStale} days`);
      console.log(`      ${entry.filePath}`);
    }
  }

  if (missing.length > 0) {
    console.log(`\n  MISSING (${missing.length}):\n`);
    for (const entry of missing) {
      console.log(`    ${entry.name.padEnd(40)} file not found`);
      console.log(`      ${entry.filePath}`);
    }
  }

  console.log(`\n  Total: ${entries.length} entries need attention\n`);
}
