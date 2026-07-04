import { existsSync, mkdirSync, copyFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { getBaseDir, signalsDir, stateDir, rubricsDir } from "../../src/adapters/paths";
import type { AgentGritConfig } from "../../src/adapters/types";
import { quick, standard, full } from "../../agentgrit.config";
import {
  discoverClaudeCode,
  scanRuleFiles,
  scanTranscripts,
  detectSignalSources,
  inventoryMemoryFiles,
  installHooks,
  countExistingHooks,
} from "../../src/adapters/discovery";

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
  const isBootstrap = args.includes("--bootstrap");

  if (isBootstrap) {
    return bootstrapInit(args);
  }

  return quickInit(args);
}

async function quickInit(args: string[]): Promise<void> {
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

async function bootstrapInit(args: string[]): Promise<void> {
  const base = getBaseDir();
  const isReInit = existsSync(base);

  console.log(`\nagentgrit init --bootstrap${isReInit ? " (re-initializing)" : ""}`);
  console.log("Scanning Claude Code installation...\n");

  // Step 1: Discover Claude Code
  const install = discoverClaudeCode();
  if (!install) {
    console.error("  ✗ Claude Code not found (~/.claude.json missing)");
    console.error("    Install Claude Code first: https://docs.anthropic.com/en/docs/claude-code");
    process.exit(1);
  }

  const projectPaths = Object.keys(install.projects);
  console.log(`  Claude Code home:  ${install.home}`);
  console.log(`  Projects found:    ${projectPaths.length}`);

  // Step 2: Scan rule files
  const rules = scanRuleFiles(projectPaths);
  console.log(`\n  Rule files found:`);
  for (const f of rules.files) {
    console.log(`    ${f.path} — ${f.ruleCount} rules (${f.lineCount} lines)`);
  }
  console.log(`    Total: ${rules.totalRules} rules across ${rules.files.length} files`);

  // Step 3: Scan transcripts
  const signals = scanTranscripts(projectPaths);
  console.log(`\n  Session transcripts: ${signals.sessionsScanned + signals.sessionsSkipped} total (${signals.sessionsScanned} scanned, ${signals.sessionsSkipped} skipped <50 lines)`);
  console.log(`    Ratings found:     ${signals.ratings.length}`);
  console.log(`    Corrections found: ${signals.corrections.length}`);
  console.log(`    Tools used:        ${Object.keys(signals.toolUsage).length} unique`);
  console.log(`    Skills invoked:    ${signals.skillInvocations.length}`);

  // Step 4: Detect signal sources
  const signalSource = detectSignalSources();
  if (signalSource.source === "pai") {
    console.log(`\n  PAI signals:         DETECTED`);
    if (signalSource.counts?.ratings) console.log(`    ${signalSource.counts.ratings} ratings`);
    if (signalSource.counts?.corrections) console.log(`    ${signalSource.counts.corrections} corrections`);
  } else if (signalSource.source === "agentgrit") {
    console.log(`\n  Existing AgentGrit signals: DETECTED`);
  } else {
    console.log(`\n  Existing signals:    none`);
  }

  // Step 5: Inventory memory files
  const memory = inventoryMemoryFiles(projectPaths);
  console.log(`  Auto-memory files:   ${memory.totalFiles} markdown notes`);

  // Step 6: Check existing hooks
  const settingsPath = join(install.home, "settings.json");
  const existingHookCount = countExistingHooks(settingsPath);
  console.log(`  Existing hooks:      ${existingHookCount}`);

  // ── Discovery summary printed. Now ask for speed. ──

  let speed: AdoptionSpeed;
  const speedArg = args.find((a) => ["--quick", "--standard", "--full"].includes(a));
  if (speedArg) {
    speed = speedArg.replace("--", "") as AdoptionSpeed;
  } else {
    speed = await askSpeed();
  }

  // ── Apply changes ──

  ensureDirectories(base);
  copyStarterRubric(base);

  const config = { ...PRESETS[speed] };

  if (signalSource.source === "pai") {
    config.signalDir = signalSource.signalDir;
  } else {
    config.signalDir = join(getBaseDir(), "signals");
  }

  if (speed !== "quick") {
    const apiKey = await askApiKey(speed);
    if (apiKey && config.judge) {
      config.judge = { ...config.judge, apiKey };
    }
  }

  writeConfig(base, config);

  // Hook installation disabled until capture CLI subcommands are wired (#37)
  // const hookResult = installHooks(settingsPath);

  console.log(`\n  ✓ Directory structure created`);
  console.log(`  ✓ Starter rubric copied`);
  console.log(`  ✓ Config written (${speed} mode)`);
  if (signalSource.source === "pai") {
    console.log(`  ✓ Signal dir → PAI signals (in-place, no copy)`);
  }
  console.log(`  ⏳ Hooks: skipped (capture CLI not yet wired — see #37)`);

  if (speed === "full") {
    console.log(`  ✓ Daemon config set (interval: ${config.daemon.interval})`);
    console.log(`    Run 'agentgrit daemon start' to activate`);
  }

  console.log(`\nBootstrap complete. Run 'agentgrit status' to verify.\n`);
}
