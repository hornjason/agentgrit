import { existsSync, statSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { getBaseDir, signalsDir, stateDir, rubricsDir } from "../../src/adapters/paths";
import { relativeTime } from "../../src/adapters/time";
import { Tier } from "../../src/adapters/types";
import { checkBudget } from "../../src/promote/budget";

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

function icon(status: "pass" | "warn" | "fail"): string {
  if (status === "pass") return "✓";
  if (status === "warn") return "⚠";
  return "✗";
}

function checkDirectory(path: string, name: string): DoctorCheck {
  if (!existsSync(path)) {
    return { name, status: "fail", message: `${name} directory missing`, suggestion: `Run 'agentgrit init'` };
  }
  return { name, status: "pass", message: `${name} directory exists` };
}

function checkSignalFile(dir: string, filename: string): DoctorCheck {
  const path = join(dir, filename);
  const name = `signal:${filename}`;

  if (!existsSync(path)) {
    return { name, status: "warn", message: `${filename} not found`, suggestion: "Will be created on first session" };
  }

  const stat = statSync(path);
  const sizeMb = stat.size / (1024 * 1024);

  if (sizeMb > 5) {
    return {
      name,
      status: "warn",
      message: `${filename}: ${sizeMb.toFixed(1)}MB`,
      suggestion: `Run 'agentgrit signals rotate'`,
    };
  }

  const ageMs = Date.now() - stat.mtime.getTime();
  const ageStr = relativeTime(stat.mtime);
  return { name, status: "pass", message: `${filename}: ${(stat.size / 1024).toFixed(0)}KB, last write ${ageStr}` };
}

function checkGraph(base: string): DoctorCheck {
  const path = join(base, "state", "knowledge-graph.json");
  if (!existsSync(path)) {
    return { name: "graph", status: "warn", message: "Knowledge graph not built", suggestion: `Run 'agentgrit graph build'` };
  }

  try {
    const graph = JSON.parse(readFileSync(path, "utf-8"));
    const stat = statSync(path);
    const age = relativeTime(stat.mtime);

    const ageMs = Date.now() - stat.mtime.getTime();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;

    if (ageMs > sevenDays) {
      return {
        name: "graph",
        status: "warn",
        message: `${graph.nodeCount} nodes, ${graph.edgeCount} edges — last build ${age}`,
        suggestion: "Rebuild recommended (>7 days old)",
      };
    }

    return { name: "graph", status: "pass", message: `${graph.nodeCount} nodes, ${graph.edgeCount} edges — built ${age}` };
  } catch {
    return { name: "graph", status: "fail", message: "Knowledge graph corrupted", suggestion: `Run 'agentgrit graph build --full'` };
  }
}

function checkRubric(base: string): DoctorCheck {
  const dir = join(base, "rubrics");
  if (!existsSync(dir)) {
    return { name: "rubrics", status: "fail", message: "Rubrics directory missing", suggestion: `Run 'agentgrit init'` };
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    return { name: "rubrics", status: "warn", message: "No rubric files found", suggestion: "Copy starter.json to rubrics/" };
  }

  return { name: "rubrics", status: "pass", message: `${files.length} rubric(s) loaded` };
}

function checkConfig(base: string): DoctorCheck {
  const path = join(base, "config.json");
  if (!existsSync(path)) {
    return { name: "config", status: "fail", message: "config.json not found", suggestion: `Run 'agentgrit init'` };
  }

  try {
    JSON.parse(readFileSync(path, "utf-8"));
    return { name: "config", status: "pass", message: "config.json valid" };
  } catch {
    return { name: "config", status: "fail", message: "config.json malformed" };
  }
}

export function runDoctor(): DoctorReport {
  const base = getBaseDir();
  const checks: DoctorCheck[] = [];

  checks.push(checkDirectory(base, "base"));
  checks.push(checkDirectory(join(base, "signals"), "signals"));
  checks.push(checkDirectory(join(base, "state"), "state"));
  checks.push(checkDirectory(join(base, "rubrics"), "rubrics"));

  checks.push(checkConfig(base));
  checks.push(checkRubric(base));

  const sigDir = join(base, "signals");
  for (const file of ["ratings.jsonl", "corrections.jsonl", "sentiment.jsonl", "skills.jsonl"]) {
    checks.push(checkSignalFile(sigDir, file));
  }

  checks.push(checkGraph(base));

  return {
    checks,
    passed: checks.filter((c) => c.status === "pass").length,
    warned: checks.filter((c) => c.status === "warn").length,
    failed: checks.filter((c) => c.status === "fail").length,
  };
}

export async function doctorCommand(_args: string[]): Promise<void> {
  console.log("\nagentgrit doctor\n");

  const report = runDoctor();

  for (const check of report.checks) {
    const prefix = `  ${icon(check.status)}`;
    console.log(`${prefix} ${check.message}`);
    if (check.suggestion) {
      console.log(`    → ${check.suggestion}`);
    }
  }

  console.log(`\nResult: ${report.passed} passed, ${report.warned} warnings, ${report.failed} failed\n`);
}
