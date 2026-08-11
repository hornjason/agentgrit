import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getBaseDir } from "../../src/adapters/paths";

// --- Exported helpers (tested directly) ---

export function getStatus(lastModifiedMs: number, yellowDays: number, redDays: number): "GREEN" | "YELLOW" | "RED" {
  const ageMs = Date.now() - lastModifiedMs;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays > redDays) return "RED";
  if (ageDays > yellowDays) return "YELLOW";
  return "GREEN";
}

export function timeAgo(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}

// --- Pipeline file definitions ---

interface PipelineFile {
  name: string;
  path: string;
  purpose: string;
  yellowDays: number;
  redDays: number;
}

function expandHome(p: string): string {
  return p.replace(/^~(?=\/|$)/, homedir());
}

const PIPELINE_FILES: PipelineFile[] = [
  { name: "ratings.jsonl", path: "~/.claude/MEMORY/LEARNING/SIGNALS/ratings.jsonl", purpose: "Raw session ratings", yellowDays: 3, redDays: 7 },
  { name: "rule-stats.json", path: "~/.agentgrit/state/rule-stats.json", purpose: "Per-rule correlation stats", yellowDays: 3, redDays: 7 },
  { name: "session-context.json", path: "~/.agentgrit/state/session-context.json", purpose: "Active rules + domains", yellowDays: 1, redDays: 3 },
  { name: "eviction-candidates.json", path: "~/.agentgrit/state/eviction-candidates.json", purpose: "Stale rule candidates", yellowDays: 7, redDays: 14 },
  { name: "GRAPH-CONTEXT.md", path: "~/.claude/MEMORY/STATE/GRAPH-CONTEXT.md", purpose: "Injected rules", yellowDays: 1, redDays: 3 },
  { name: "patterns.json", path: "~/.claude/MEMORY/LEARNING/STATE/patterns.json", purpose: "Detected failure patterns", yellowDays: 7, redDays: 14 },
];

// --- Data collection ---

interface FileInfo {
  name: string;
  purpose: string;
  exists: boolean;
  lastModifiedMs: number;
  entryCount: number;
  status: "GREEN" | "YELLOW" | "RED";
  timeAgoStr: string;
}

function collectFileInfo(pf: PipelineFile): FileInfo {
  const fullPath = expandHome(pf.path);
  if (!existsSync(fullPath)) {
    return {
      name: pf.name,
      purpose: pf.purpose,
      exists: false,
      lastModifiedMs: 0,
      entryCount: 0,
      status: "RED",
      timeAgoStr: "missing",
    };
  }

  const stat = statSync(fullPath);
  const modMs = stat.mtime.getTime();
  const status = getStatus(modMs, pf.yellowDays, pf.redDays);

  let entryCount = 0;
  try {
    const content = readFileSync(fullPath, "utf-8").trim();
    if (!content) {
      entryCount = 0;
    } else if (fullPath.endsWith(".jsonl")) {
      entryCount = content.split("\n").length;
    } else if (fullPath.endsWith(".json")) {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) entryCount = parsed.length;
      else if (typeof parsed === "object" && parsed !== null) entryCount = Object.keys(parsed).length;
    } else if (fullPath.endsWith(".md")) {
      entryCount = content.split("\n").length;
    }
  } catch { /* skip */ }

  return {
    name: pf.name,
    purpose: pf.purpose,
    exists: true,
    lastModifiedMs: modMs,
    entryCount,
    status,
    timeAgoStr: timeAgo(modMs),
  };
}

interface GhIssue {
  number: number;
  title: string;
  labels: { name: string; color?: string }[];
}

