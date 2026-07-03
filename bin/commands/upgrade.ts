import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getBaseDir } from "../../src/adapters/paths";
import { quick, standard, full } from "../../agentgrit.config";
import type { AgentGritConfig } from "../../src/adapters/types";

type Speed = "quick" | "standard" | "full";

const PRESETS: Record<Speed, AgentGritConfig> = { quick, standard, full };
const ORDER: Speed[] = ["quick", "standard", "full"];

function detectCurrentSpeed(config: AgentGritConfig): Speed {
  if (config.daemon?.interval === "0" || !config.daemon?.interval) return "quick";
  if (config.adapter === "both") return "full";
  if (config.judge) return "standard";
  return "quick";
}

export async function upgradeCommand(args: string[]): Promise<void> {
  const base = getBaseDir();
  const configPath = join(base, "config.json");

  console.log("\nagentgrit upgrade\n");

  if (!existsSync(configPath)) {
    console.log("  Not initialized. Run 'agentgrit init' first.\n");
    return;
  }

  const current = JSON.parse(readFileSync(configPath, "utf-8")) as AgentGritConfig;
  const currentSpeed = detectCurrentSpeed(current);

  const target = args[0] as Speed | undefined;

  if (!target) {
    console.log(`  Current mode: ${currentSpeed}`);
    console.log(`\n  Usage: agentgrit upgrade <quick|standard|full>\n`);
    return;
  }

  if (!ORDER.includes(target)) {
    console.log(`  Unknown speed: ${target}`);
    console.log(`  Valid options: quick, standard, full\n`);
    return;
  }

  if (target === currentSpeed) {
    console.log(`  Already in ${currentSpeed} mode.\n`);
    return;
  }

  const preset = PRESETS[target];
  const merged: AgentGritConfig = {
    ...preset,
    signalDir: current.signalDir,
    rubrics: current.rubrics,
  };

  if (current.judge?.apiKey && merged.judge) {
    merged.judge = { ...merged.judge, apiKey: current.judge.apiKey };
  }
  if (current.langfuse?.publicKey && merged.langfuse) {
    merged.langfuse = { ...current.langfuse };
  }

  writeFileSync(configPath, JSON.stringify(merged, null, 2), "utf-8");

  console.log(`  ✓ Upgraded: ${currentSpeed} → ${target}`);

  if (target === "full") {
    console.log(`  Run 'agentgrit daemon start' to activate the background daemon.`);
  }

  console.log("");
}
