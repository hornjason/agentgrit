import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getBaseDir } from "../../src/adapters/paths";
import { runDaemonCycle, runWeeklyReview, isWeeklyDay } from "../../src/daemon/daemon";
import { installScheduler, uninstallScheduler, getSchedulerStatus } from "../../src/daemon/scheduler";
import type { AgentGritConfig } from "../../src/adapters/types";

function loadConfig(base: string): AgentGritConfig | null {
  const configPath = join(base, "config.json");
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as AgentGritConfig;
  } catch {
    return null;
  }
}

async function doRun(base: string): Promise<void> {
  const config = loadConfig(base);
  if (!config) {
    console.log("  No config found. Run 'agentgrit init' first.\n");
    return;
  }

  console.log("  Running one daemon cycle...\n");

  const result = await runDaemonCycle(config);

  console.log(`  Scores:    ${result.scores.length}`);
  console.log(`  Patterns:  ${result.patterns.length}`);
  console.log(`  Promoted:  ${result.promoted}`);
  console.log(`  Synced:    ${result.synced}`);
  console.log(`  Optimized: ${result.optimized}`);

  if (result.errors.length > 0) {
    console.log(`  Errors:`);
    for (const err of result.errors) {
      console.log(`    - ${err}`);
    }
  }

  if (isWeeklyDay(config)) {
    console.log("\n  Weekly review day — running review...\n");
    const weeklyResult = await runWeeklyReview(config);
    console.log(`  Patterns found:  ${weeklyResult.review.patternsFound}`);
    console.log(`  Candidates:      ${weeklyResult.review.candidatesProposed}`);
    console.log(`  Graph rebuilt:   ${weeklyResult.graphRebuilt}`);
    if (weeklyResult.errors.length > 0) {
      console.log(`  Errors:`);
      for (const err of weeklyResult.errors) {
        console.log(`    - ${err}`);
      }
    }
  }

  console.log("\n  Cycle complete.");
}

async function doStart(base: string): Promise<void> {
  const config = loadConfig(base);
  if (!config) {
    console.log("  No config found. Run 'agentgrit init' first.\n");
    return;
  }

  const bunPath = process.execPath || "bun";
  const scriptPath = join(base, "..", ".agentgrit-daemon-entry.sh");
  const command = `${bunPath} ${join(__dirname, "..", "agentgrit.ts")} daemon run`;

  console.log("  Installing scheduler...");
  await installScheduler({
    interval: config.daemon?.interval ?? "30m",
    command,
  });
  console.log(`  Scheduler installed (interval: ${config.daemon?.interval ?? "30m"}).`);
  console.log("  Use 'agentgrit daemon status' to check.\n");
}

async function doStop(): Promise<void> {
  console.log("  Removing scheduler...");
  await uninstallScheduler();
  console.log("  Scheduler removed.\n");
}

async function doStatus(): Promise<void> {
  const status = await getSchedulerStatus();

  console.log(`  Platform:  ${status.platform}`);
  console.log(`  Installed: ${status.installed ? "yes" : "no"}`);
  console.log(`  Running:   ${status.running ? "yes" : "no"}`);
  if (status.lastRun) {
    console.log(`  Last run:  ${status.lastRun}`);
  }
}

export async function daemonCommand(args: string[]): Promise<void> {
  const base = getBaseDir();
  const sub = args[0];

  console.log("\nagentgrit daemon\n");

  if (!existsSync(base)) {
    console.log("  agentgrit not initialized. Run 'agentgrit init' first.\n");
    return;
  }

  if (sub === "run") {
    await doRun(base);
  } else if (sub === "start") {
    await doStart(base);
  } else if (sub === "stop") {
    await doStop();
  } else if (sub === "status") {
    await doStatus();
  } else {
    console.log("  Usage: agentgrit daemon <run|start|stop|status>");
    console.log("");
    console.log("  Subcommands:");
    console.log("    run      Run one daemon cycle (score, detect, promote, sync, optimize)");
    console.log("    start    Install scheduler (LaunchAgent on macOS, systemd on Linux)");
    console.log("    stop     Remove scheduler");
    console.log("    status   Check if daemon is installed and running");
  }

  console.log("");
}
