import { existsSync, statSync, readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { resolveSignalFile, resolveSignalDir, resolveMemoryDir, getBaseDir } from "../adapters/paths";
import type { AgentGritConfig } from "../adapters/types";
import { checkBudget, checkLearnedBudget } from "../promote/budget";
import { isIndexableRuleFile } from "../graph/builder";
import { Tier } from "../adapters/types";

/**
 * `info` is a reading the operator may want but cannot act on: a disabled
 * optional feature, a budget that has not been reached, a population that is
 * not a fault. It never escalates a section.
 *
 * The distinction exists because a report whose warnings are mostly
 * unactionable trains the reader to skim past the one that isn't.
 */
export type CheckStatus = "ok" | "info" | "warning" | "error";

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

/**
 * Known-orphan baseline: a ratchet, not an exemption list.
 *
 * A missing or unreadable file yields an empty baseline, which makes every
 * orphan new and the check louder. Fail-open here would be a guard bypass —
 * one unparseable byte would silence the whole WIRING section.
 */
const ORPHAN_BASELINE_FILE = "orphan-exports-baseline.json";

function readOrphanBaseline(projectRoot: string): Set<string> {
  const path = join(projectRoot, ORPHAN_BASELINE_FILE);
  if (!existsSync(path)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!Array.isArray(parsed.orphans)) return new Set();
    return new Set(parsed.orphans.filter((o: unknown): o is string => typeof o === "string"));
  } catch {
    return new Set();
  }
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
    const path = resolveSignalFile(config.signalDir, file);
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

export function checkScoring(config: AgentGritConfig): DoctorSection {
  const checks: CheckResult[] = [];

  const judgeConfigured = Boolean(config.judge?.apiKey);

  if (!judgeConfigured) {
    checks.push({
      name: "judge-api-key",
      status: "info",
      message: "No judge API key configured — LLM scoring disabled",
    });
  } else {
    checks.push({
      name: "judge-api-key",
      status: "ok",
      message: `Judge configured: ${config.judge?.provider}/${config.judge?.model}`,
    });
  }

  const scoresPath = resolveSignalFile(config.signalDir, "scores.jsonl");
  const scoresAge = fileAge(scoresPath);

  // Without a judge credential, scoring cannot run at all, so missing or stale
  // scores are a consequence of the line above rather than a second fault.
  // Reporting them as a warning asks the operator to fix something that is
  // already explained and that no action short of adding a key would change.
  const stalenessStatus: CheckStatus = judgeConfigured ? "warning" : "info";
  const becauseNoKey = judgeConfigured ? "" : " (scoring disabled — no judge API key)";

  if (!scoresAge.exists) {
    checks.push({
      name: "scores",
      status: stalenessStatus,
      message: `No scores file found — daemon may not have run yet${becauseNoKey}`,
    });
  } else if (scoresAge.ageMs > 2 * MS_PER_HOUR) {
    checks.push({
      name: "scores",
      status: stalenessStatus,
      message: `scores.jsonl last modified ${Math.floor(scoresAge.ageMs / MS_PER_HOUR)}h ago${becauseNoKey}`,
      lastActivity: scoresAge.lastModified,
    });
  } else {
    checks.push({
      name: "scores",
      status: "ok",
      message: "Scores recently updated",
      lastActivity: scoresAge.lastModified,
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

function parseRuleType(filePath: string): string {
  try {
    const content = readFileSync(filePath, "utf-8");
    const match = content.match(/^type:\s*(\S+)/m);
    return match ? match[1] : "global";
  } catch {
    return "global";
  }
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
    let globalCount = 0;
    let learnedCount = 0;

    for (const file of files) {
      const ruleType = parseRuleType(join(rulesBase, file));
      if (ruleType === "learned") {
        learnedCount++;
      } else {
        globalCount++;
      }
    }

    // Global tier check
    const globalStatus = checkBudget(Tier.Global, globalCount, config.rules.globalBudget);
    const globalCheckStatus: CheckStatus =
      globalStatus.level === "OVER_BUDGET" ? "error" :
      globalStatus.level === "WARNING" ? "info" : "ok";
    checks.push({
      name: "global-rules",
      status: globalCheckStatus,
      message: `${globalCount} / ${config.rules.globalBudget} global rules`,
    });

    // Learned tier check
    const learnedBudget = config.rules.learnedBudget ?? 50;
    // Approaching a cap is a reading; exceeding one is a fault. Eviction runs
    // on its own schedule, so "47 / 50" asks the operator to do nothing.
    const learnedStatus = checkLearnedBudget(learnedCount, learnedBudget);
    const learnedCheckStatus: CheckStatus =
      learnedStatus.level === "OVER_BUDGET" ? "error" :
      learnedStatus.level === "WARNING" ? "info" : "ok";
    checks.push({
      name: "learned-rules",
      status: learnedCheckStatus,
      message: `${learnedCount} / ${learnedBudget} learned rules`,
    });

    // Graph nodes — uncapped, info only
    const stateBase = join(config.signalDir, "..", "state");
    const graphPath = join(stateBase, "knowledge-graph.json");
    if (existsSync(graphPath)) {
      try {
        const graph = JSON.parse(readFileSync(graphPath, "utf-8"));
        const nodeCount = Object.keys(graph.nodes || {}).length;
        checks.push({
          name: "graph-nodes",
          status: "ok",
          message: `${nodeCount} graph nodes (uncapped)`,
        });
      } catch {
        // skip if graph unreadable
      }
    }
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

export function checkCrossReferences(config: AgentGritConfig): DoctorSection {
  const checks: CheckResult[] = [];
  const stateBase = join(config.signalDir, "..", "state");
  const graphPath = join(stateBase, "knowledge-graph.json");
  const rulesBase = join(config.signalDir, "..", "rules");

  // Check graph nodes vs rule files in BOTH memoryDir and rulesBase
  if (existsSync(graphPath)) {
    try {
      const graph = JSON.parse(readFileSync(graphPath, "utf-8"));
      const graphNodeIds = new Set(Object.keys(graph.nodes || {}));

      // These are two populations with different contracts, and unioning them
      // made the one real number unreadable.
      //
      //   memoryDir — the graph corpus. Every buildGraph() call in src/ and
      //     bin/ passes resolveMemoryDir(), and promotion writes new rules
      //     here (daemon.ts writeRuleFile). A file here that is not a node is
      //     a genuine indexing gap.
      //
      //   rulesDir  — a legacy store. Nothing in the daemon writes to it; it
      //     is read only as an eviction candidate pool and as a filename
      //     fallback in rule-text.ts. It is not an input to the graph, so a
      //     file here that is not a node is the expected state, not a gap.
      //
      // Reported together they produced "597 rule files not yet in graph",
      // a number that stayed alarming no matter how complete indexing was.
      const indexableIds = (dir: string): Set<string> =>
        new Set(
          readdirSync(dir)
            .filter(isIndexableRuleFile)
            .map((f) => f.replace(/\.md$/, "")),
        );

      const memoryDir = config.memoryDir;
      const corpusIds =
        memoryDir && existsSync(memoryDir) ? indexableIds(memoryDir) : new Set<string>();
      const legacyIds = existsSync(rulesBase) ? indexableIds(rulesBase) : new Set<string>();

      const backedIds = new Set([...corpusIds, ...legacyIds]);
      const orphanedNodes = [...graphNodeIds].filter((id) => !backedIds.has(id));
      const unindexedCorpus = [...corpusIds].filter((id) => !graphNodeIds.has(id));
      const unindexedLegacy = [...legacyIds].filter(
        (id) => !graphNodeIds.has(id) && !corpusIds.has(id),
      );

      if (orphanedNodes.length > 0) {
        checks.push({
          name: "orphaned-nodes",
          status: "warning",
          message: `${orphanedNodes.length} graph nodes with no backing rule file`,
        });
      }

      if (unindexedCorpus.length > 0) {
        checks.push({
          name: "unindexed-corpus",
          status: "warning",
          message:
            `${unindexedCorpus.length} of ${corpusIds.size} memoryDir rules not in graph ` +
            `— the graph is built from this directory, so these are unreachable`,
        });
      } else {
        checks.push({
          name: "unindexed-corpus",
          status: "ok",
          message: `All ${corpusIds.size} memoryDir rules are in the graph`,
        });
      }

      if (unindexedLegacy.length > 0) {
        checks.push({
          name: "legacy-rules-store",
          status: "info",
          message:
            `${unindexedLegacy.length} of ${legacyIds.size} files in ${rulesBase} are not graph ` +
            `nodes — that directory is not a graph input (eviction pool and filename fallback only)`,
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

// ── Wiring: Orphan export detection ──

interface ExportEntry {
  name: string;
  file: string;
  kind: "function" | "const" | "class";
}

function collectTsFiles(dir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "dist") {
      collectTsFiles(fullPath, files);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".spec.ts")
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

function collectAllTsFiles(dir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "dist") {
      collectAllTsFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function extractExports(filePath: string, content: string): ExportEntry[] {
  const exports: ExportEntry[] = [];
  for (const line of content.split("\n")) {
    if (/export\s*\{[^}]*\}\s*from\s/.test(line)) continue;
    if (/export\s+(?:type|interface)\s/.test(line)) continue;

    const funcMatch = line.match(/export\s+(?:async\s+)?function\s+(\w+)/);
    if (funcMatch) {
      exports.push({ name: funcMatch[1], file: filePath, kind: "function" });
      continue;
    }

    const constMatch = line.match(/export\s+const\s+(\w+)/);
    if (constMatch) {
      exports.push({ name: constMatch[1], file: filePath, kind: "const" });
      continue;
    }

    const classMatch = line.match(/export\s+class\s+(\w+)/);
    if (classMatch) {
      exports.push({ name: classMatch[1], file: filePath, kind: "class" });
    }
  }
  return exports;
}

export function checkWiring(
  _config: AgentGritConfig,
  projectRoot: string = process.cwd(),
): DoctorSection {
  const checks: CheckResult[] = [];
  const srcDir = join(projectRoot, "src");
  const binDir = join(projectRoot, "bin");

  if (!existsSync(srcDir)) {
    checks.push({
      name: "wiring-skip",
      status: "ok",
      message: "Wiring check skipped (no src/ directory in cwd)",
    });
    return { name: "WIRING", status: "ok", checks };
  }

  const testDir = join(projectRoot, "test");
  const srcFiles = collectTsFiles(srcDir);
  const binFiles = collectTsFiles(binDir);
  const testFiles = collectAllTsFiles(testDir);
  const allFiles = [...srcFiles, ...binFiles, ...testFiles];

  const fileContents = new Map<string, string>();
  for (const file of allFiles) {
    try {
      fileContents.set(file, readFileSync(file, "utf-8"));
    } catch {
      // skip unreadable files
    }
  }

  const allExports: ExportEntry[] = [];
  for (const file of srcFiles) {
    const content = fileContents.get(file);
    if (content) allExports.push(...extractExports(file, content));
  }

  const orphans: ExportEntry[] = [];
  for (const exp of allExports) {
    const pattern = new RegExp(`\\b${exp.name}\\b`);
    let referenced = false;
    for (const [file, content] of fileContents) {
      if (file === exp.file) continue;
      if (pattern.test(content)) {
        referenced = true;
        break;
      }
    }
    if (!referenced) orphans.push(exp);
  }

  if (orphans.length === 0) {
    checks.push({
      name: "orphan-exports",
      status: "ok",
      message: `All ${allExports.length} exports are wired`,
    });
    return { name: "WIRING", status: worstStatus(checks.map((c) => c.status)), checks };
  }

  // Ratchet, not an exemption list. The baseline is what the tree already owes;
  // anything outside it is a new orphan and warns. The baseline can only be
  // lowered, and doctor says by how much, so the number stays interpretable.
  const baseline = readOrphanBaseline(projectRoot);
  const key = (o: ExportEntry) => `${o.file.replace(projectRoot + "/", "")}:${o.name}`;
  const newOrphans = orphans.filter((o) => !baseline.has(key(o)));
  const fixed = [...baseline].filter((b) => !orphans.some((o) => key(o) === b));

  if (newOrphans.length > 0) {
    checks.push({
      name: "orphan-summary",
      status: "warning",
      message:
        `${newOrphans.length} new orphan export(s) beyond the baseline of ${baseline.size} ` +
        `(${orphans.length} of ${allExports.length} total)`,
    });
    for (const orphan of newOrphans) {
      checks.push({
        name: `orphan:${orphan.name}`,
        status: "warning",
        message: `${orphan.name} (${orphan.kind}) in ${orphan.file.replace(projectRoot + "/", "")} — exported but never imported`,
      });
    }
  } else {
    checks.push({
      name: "orphan-summary",
      status: "info",
      message:
        `${orphans.length} known orphan export(s) of ${allExports.length}, all in the ` +
        `baseline — no new ones` +
        (fixed.length > 0
          ? `. ${fixed.length} baseline entr${fixed.length === 1 ? "y is" : "ies are"} now wired; lower the baseline to ${orphans.length}`
          : ""),
    });
  }

  return {
    name: "WIRING",
    status: worstStatus(checks.map((c) => c.status)),
    checks,
  };
}

// ── Data Integrity: Dual-path divergence detection ──

interface DirPair {
  label: string;
  defaultPath: string;
  configuredPath: string;
}

function lineCount(filePath: string): number {
  try {
    const content = readFileSync(filePath, "utf-8");
    return content.split("\n").length;
  } catch {
    return 0;
  }
}

function checkDataIntegrity(_config: AgentGritConfig): DoctorSection {
  const checks: CheckResult[] = [];

  const defaultBase = join(getBaseDir(), "signals");
  const configuredSignals = resolveSignalDir();
  const defaultState = join(getBaseDir(), "state");
  const configuredState = join(resolveSignalDir(), "..", "state");
  const defaultMemory = join(getBaseDir(), "memory");
  const configuredMemory = resolveMemoryDir();

  const pairs: DirPair[] = [
    { label: "signals", defaultPath: defaultBase, configuredPath: configuredSignals },
    { label: "state", defaultPath: defaultState, configuredPath: configuredState },
    { label: "memory", defaultPath: defaultMemory, configuredPath: configuredMemory },
  ];

  for (const pair of pairs) {
    const defaultResolved = resolve(pair.defaultPath);
    const configuredResolved = resolve(pair.configuredPath);

    if (defaultResolved === configuredResolved) {
      checks.push({
        name: `${pair.label}-paths`,
        status: "ok",
        message: `${pair.label}: default and configured paths match — no divergence possible`,
      });
      continue;
    }

    if (!existsSync(defaultResolved) || !existsSync(configuredResolved)) {
      checks.push({
        name: `${pair.label}-paths`,
        status: "ok",
        message: `${pair.label}: only one path exists — no divergence`,
      });
      continue;
    }

    const defaultFiles = new Set(
      readdirSync(defaultResolved).filter((f) => f.endsWith(".jsonl") || f.endsWith(".json")),
    );
    const configuredFiles = new Set(
      readdirSync(configuredResolved).filter((f) => f.endsWith(".jsonl") || f.endsWith(".json")),
    );

    const overlapping = [...defaultFiles].filter((f) => configuredFiles.has(f));

    if (overlapping.length === 0) {
      checks.push({
        name: `${pair.label}-paths`,
        status: "ok",
        message: `${pair.label}: paths differ but no overlapping files`,
      });
      continue;
    }

    for (const file of overlapping) {
      const defaultFilePath = join(defaultResolved, file);
      const configuredFilePath = join(configuredResolved, file);
      const defaultStat = statSync(defaultFilePath);
      const configuredStat = statSync(configuredFilePath);
      const defaultLines = lineCount(defaultFilePath);
      const configuredLines = lineCount(configuredFilePath);

      const defaultNewer = defaultStat.mtimeMs > configuredStat.mtimeMs;
      const stale = defaultNewer ? "configured" : "default";
      const ageDiffMs = Math.abs(defaultStat.mtimeMs - configuredStat.mtimeMs);
      const ageDiffHours = Math.floor(ageDiffMs / MS_PER_HOUR);

      checks.push({
        name: `diverge:${pair.label}/${file}`,
        status: "warning",
        message: `${file} exists at both paths — default: ${defaultLines} lines, configured: ${configuredLines} lines, ${stale} is ${ageDiffHours}h stale`,
      });
    }
  }

  return {
    name: "DATA INTEGRITY",
    status: worstStatus(checks.map((c) => c.status)),
    checks,
  };
}

// ── Run Doctor ──

function checkEvictionAndContext(config: AgentGritConfig): DoctorSection {
  const checks: CheckResult[] = [];
  const stateBase = join(config.signalDir, "..", "state");

  const evictedPath = join(stateBase, "evicted-rules.json");
  if (!existsSync(evictedPath)) {
    checks.push({
      name: "eviction-registry",
      status: "warning",
      message: "evicted-rules.json missing — eviction not enforced",
    });
  } else {
    try {
      const evicted = JSON.parse(readFileSync(evictedPath, "utf-8"));
      const count = Array.isArray(evicted.evicted) ? evicted.evicted.length : 0;
      checks.push({
        name: "eviction-registry",
        status: "ok",
        message: `${count} rules in eviction registry`,
      });
    } catch {
      checks.push({
        name: "eviction-registry",
        status: "error",
        message: "evicted-rules.json corrupted",
      });
    }
  }

  const contextPath = join(stateBase, "session-context.json");
  if (!existsSync(contextPath)) {
    checks.push({
      name: "context-freshness",
      status: "warning",
      message: "session-context.json missing — context refresh may not be running",
    });
  } else {
    const ctxInfo = fileAge(contextPath);
    const ctxAgeDays = ctxInfo.ageMs / MS_PER_DAY;
    if (ctxAgeDays > 3) {
      checks.push({
        name: "context-freshness",
        status: "warning",
        message: `session-context.json is ${Math.floor(ctxAgeDays)} days old`,
        lastActivity: ctxInfo.lastModified,
      });
    } else {
      checks.push({
        name: "context-freshness",
        status: "ok",
        message: `session-context.json updated ${Math.floor(ctxAgeDays * 24)} hours ago`,
        lastActivity: ctxInfo.lastModified,
      });
    }
  }

  return {
    name: "HEALTH",
    status: worstStatus(checks.map((c) => c.status)),
    checks,
  };
}

export async function runDoctor(config: AgentGritConfig): Promise<DoctorReport> {
  const sections: DoctorSection[] = [
    checkCapture(config),
    checkScoring(config),
    checkGraph(config),
    checkRules(config),
    checkSignals(config),
    checkConfig(config),
    checkCrossReferences(config),
    checkDataIntegrity(config),
    checkWiring(config),
    checkEvictionAndContext(config),
  ];

  return {
    timestamp: new Date().toISOString(),
    overall: worstStatus(sections.map((s) => s.status)),
    sections,
  };
}
