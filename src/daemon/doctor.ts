import { existsSync, statSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { AgentGritConfig } from "../adapters/types";

export type CheckStatus = "ok" | "warning" | "error";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  lastActivity?: string;
}

export interface DoctorSection {
  name: string;
  status: CheckStatus;
  checks: CheckResult[];
}

export interface DoctorReport {
  timestamp: string;
  overall: CheckStatus;
  sections: DoctorSection[];
}

function worstStatus(statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes("error")) return "error";
  if (statuses.includes("warning")) return "warning";
  return "ok";
}

function fileAge(filePath: string): { exists: boolean; ageMs: number; lastModified?: string } {
  if (!existsSync(filePath)) return { exists: false, ageMs: Infinity };
  const stat = statSync(filePath);
  return {
    exists: true,
    ageMs: Date.now() - stat.mtimeMs,
    lastModified: stat.mtime.toISOString(),
  };
}

function fileSizeMB(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  return statSync(filePath).size / (1024 * 1024);
}

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const STALE_HOOK_THRESHOLD_MS = 14 * MS_PER_DAY;
const STALE_GRAPH_THRESHOLD_MS = 7 * MS_PER_DAY;
const SIGNAL_SIZE_WARNING_MB = 5;
const SIGNAL_SIZE_ERROR_MB = 20;

function checkCapture(config: AgentGritConfig): DoctorSection {
  const checks: CheckResult[] = [];
  const signalFiles = ["ratings.jsonl", "corrections.jsonl", "sentiment.jsonl", "skills.jsonl"];

  for (const file of signalFiles) {
    const path = join(config.signalDir, file);
    const info = fileAge(path);

    if (!info.exists) {
      checks.push({
        name: file,
        status: "warning",
        message: `${file} not found — no signals captured yet`,
      });
      continue;
    }

    if (info.ageMs > STALE_HOOK_THRESHOLD_MS) {
      checks.push({
        name: file,
        status: "warning",
        message: `${file} last modified ${Math.floor(info.ageMs / MS_PER_DAY)}d ago — hook may not be firing`,
        lastActivity: info.lastModified,
      });
    } else {
      checks.push({
        name: file,
        status: "ok",
        message: `${file} active`,
        lastActivity: info.lastModified,
      });
    }
  }

  return {
    name: "CAPTURE",
    status: worstStatus(checks.map((c) => c.status)),
    checks,
  };
}

function checkScoring(config: AgentGritConfig): DoctorSection {
  const checks: CheckResult[] = [];

  if (!config.judge?.apiKey) {
    checks.push({
      name: "judge-api-key",
      status: "warning",
      message: "No judge API key configured — LLM scoring disabled",
    });
  } else {
    checks.push({
      name: "judge-api-key",
      status: "ok",
      message: `Judge configured: ${config.judge.provider}/${config.judge.model}`,
    });
  }

  const scoresPath = join(config.signalDir, "scores.jsonl");
  const info = fileAge(scoresPath);

  if (!info.exists) {
    checks.push({
      name: "scores",
      status: "warning",
      message: "No scores file found — daemon may not have run yet",
    });
  } else if (info.ageMs > 2 * MS_PER_HOUR) {
    checks.push({
      name: "scores",
      status: "warning",
      message: `scores.jsonl last modified ${Math.floor(info.ageMs / MS_PER_HOUR)}h ago`,
      lastActivity: info.lastModified,
    });
  } else {
    checks.push({
      name: "scores",
      status: "ok",
      message: "Scores recently updated",
      lastActivity: info.lastModified,
    });
  }

  return {
    name: "SCORING",
    status: worstStatus(checks.map((c) => c.status)),
    checks,
  };
}

function checkGraph(config: AgentGritConfig): DoctorSection {
  const checks: CheckResult[] = [];
  const stateBase = join(config.signalDir, "..", "state");
  const graphPath = join(stateBase, "knowledge-graph.json");
  const info = fileAge(graphPath);

  if (!info.exists) {
    checks.push({
      name: "knowledge-graph",
      status: "warning",
      message: "knowledge-graph.json not found — graph not built yet",
    });
  } else {
    if (info.ageMs > STALE_GRAPH_THRESHOLD_MS) {
      checks.push({
        name: "knowledge-graph",
        status: "warning",
        message: `Graph last rebuilt ${Math.floor(info.ageMs / MS_PER_DAY)}d ago (threshold: 7d)`,
        lastActivity: info.lastModified,
      });
    } else {
      checks.push({
        name: "knowledge-graph",
        status: "ok",
        message: "Graph recently rebuilt",
        lastActivity: info.lastModified,
      });
    }

    const sizeMB = fileSizeMB(graphPath);
    checks.push({
      name: "graph-size",
      status: "ok",
      message: `Graph size: ${sizeMB.toFixed(1)}MB`,
    });
  }

  return {
    name: "GRAPH",
    status: worstStatus(checks.map((c) => c.status)),
    checks,
  };
}

function checkRules(config: AgentGritConfig): DoctorSection {
  const checks: CheckResult[] = [];
  const rulesBase = join(config.signalDir, "..", "rules");

  if (!existsSync(rulesBase)) {
    checks.push({
      name: "rules-dir",
      status: "ok",
      message: "No rules directory — no rules promoted yet",
    });
  } else {
    const files = readdirSync(rulesBase).filter((f) => f.endsWith(".md"));
    const count = files.length;
    const globalBudget = config.rules.globalBudget;

    let status: CheckStatus = "ok";
    if (count > globalBudget) status = "error";
    else if (count > globalBudget - 5) status = "warning";

    checks.push({
      name: "rule-count",
      status,
      message: `${count} / ${globalBudget} rules (global budget)`,
    });
  }

  return {
    name: "RULES",
    status: worstStatus(checks.map((c) => c.status)),
    checks,
  };
}

