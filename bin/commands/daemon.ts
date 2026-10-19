import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getBaseDir } from "../../src/adapters/paths";
import { runDaemonCycle, runWeeklyReview, isWeeklyDay } from "../../src/daemon/daemon";
import {
  installScheduler,
  uninstallScheduler,
  getSchedulerStatus,
  checkSchedulerRegistered,
  parseSchedule,
} from "../../src/daemon/scheduler";
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
    console.log(`  Eviction candidates: ${weeklyResult.evictionCandidates.length}`);
    if (weeklyResult.evictionResult) {
      console.log(`  Evicted:         ${weeklyResult.evictionResult.evicted.length}`);
      console.log(`  Skipped (reviewed): ${weeklyResult.evictionResult.skipped.length}`);
    }
    if (weeklyResult.duplicateCandidates.length > 0) {
      console.log(`  Duplicate pairs: ${weeklyResult.duplicateCandidates.length}`);
    }
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

  const interval = config.daemon?.interval ?? "30m";
  if (!parseSchedule(interval)) {
    console.log(`  Cannot schedule daemon.interval "${interval}".`);
    console.log("  Use daily, hourly, weekly, or a duration like 30m / 2h / 1d.\n");
    process.exitCode = 1;
    return;
  }

  // Pass argv explicitly — splitting a command string on spaces breaks as soon
  // as an install path contains one.
  //
  // Schedule the interpreter and the script THIS process is running, rather
  // than pairing a discovered interpreter with a hardcoded entry. The previous
  // version took process.execPath — whichever interpreter is running, not
  // necessarily bun despite the variable's old name — and paired it with
  // bin/agentgrit.ts unconditionally. Invoked through the published shim, which
  // is `#!/usr/bin/env node` resolving to dist/agentgrit.js, that scheduled
  // `node …/bin/agentgrit.ts` and died on every run with ERR_MODULE_NOT_FOUND.
  // It worked only when run as `bun bin/agentgrit.ts`, which is the developer
  // path and the reason it survived (#277).
  //
  // Chosen together, the two cannot disagree: under the shim this is
  // `node dist/agentgrit.js`, under bun it is `bun bin/agentgrit.ts`.
  const interpreter = process.execPath;
  const entry = process.argv[1] ?? join(__dirname, "..", "agentgrit.ts");

  console.log("  Installing scheduler...");
  try {
    await installScheduler({
      interval,
      command: interpreter,
      args: [entry, "daemon", "run"],
      // Proven to start before anything is registered. `--version` exits 0
      // without touching any state.
      verifyArgs: [entry, "--version"],
    });
  } catch (err) {
    console.log(`  Failed to install scheduler: ${(err as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  // Report what the scheduler actually says, not what we just asked for.
  const status = await getSchedulerStatus();
  console.log(`  Scheduler installed (interval: ${interval}).`);
  console.log(`  Registered with ${status.platform === "darwin" ? "launchd" : "systemd"}: ${status.registered ? "yes" : "no"}`);
  console.log("  Use 'agentgrit daemon status' to check.\n");
}

async function doStop(): Promise<void> {
  console.log("  Removing scheduler...");
  await uninstallScheduler();
  console.log("  Scheduler removed.\n");
}

async function doStatus(base: string): Promise<void> {
  const status = await getSchedulerStatus();

  console.log(`  Platform:   ${status.platform}`);
  console.log(`  Label:      ${status.label}`);
  console.log(`  Plist file: ${status.installed ? "present" : "absent"}`);
  console.log(`  Registered: ${status.registered ? "yes" : "no"}`);
  if (status.lastRun) {
    console.log(`  Last run:   ${status.lastRun}`);
  }

  // A plist on disk is not a scheduled job. Say so plainly (issue #259).
  const config = loadConfig(base);
  if (config) {
    const check = await checkSchedulerRegistered(config);
    console.log("");
    console.log(`  Check: ${check.ok ? "OK" : "FAIL"} — ${check.message}`);
    if (!check.ok) process.exitCode = 1;
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
    await doStatus(base);
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
