import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
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
  installClaudeCodeHooks,
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

function findPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, "rubrics"))) return dir;
    dir = dirname(dir);
  }
  return dir;
}

function copyStarterRubric(base: string): void {
  const src = join(findPackageRoot(), "rubrics", "starter.json");
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
  if (!process.stdin.isTTY) {
    process.stdout.write(question);
    return "";
  }
  const { createInterface } = await import("readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
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
  const importIdx = args.indexOf("--import");
  if (importIdx !== -1) {
    const importPath = args[importIdx + 1];
    if (!importPath) {
      console.error("Usage: agentgrit init --import <backup.json>");
      process.exit(1);
    }
    return importInit(resolve(importPath));
  }

  if (args.includes("--claude-code")) {
    return claudeCodeInit(args);
  }

  const isBootstrap = args.includes("--bootstrap");

  if (isBootstrap) {
    return bootstrapInit(args);
  }

  return quickInit(args);
}

async function claudeCodeInit(args: string[]): Promise<void> {
  const settingsIdx = args.indexOf("--settings");
  const settingsPath = settingsIdx !== -1 && args[settingsIdx + 1]
    ? resolve(args[settingsIdx + 1])
    : join(homedir(), ".claude", "settings.json");

  console.log("\nagentgrit init --claude-code");
  console.log("  settings: " + settingsPath + "\n");

  const result = installClaudeCodeHooks(settingsPath);

  console.log("  Hooks installed (" + result.installed + " new, " + result.existing + " existing, " + result.skipped + " skipped)");
  console.log("\n  Hook events:");
  console.log("    SessionStart  -> npx agentgrit graph context");
  console.log("    SessionEnd    -> npx agentgrit capture sentiment");
  console.log("    PostToolUse   -> npx agentgrit capture tool");
  console.log("\nClaude Code integration complete.\n");
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

export interface ImportResult {
  graph: boolean;
  rubrics: string[];
  config: boolean;
  promotions: number;
  recallEval: boolean;
}

export async function importInit(filePath: string): Promise<ImportResult> {
  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    console.error(`Invalid JSON: ${filePath}`);
    process.exit(1);
  }

  if (!data.version || !data.exportedAt) {
    console.error("Not a valid agentgrit export file (missing version/exportedAt).");
    process.exit(1);
  }

  const base = getBaseDir();
  const DIRS = ["signals", "state", "rubrics"];
  for (const dir of DIRS) {
    const path = join(base, dir);
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
  }

  console.log(`\nagentgrit init --import`);
  console.log(`  source: ${filePath}`);
  console.log(`  exported at: ${data.exportedAt}\n`);

  const result: ImportResult = {
    graph: false,
    rubrics: [],
    config: false,
    promotions: 0,
    recallEval: false,
  };

  if (data.graph) {
    const graphPath = join(base, "state", "knowledge-graph.json");
    writeFileSync(graphPath, JSON.stringify(data.graph, null, 2));
    result.graph = true;
    console.log("  ✓ Knowledge graph restored");
  }

  if (data.rubrics && typeof data.rubrics === "object") {
    const rubrics = data.rubrics as Record<string, unknown>;
    for (const [filename, content] of Object.entries(rubrics)) {
      writeFileSync(join(base, "rubrics", filename), JSON.stringify(content, null, 2));
      result.rubrics.push(filename);
    }
    console.log(`  ✓ Rubrics restored (${result.rubrics.length} files)`);
  }

  if (data.config && typeof data.config === "object") {
    const configPath = join(base, "config.json");
    const importedConfig = data.config as Record<string, unknown>;

    if (existsSync(configPath)) {
      const existing = JSON.parse(readFileSync(configPath, "utf-8"));
      const localKeys = ["signalDir", "memoryDir", "transcriptDir", "langfuse"];
      const merged = { ...existing };
      for (const [key, value] of Object.entries(importedConfig)) {
        if (!localKeys.includes(key)) {
          merged[key] = value;
        }
      }
      writeFileSync(configPath, JSON.stringify(merged, null, 2));
      console.log("  ✓ Config merged (local paths preserved)");
    } else {
      writeFileSync(configPath, JSON.stringify(importedConfig, null, 2));
      console.log("  ✓ Config written");
    }
    result.config = true;
  }

  if (Array.isArray(data.promotions) && data.promotions.length > 0) {
    const ledgerPath = join(base, "state", "promotions.jsonl");
    const lines = data.promotions.map((p: unknown) => JSON.stringify(p));
    writeFileSync(ledgerPath, lines.join("\n") + "\n");
    result.promotions = data.promotions.length;
    console.log(`  ✓ Promotion ledger restored (${result.promotions} entries)`);
  }

  if (data.recallEval) {
    const recallPath = join(base, "state", "recall-eval.json");
    writeFileSync(recallPath, JSON.stringify(data.recallEval, null, 2));
    result.recallEval = true;
    console.log("  ✓ Recall evaluation results restored");
  }

  console.log(`\nImport complete. Run 'agentgrit status' to verify.\n`);
  return result;
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

  if (memory.totalFiles > 0) {
    const topProject = Object.entries(memory.byProject)
      .sort((a, b) => b[1] - a[1])[0];
    if (topProject) {
      config.memoryDir = join(homedir(), ".claude", "projects", topProject[0], "memory");
    }
  }

  if (speed !== "quick") {
    const apiKey = await askApiKey(speed);
    if (apiKey && config.judge) {
      config.judge = { ...config.judge, apiKey };
    }
  }

  writeConfig(base, config);

  const hookResult = installHooks(settingsPath);

  console.log(`\n  ✓ Directory structure created`);
  console.log(`  ✓ Starter rubric copied`);
  console.log(`  ✓ Config written (${speed} mode)`);
  if (signalSource.source === "pai") {
    console.log(`  ✓ Signal dir → PAI signals (in-place, no copy)`);
  }
  if (config.memoryDir) {
    console.log(`  ✓ Memory dir → ${config.memoryDir}`);
  }
  console.log(`  ✓ Hooks installed (${hookResult.installed} new, ${hookResult.existing} existing, ${hookResult.skipped} skipped)`);

  if (speed === "full") {
    console.log(`  ✓ Daemon config set (interval: ${config.daemon.interval})`);
    console.log(`    Run 'agentgrit daemon start' to activate`);
  }

  console.log(`\nBootstrap complete. Run 'agentgrit status' to verify.\n`);
}