async function fetchGhIssues(): Promise<GhIssue[]> {
  try {
    const proc = Bun.spawn(
      ["gh", "issue", "list", "--repo", "hornjason/agentgrit", "--state", "open", "--json", "number,title,labels", "--limit", "20"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) return [];
    return JSON.parse(text) as GhIssue[];
  } catch {
    return [];
  }
}

interface KeyMetrics {
  totalRatedSessions: number;
  agentgritRatings: number;
  rulesTracked: number;
  rulesWithNoise: number;
  baselineExists: boolean;
  baselineData: Record<string, unknown> | null;
}

function collectKeyMetrics(): KeyMetrics {
  const paiRatings = expandHome("~/.claude/MEMORY/LEARNING/SIGNALS/ratings.jsonl");
  const agRatings = expandHome("~/.agentgrit/signals/ratings.jsonl");
  const ruleStatsPath = expandHome("~/.agentgrit/state/rule-stats.json");
  const baselinePath = expandHome("~/.claude/MEMORY/WORK/166-migration-gate/baseline.json");

  const countLines = (p: string): number => {
    if (!existsSync(p)) return 0;
    const c = readFileSync(p, "utf-8").trim();
    return c ? c.split("\n").length : 0;
  };

  let rulesTracked = 0;
  let rulesWithNoise = 0;
  try {
    if (existsSync(ruleStatsPath)) {
      const stats = JSON.parse(readFileSync(ruleStatsPath, "utf-8"));
      if (Array.isArray(stats)) {
        rulesTracked = stats.length;
        rulesWithNoise = stats.filter((s: { noisePenalty?: number }) => (s.noisePenalty ?? 0) > 0).length;
      } else if (typeof stats === "object" && stats !== null) {
        const entries = Object.values(stats) as { noisePenalty?: number }[];
        rulesTracked = entries.length;
        rulesWithNoise = entries.filter((s) => (s.noisePenalty ?? 0) > 0).length;
      }
    }
  } catch { /* skip */ }

  let baselineData: Record<string, unknown> | null = null;
  const baselineExists = existsSync(baselinePath);
  if (baselineExists) {
    try { baselineData = JSON.parse(readFileSync(baselinePath, "utf-8")); } catch { /* skip */ }
  }

  return {
    totalRatedSessions: countLines(paiRatings),
    agentgritRatings: countLines(agRatings),
    rulesTracked,
    rulesWithNoise,
    baselineExists,
    baselineData,
  };
}

// --- HTML generation ---

const PHASE_DATA = [
  { num: 1, label: "Signal Capture", color: "#00ff88" },
  { num: 2, label: "Graph Build", color: "#00ff88" },
  { num: 3, label: "Correlation", color: "#4da6ff" },
  { num: 4, label: "Auto-Evict", color: "#555" },
  { num: 5, label: "Recall Eval", color: "#555" },
  { num: 6, label: "Auto-Promote", color: "#555" },
  { num: 7, label: "Daemon Loop", color: "#555" },
  { num: 8, label: "Self-Tuning", color: "#555" },
];

function statusColor(s: "GREEN" | "YELLOW" | "RED"): string {
  if (s === "GREEN") return "#00ff88";
  if (s === "YELLOW") return "#ffd700";
  return "#ff4444";
}

function labelColor(hex: string): string {
  // GitHub label colors are hex without #
  if (!hex) return "#555";
  return hex.startsWith("#") ? hex : `#${hex}`;
}

function overallHealth(files: FileInfo[]): "GREEN" | "YELLOW" | "RED" {
  if (files.some((f) => f.status === "RED")) return "RED";
  if (files.some((f) => f.status === "YELLOW")) return "YELLOW";
  return "GREEN";
}

function renderHtml(files: FileInfo[], issues: GhIssue[], metrics: KeyMetrics): string {
  const now = new Date().toISOString();
  const health = overallHealth(files);

  const pipelineRows = files
    .map(
      (f) => `
      <tr>
        <td><strong>${esc(f.name)}</strong><br><span class="dim">${esc(f.purpose)}</span></td>
        <td>${f.exists ? esc(f.timeAgoStr) : "<span class='dim'>missing</span>"}</td>
        <td>${f.exists ? f.entryCount : "&mdash;"}</td>
        <td><span class="badge" style="background:${statusColor(f.status)}">${f.status}</span></td>
      </tr>`
    )
    .join("\n");

  const phaseBoxes = PHASE_DATA.map(
    (p) => `
    <div class="phase-box" style="border-color:${p.color}">
      <div class="phase-num" style="color:${p.color}">Phase ${p.num}</div>
      <div class="phase-label">${esc(p.label)}</div>
      <div class="phase-status" style="color:${p.color}">${p.color === "#00ff88" ? "Done" : p.color === "#4da6ff" ? "Current" : "Future"}</div>
    </div>`
  ).join("\n");

  const issueRows = issues.length > 0
    ? issues
        .map(
          (i) => `
      <tr>
        <td><a href="https://github.com/hornjason/agentgrit/issues/${i.number}" target="_blank">#${i.number}</a></td>
        <td>${esc(i.title)}</td>
        <td>${i.labels.map((l) => `<span class="label-badge" style="background:${labelColor(l.color ?? "")}">${esc(l.name)}</span>`).join(" ")}</td>
      </tr>`
        )
        .join("\n")
    : `<tr><td colspan="3" class="dim">No open issues found (gh CLI may not be available)</td></tr>`;

  const baselineSection = metrics.baselineExists && metrics.baselineData
    ? `<div class="metric-card">
        <div class="metric-value">${Object.keys(metrics.baselineData).length}</div>
        <div class="metric-label">Baseline Refs</div>
      </div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AgentGrit Migration Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1a1a2e; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 24px; }
  .container { max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 1.8rem; margin-bottom: 4px; }
  h2 { font-size: 1.2rem; margin: 24px 0 12px; color: #8899aa; text-transform: uppercase; letter-spacing: 1px; }
  .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; padding: 20px; background: #16213e; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
  .header-left h1 { color: #e0e0e0; }
  .header-left .timestamp { color: #888; font-size: 0.85rem; margin-top: 4px; }
  .health-badge { font-size: 1.1rem; font-weight: 700; padding: 8px 20px; border-radius: 8px; }
  .card { background: #16213e; border-radius: 10px; padding: 16px 20px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.2); }
  .phases { display: flex; gap: 10px; flex-wrap: wrap; }
  .phase-box { flex: 1; min-width: 100px; text-align: center; padding: 12px 8px; background: #0f1a2e; border: 2px solid; border-radius: 8px; }
  .phase-num { font-weight: 700; font-size: 0.9rem; }
  .phase-label { font-size: 0.75rem; color: #aaa; margin: 4px 0; }
  .phase-status { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 8px 12px; border-bottom: 1px solid #2a3a5e; color: #8899aa; font-size: 0.8rem; text-transform: uppercase; }
  td { padding: 10px 12px; border-bottom: 1px solid #1a2a4e; vertical-align: top; }
  td a { color: #4da6ff; text-decoration: none; }
  td a:hover { text-decoration: underline; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 4px; font-size: 0.75rem; font-weight: 700; color: #111; }
  .label-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: 600; color: #fff; margin: 1px 2px; }
  .dim { color: #666; font-size: 0.85rem; }
  .metrics-row { display: flex; gap: 12px; flex-wrap: wrap; }
  .metric-card { flex: 1; min-width: 140px; background: #0f1a2e; border-radius: 8px; padding: 16px; text-align: center; }
  .metric-value { font-size: 1.8rem; font-weight: 700; color: #4da6ff; }
  .metric-label { font-size: 0.8rem; color: #888; margin-top: 4px; }
  .footer { text-align: center; color: #555; font-size: 0.75rem; margin-top: 32px; padding: 16px; }
</style>
</head>
<body>
<div class="container">

  <div class="header">
    <div class="header-left">
      <h1>AgentGrit Migration Dashboard</h1>
      <div class="timestamp">Generated ${esc(now)}</div>
    </div>
    <div class="health-badge" style="background:${statusColor(health)};color:#111">${health}</div>
  </div>

  <h2>Migration Phase</h2>
  <div class="card">
    <div class="phases">
      ${phaseBoxes}
    </div>
  </div>

  <h2>Pipeline Health</h2>
  <div class="card">
    <table>
      <thead>
        <tr><th>File</th><th>Last Modified</th><th>Entries</th><th>Status</th></tr>
      </thead>
      <tbody>
        ${pipelineRows}
      </tbody>
    </table>
  </div>

  <h2>Open Issues</h2>
  <div class="card">
    <table>
      <thead>
        <tr><th>#</th><th>Title</th><th>Labels</th></tr>
      </thead>
      <tbody>
        ${issueRows}
      </tbody>
    </table>
  </div>

  <h2>Key Metrics</h2>
  <div class="card">
    <div class="metrics-row">
      <div class="metric-card">
        <div class="metric-value">${metrics.totalRatedSessions}</div>
        <div class="metric-label">Total Rated Sessions</div>
      </div>
      <div class="metric-card">
        <div class="metric-value">${metrics.agentgritRatings}</div>
        <div class="metric-label">AgentGrit Ratings</div>
      </div>
      <div class="metric-card">
        <div class="metric-value">${metrics.rulesTracked}</div>
        <div class="metric-label">Rules Tracked</div>
      </div>
      <div class="metric-card">
        <div class="metric-value">${metrics.rulesWithNoise}</div>
        <div class="metric-label">Rules w/ Noise Penalty</div>
      </div>
      ${baselineSection}
    </div>
  </div>

  <div class="footer">
    AgentGrit Migration Dashboard &mdash; Generated ${esc(now)}<br>
    Refresh: <code>agentgrit dashboard</code>
  </div>

</div>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// --- Public API ---

interface DashboardOptions {
  noOpen?: boolean;
  outputPath?: string;
}

export async function generateDashboardHtml(opts?: DashboardOptions): Promise<string> {
  const files = PIPELINE_FILES.map(collectFileInfo);
  const issues = await fetchGhIssues();
  const metrics = collectKeyMetrics();
  const html = renderHtml(files, issues, metrics);

  const outPath = opts?.outputPath ?? join(getBaseDir(), "dashboard.html");
  const outDir = outPath.substring(0, outPath.lastIndexOf("/"));
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, html, "utf-8");

  return html;
}

export async function dashboardCommand(args: string[]): Promise<void> {
  console.log("\nagentgrit dashboard\n");

  const base = getBaseDir();
  if (!existsSync(base)) {
    console.log("  agentgrit not initialized. Run 'agentgrit init' first.\n");
    return;
  }

  const noOpen = args.includes("--no-open");
  const outPath = join(base, "dashboard.html");

  await generateDashboardHtml({ noOpen, outputPath: outPath });

  console.log(`  Generated: ${outPath}`);

  if (!noOpen) {
    try {
      const { exec } = await import("child_process");
      const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      exec(`${cmd} "${outPath}"`);
      console.log("  Opened in browser.");
    } catch {
      // Non-fatal — just print path
    }
  }

  console.log("");
}
