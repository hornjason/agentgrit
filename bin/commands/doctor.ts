import { loadConfig, getBaseDir, resolveSignalDir, resolveSignalFile } from "../../src/adapters/paths";
import {
  runDoctor as runDoctorSrc,
  type CheckStatus,
} from "../../src/daemon/doctor";
import { existsSync, statSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { relativeTime } from "../../src/adapters/time";

export interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  suggestion?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  passed: number;
  warned: number;
  failed: number;
}

function mapStatus(s: CheckStatus): "pass" | "warn" | "fail" {
  if (s === "ok") return "pass";
  if (s === "warning") return "warn";
  return "fail";
}

export function runDoctor(): DoctorReport {
  const base = getBaseDir();
  const checks: DoctorCheck[] = [];

  function checkDir(path: string, name: string): DoctorCheck {
    if (!existsSync(path)) return { name, status: "fail", message: `${name} directory missing`, suggestion: `Run 'agentgrit init'` };
    return { name, status: "pass", message: `${name} directory exists` };
  }

  checks.push(checkDir(base, "base"));
  checks.push(checkDir(join(base, "signals"), "signals"));
  checks.push(checkDir(join(base, "state"), "state"));
  checks.push(checkDir(join(base, "rubrics"), "rubrics"));

  const configPath = join(base, "config.json");
  if (!existsSync(configPath)) {
    checks.push({ name: "config", status: "fail", message: "config.json not found", suggestion: `Run 'agentgrit init'` });
  } else {
    try {
      JSON.parse(readFileSync(configPath, "utf-8"));
      checks.push({ name: "config", status: "pass", message: "config.json valid" });
    } catch {
      checks.push({ name: "config", status: "fail", message: "config.json malformed" });
    }
  }

  const rubricsDir = join(base, "rubrics");
  if (!existsSync(rubricsDir)) {
    checks.push({ name: "rubrics", status: "fail", message: "Rubrics directory missing", suggestion: `Run 'agentgrit init'` });
  } else {
    const files = readdirSync(rubricsDir).filter((f) => f.endsWith(".json"));
    checks.push(files.length === 0
      ? { name: "rubrics", status: "warn", message: "No rubric files found", suggestion: "Copy starter.json to rubrics/" }
      : { name: "rubrics", status: "pass", message: `${files.length} rubric(s) loaded` });
  }

  const sigDir = resolveSignalDir();
  for (const filename of ["ratings.jsonl", "corrections.jsonl", "sentiment.jsonl", "skills.jsonl"]) {
    const path = resolveSignalFile(sigDir, filename);
    const name = `signal:${filename}`;
    if (!existsSync(path)) {
      checks.push({ name, status: "warn", message: `${filename} not found`, suggestion: "Will be created on first session" });
    } else {
      const stat = statSync(path);
      const sizeMb = stat.size / (1024 * 1024);
      if (sizeMb > 5) {
        checks.push({ name, status: "warn", message: `${filename}: ${sizeMb.toFixed(1)}MB`, suggestion: `Run 'agentgrit signals rotate'` });
      } else {
        const ageStr = relativeTime(stat.mtime);
        checks.push({ name, status: "pass", message: `${filename}: ${(stat.size / 1024).toFixed(0)}KB, last write ${ageStr}` });
      }
    }
  }

  const graphPath = join(base, "state", "knowledge-graph.json");
  if (!existsSync(graphPath)) {
    checks.push({ name: "graph", status: "warn", message: "Knowledge graph not built", suggestion: `Run 'agentgrit graph build'` });
  } else {
    try {
      const graph = JSON.parse(readFileSync(graphPath, "utf-8"));
      const stat = statSync(graphPath);
      const age = relativeTime(stat.mtime);
      const ageMs = Date.now() - stat.mtime.getTime();
      if (ageMs > 7 * 24 * 60 * 60 * 1000) {
        checks.push({ name: "graph", status: "warn", message: `${graph.nodeCount} nodes, ${graph.edgeCount} edges — last build ${age}`, suggestion: "Rebuild recommended (>7 days old)" });
      } else {
        checks.push({ name: "graph", status: "pass", message: `${graph.nodeCount} nodes, ${graph.edgeCount} edges — built ${age}` });
      }
    } catch {
      checks.push({ name: "graph", status: "fail", message: "Knowledge graph corrupted", suggestion: `Run 'agentgrit graph build --full'` });
    }
  }

  return {
    checks,
    passed: checks.filter((c) => c.status === "pass").length,
    warned: checks.filter((c) => c.status === "warn").length,
    failed: checks.filter((c) => c.status === "fail").length,
  };
}

export async function doctorCommand(_args: string[]): Promise<void> {
  console.log("\nagentgrit doctor\n");

  const config = loadConfig();
  if (!config.signalDir) config.signalDir = join(getBaseDir(), "signals");
  if (!config.rules) config.rules = { globalBudget: 25, projectBudget: 25, autoPromote: false };
  if (!config.rubrics) config.rubrics = [];
  if (!config.daemon) config.daemon = { interval: "30m", weeklyDay: "sunday" };
  const report = await runDoctorSrc(config);

  for (const section of report.sections) {
    const sIcon = section.status === "ok" ? "✓" : section.status === "warning" ? "⚠" : "✗";
    console.log(`  ${sIcon} ${section.name}`);
    for (const check of section.checks) {
      const cIcon = check.status === "ok" ? "✓" : check.status === "warning" ? "⚠" : "✗";
      console.log(`    ${cIcon} ${check.message}`);
    }
  }

  const okCount = report.sections.filter((s) => s.status === "ok").length;
  const warnCount = report.sections.filter((s) => s.status === "warning").length;
  const errCount = report.sections.filter((s) => s.status === "error").length;

  console.log(`\nResult: ${okCount} ok, ${warnCount} warnings, ${errCount} errors\n`);
}
