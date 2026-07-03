import { existsSync, mkdirSync, copyFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { getBaseDir, signalsDir, stateDir, rubricsDir } from "../../src/adapters/paths";
import type { AgentGritConfig } from "../../src/adapters/types";
import { quick, standard, full } from "../../agentgrit.config";

type AdoptionSpeed = "quick" | "standard" | "full";

const PRESETS: Record<AdoptionSpeed, AgentGritConfig> = { quick, standard, full };

const DIRS = ["signals", "state", "rubrics"];

function ensureDirectories(base: string): void {
  for (const dir of DIRS) {
    const path = join(base, dir);
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
  }
}

function copyStarterRubric(base: string): void {
  const src = join(dirname(dirname(import.meta.dir)), "rubrics", "starter.json");
  const dest = join(base, "rubrics", "starter.json");
  if (existsSync(src) && !existsSync(dest)) {
    copyFileSync(src, dest);
  }
}

function writeConfig(base: string, config: AgentGritConfig): void {
  const configPath = join(base, "config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

async function promptLine(question: string): Promise<string> {
  process.stdout.write(question);
  for await (const line of console) {
    return line.trim();
  }
  return "";
}

async function askSpeed(): Promise<AdoptionSpeed> {
  console.log("\nAdoption speed:\n");
  console.log("  1. quick    — zero API keys, manual review only");
  console.log("  2. standard — one API key, LLM judge + graph");
  console.log("  3. full     — daemon + optimizer + Langfuse\n");

  const answer = await promptLine("Choose [1/2/3] (default: 1): ");

  if (answer === "2" || answer === "standard") return "standard";
  if (answer === "3" || answer === "full") return "full";
  return "quick";
}

async function askApiKey(speed: AdoptionSpeed): Promise<string | undefined> {
  if (speed === "quick") return undefined;
  const key = await promptLine("Judge API key (GEMINI_API_KEY or enter to use env): ");
  return key || undefined;
}

export async function initCommand(args: string[]): Promise<void> {
  const base = getBaseDir();
  const isReInit = existsSync(base);

  console.log(`\nagentgrit init${isReInit ? " (re-initializing)" : ""}`);
  console.log(`  directory: ${base}\n`);

  let speed: AdoptionSpeed;
  const speedArg = args.find((a) => ["--quick", "--standard", "--full"].includes(a));
  if (speedArg) {
    speed = speedArg.replace("--", "") as AdoptionSpeed;
  } else {
    speed = await askSpeed();
  }

  ensureDirectories(base);
  copyStarterRubric(base);

  const config = { ...PRESETS[speed] };
  config.signalDir = join(getBaseDir(), "signals");

  if (speed !== "quick") {
    const apiKey = await askApiKey(speed);
    if (apiKey && config.judge) {
      config.judge = { ...config.judge, apiKey };
    }
  }

  writeConfig(base, config);

  console.log(`\n  ✓ Directory structure created`);
  console.log(`  ✓ Starter rubric copied`);
  console.log(`  ✓ Config written (${speed} mode)`);

  if (speed === "full") {
    console.log(`  ✓ Daemon config set (interval: ${config.daemon.interval})`);
    console.log(`    Run 'agentgrit daemon start' to activate`);
  }

  console.log(`\nSetup complete. Run 'agentgrit status' to verify.\n`);
}