function checkSignals(config: AgentGritConfig): DoctorSection {
  const checks: CheckResult[] = [];

  if (!existsSync(config.signalDir)) {
    checks.push({
      name: "signal-dir",
      status: "warning",
      message: "Signal directory does not exist",
    });
    return { name: "SIGNALS", status: "warning", checks };
  }

  const files = readdirSync(config.signalDir).filter((f) => f.endsWith(".jsonl"));

  for (const file of files) {
    const path = join(config.signalDir, file);
    const sizeMB = fileSizeMB(path);

    let status: CheckStatus = "ok";
    let message = `${file}: ${sizeMB.toFixed(1)}MB`;

    if (sizeMB > SIGNAL_SIZE_ERROR_MB) {
      status = "error";
      message += " — rotation needed urgently";
    } else if (sizeMB > SIGNAL_SIZE_WARNING_MB) {
      status = "warning";
      message += " — rotation recommended";
    }

    checks.push({ name: file, status, message });
  }

  return {
    name: "SIGNALS",
    status: worstStatus(checks.map((c) => c.status)),
    checks,
  };
}

// ── Integrity: Config validation ──

function checkConfig(config: AgentGritConfig): DoctorSection {
  const checks: CheckResult[] = [];

  // Validate adapter setting
  const validAdapters = ["local", "langfuse", "both"];
  if (validAdapters.includes(config.adapter)) {
    checks.push({ name: "adapter", status: "ok", message: `Adapter: ${config.adapter}` });
  } else {
    checks.push({ name: "adapter", status: "error", message: `Invalid adapter: ${config.adapter}` });
  }

  // Langfuse credentials when needed
  if ((config.adapter === "langfuse" || config.adapter === "both") && !config.langfuse?.publicKey) {
    checks.push({
      name: "langfuse-keys",
      status: "warning",
      message: "Langfuse adapter configured but no public key set",
    });
  } else if (config.langfuse?.publicKey) {
    checks.push({ name: "langfuse-keys", status: "ok", message: "Langfuse keys configured" });
  }

  // Rule budgets
  if (config.rules.globalBudget > 0) {
    checks.push({
      name: "rule-budget",
      status: "ok",
      message: `Rule budgets: global=${config.rules.globalBudget}, project=${config.rules.projectBudget}`,
    });
  }

  // Daemon interval
  if (config.daemon.interval) {
    checks.push({
      name: "daemon-interval",
      status: "ok",
      message: `Daemon interval: ${config.daemon.interval}, weekly: ${config.daemon.weeklyDay}`,
    });
  }

  return {
    name: "CONFIG",
    status: worstStatus(checks.map((c) => c.status)),
    checks,
  };
}

// ── Integrity: Cross-reference validation ──

function checkCrossReferences(config: AgentGritConfig): DoctorSection {
  const checks: CheckResult[] = [];
  const stateBase = join(config.signalDir, "..", "state");
  const graphPath = join(stateBase, "knowledge-graph.json");
  const rulesBase = join(config.signalDir, "..", "rules");

  // Check graph nodes vs rule files
  if (existsSync(graphPath) && existsSync(rulesBase)) {
    try {
      const graph = JSON.parse(readFileSync(graphPath, "utf-8"));
      const graphNodeIds = new Set(Object.keys(graph.nodes || {}));
      const ruleFiles = readdirSync(rulesBase).filter((f) => f.endsWith(".md"));
      const ruleIds = new Set(ruleFiles.map((f) => f.replace(/\.md$/, "")));

      const orphanedNodes = [...graphNodeIds].filter((id) => !ruleIds.has(id));
      const unindexedRules = [...ruleIds].filter((id) => !graphNodeIds.has(id));

      if (orphanedNodes.length > 0) {
        checks.push({
          name: "orphaned-nodes",
          status: "warning",
          message: `${orphanedNodes.length} graph nodes with no backing rule file`,
        });
      }

      if (unindexedRules.length > 0) {
        checks.push({
          name: "unindexed-rules",
          status: "warning",
          message: `${unindexedRules.length} rule files not yet in graph`,
        });
      }

      if (orphanedNodes.length === 0 && unindexedRules.length === 0) {
        checks.push({
          name: "graph-rules-sync",
          status: "ok",
          message: `Graph and rules directory in sync (${graphNodeIds.size} nodes)`,
        });
      }
    } catch (err) {
      checks.push({
        name: "cross-ref-error",
        status: "warning",
        message: `Could not validate cross-references: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else {
    checks.push({
      name: "cross-ref-skip",
      status: "ok",
      message: "Cross-reference check skipped (graph or rules not yet created)",
    });
  }

  return {
    name: "INTEGRITY",
    status: worstStatus(checks.map((c) => c.status)),
    checks,
  };
}

// ── Run Doctor ──

export async function runDoctor(config: AgentGritConfig): Promise<DoctorReport> {
  const sections: DoctorSection[] = [
    checkCapture(config),
    checkScoring(config),
    checkGraph(config),
    checkRules(config),
    checkSignals(config),
    checkConfig(config),
    checkCrossReferences(config),
  ];

  return {
    timestamp: new Date().toISOString(),
    overall: worstStatus(sections.map((s) => s.status)),
    sections,
  };
}
