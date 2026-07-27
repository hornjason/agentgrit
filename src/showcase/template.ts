export interface DomainEntry {
  name: string;
  count: number;
}

export interface RulePerformer {
  id: string;
  rating: number;
  injections: number;
}

export interface HealthCheck {
  label: string;
  status: "green" | "amber" | "red";
  detail: string;
}

export interface ShowcaseMetrics {
  generatedAt: string;
  ratingCount: number;
  correctionCount: number;
  nodeCount: number;
  edgeCount: number;
  domainCount: number;
  effectiveness: number;
  rulesPerSession: number;
  scoreTrend: number;
  recallAt15: number;
  precisionAt5: number;
  mrr: number;
  budgetGlobal: string;
  domains: DomainEntry[];
  topPerformers: RulePerformer[];
  bottomPerformers: RulePerformer[];
  healthChecks: HealthCheck[];
  version: string;
  testCount: number;
}

function statusColor(status: "green" | "amber" | "red"): string {
  if (status === "green") return "#16a34a";
  if (status === "amber") return "#d97706";
  return "#dc2626";
}

function statusLabel(status: "green" | "amber" | "red"): string {
  if (status === "green") return "Healthy";
  if (status === "amber") return "Warning";
  return "Critical";
}

function metricCard(value: string, label: string): string {
  return `<div class="metric-card">
  <div class="metric-value">${value}</div>
  <div class="metric-label">${label}</div>
</div>`;
}

function loopStagePosition(index: number, total: number, cx: number, cy: number, r: number): { x: number; y: number } {
  const angle = (2 * Math.PI * index) / total - Math.PI / 2;
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

function buildLoopSvg(m: ShowcaseMetrics): string {
  const cx = 250, cy = 250, r = 180;
  const stages = [
    { name: "CAPTURE", sub: `${m.ratingCount} ratings, ${m.correctionCount} corrections` },
    { name: "DETECT", sub: "pattern clustering" },
    { name: "PROMOTE", sub: `${m.nodeCount} nodes, ${m.domainCount} domains` },
    { name: "INJECT", sub: `${m.rulesPerSession} rules/session` },
    { name: "MEASURE", sub: `${m.effectiveness}% effectiveness` },
    { name: "EVICT", sub: "low-correlation retired" },
  ];
  const colors = ["#2563eb", "#7c3aed", "#0891b2", "#059669", "#d97706", "#dc2626"];

  let nodes = "";
  const positions: { x: number; y: number }[] = [];

  for (let i = 0; i < stages.length; i++) {
    const pos = loopStagePosition(i, stages.length, cx, cy, r);
    positions.push(pos);
    nodes += `<g>
  <circle cx="${pos.x}" cy="${pos.y}" r="48" fill="${colors[i]}" opacity="0.12" stroke="${colors[i]}" stroke-width="2.5"/>
  <text x="${pos.x}" y="${pos.y - 8}" text-anchor="middle" font-size="13" font-weight="700" fill="${colors[i]}">${stages[i].name}</text>
  <text x="${pos.x}" y="${pos.y + 10}" text-anchor="middle" font-size="9" fill="#6b7280">${stages[i].sub}</text>
</g>`;
  }

  let arrows = "";
  for (let i = 0; i < stages.length; i++) {
    const from = positions[i];
    const to = positions[(i + 1) % stages.length];
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const ux = dx / dist;
    const uy = dy / dist;
    const startX = from.x + ux * 50;
    const startY = from.y + uy * 50;
    const endX = to.x - ux * 50;
    const endY = to.y - uy * 50;
    arrows += `<line x1="${startX.toFixed(1)}" y1="${startY.toFixed(1)}" x2="${endX.toFixed(1)}" y2="${endY.toFixed(1)}" stroke="#cbd5e1" stroke-width="2" marker-end="url(#arrow)"/>`;
  }

  // Feedback arrows (MEASURE→CAPTURE, EVICT→DETECT, MEASURE→EVICT)
  const feedbackPairs = [[4, 0], [5, 1], [4, 5]];
  let feedbackArrows = "";
  for (const [fi, ti] of feedbackPairs) {
    const from = positions[fi];
    const to = positions[ti];
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const ux = dx / dist;
    const uy = dy / dist;
    const offsetX = -uy * 30;
    const offsetY = ux * 30;
    const ctrlX = midX + offsetX;
    const ctrlY = midY + offsetY;
    const startX = from.x + ux * 50;
    const startY = from.y + uy * 50;
    const endX = to.x - ux * 50;
    const endY = to.y - uy * 50;
    feedbackArrows += `<path d="M${startX.toFixed(1)},${startY.toFixed(1)} Q${ctrlX.toFixed(1)},${ctrlY.toFixed(1)} ${endX.toFixed(1)},${endY.toFixed(1)}" fill="none" stroke="#2563eb" stroke-width="2" stroke-dasharray="6,4" marker-end="url(#arrow-accent)" opacity="0.6"/>`;
  }

  return `<svg viewBox="0 0 500 500" xmlns="http://www.w3.org/2000/svg" class="loop-svg">
  <defs>
    <marker id="arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6" fill="#cbd5e1"/></marker>
    <marker id="arrow-accent" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6" fill="#2563eb"/></marker>
  </defs>
  ${arrows}
  ${feedbackArrows}
  ${nodes}
  <text x="${cx}" y="${cy}" text-anchor="middle" font-size="16" font-weight="700" fill="#111827">Learning</text>
  <text x="${cx}" y="${cy + 18}" text-anchor="middle" font-size="16" font-weight="700" fill="#111827">Loop</text>
</svg>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderShowcase(m: ShowcaseMetrics): string {
  const loopSvg = buildLoopSvg(m);

  const metricsGrid = [
    metricCard(String(m.ratingCount), "Ratings Captured"),
    metricCard(String(m.correctionCount), "Corrections Tracked"),
    metricCard(String(m.nodeCount), "Knowledge Graph Nodes"),
    metricCard(String(m.edgeCount), "Graph Edges"),
    metricCard(`${m.effectiveness}%`, "Rule Effectiveness"),
    metricCard(String(m.rulesPerSession), "Avg Rules/Session"),
    metricCard(m.scoreTrend.toFixed(1), "Avg Correlated Rating"),
    metricCard(m.recallAt15.toFixed(3), "Recall@15"),
    metricCard(m.precisionAt5.toFixed(3), "Precision@5"),
    metricCard(m.mrr.toFixed(3), "Mean Reciprocal Rank"),
    metricCard(m.budgetGlobal, "Global Budget"),
    metricCard(String(m.domainCount), "Domains"),
  ].join("\n");

  const domainRows = m.domains
    .map((d) => `<tr><td>${escapeHtml(d.name)}</td><td class="num">${d.count}</td></tr>`)
    .join("\n");

  const topRows = m.topPerformers
    .map((r) => `<tr><td>${escapeHtml(r.id)}</td><td class="num">${r.rating.toFixed(1)}</td><td class="num">${r.injections}</td></tr>`)
    .join("\n");

  const bottomRows = m.bottomPerformers
    .map((r) => `<tr><td>${escapeHtml(r.id)}</td><td class="num">${r.rating.toFixed(1)}</td><td class="num">${r.injections}</td></tr>`)
    .join("\n");

  const healthRows = m.healthChecks
    .map((h) => `<tr><td><span class="status-dot" style="background:${statusColor(h.status)}"></span> ${escapeHtml(h.label)}</td><td>${statusLabel(h.status)}</td><td>${escapeHtml(h.detail)}</td></tr>`)
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentGrit — Living System Dashboard</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  color: #111827; background: #ffffff; line-height: 1.6;
  max-width: 1200px; margin: 0 auto; padding: 2rem 1.5rem;
}
h1 { font-size: 2.5rem; font-weight: 800; letter-spacing: -0.03em; }
h2 { font-size: 1.5rem; font-weight: 700; margin: 2.5rem 0 1rem; color: #111827; border-bottom: 2px solid #e5e7eb; padding-bottom: 0.5rem; }
h3 { font-size: 1.1rem; font-weight: 600; margin: 1.5rem 0 0.5rem; }
.hero { text-align: center; padding: 3rem 0 2rem; }
.hero h1 { color: #111827; }
.hero .tagline { font-size: 1.15rem; color: #6b7280; margin-top: 0.5rem; }
.hero .timestamp { font-size: 0.85rem; color: #9ca3af; margin-top: 0.75rem; font-family: 'SF Mono', 'Fira Code', monospace; }
.loop-container { display: flex; justify-content: center; padding: 1rem 0; }
.loop-svg { width: 100%; max-width: 500px; height: auto; }
.metrics-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1rem; margin: 1rem 0;
}
.metric-card {
  background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 12px;
  padding: 1.5rem; text-align: center;
}
.metric-value { font-size: 2.75rem; font-weight: 800; color: #2563eb; line-height: 1.1; }
.metric-label { font-size: 0.85rem; color: #6b7280; margin-top: 0.5rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; }
.explainer-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.5rem; margin: 1rem 0; }
.explainer-panel {
  background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 12px; padding: 1.5rem;
}
.explainer-panel .step-num { font-size: 2rem; font-weight: 800; color: #2563eb; }
.explainer-panel h3 { margin-top: 0.5rem; }
.explainer-panel p { font-size: 0.9rem; color: #6b7280; margin-top: 0.5rem; }
table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: 0.9rem; }
th { text-align: left; padding: 0.75rem 1rem; background: #f9fafb; border-bottom: 2px solid #e5e7eb; font-weight: 600; color: #374151; }
td { padding: 0.6rem 1rem; border-bottom: 1px solid #f3f4f6; }
td.num { text-align: right; font-family: 'SF Mono', 'Fira Code', monospace; }
tr:hover td { background: #f9fafb; }
.status-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 0.5rem; vertical-align: middle; }
.domain-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 0; }
.performer-tables { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; }
footer { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid #e5e7eb; font-size: 0.8rem; color: #9ca3af; text-align: center; }
footer code { font-family: 'SF Mono', 'Fira Code', monospace; background: #f3f4f6; padding: 0.15em 0.4em; border-radius: 4px; }

@media (max-width: 768px) {
  .explainer-grid { grid-template-columns: 1fr; }
  .performer-tables { grid-template-columns: 1fr; }
  .metrics-grid { grid-template-columns: repeat(2, 1fr); }
  h1 { font-size: 1.75rem; }
}

@media print {
  body { padding: 1rem; max-width: none; }
  .metric-card, .explainer-panel { break-inside: avoid; }
  h2 { break-after: avoid; }
  .loop-container { break-inside: avoid; }
  table { break-inside: avoid; }
  footer { break-before: avoid; }
}
</style>
</head>
<body>

<section class="hero">
  <h1>AgentGrit</h1>
  <p class="tagline">Self-Learning Engine for AI Agents</p>
  <p class="timestamp">Generated ${escapeHtml(m.generatedAt)} from live system state</p>
</section>

<h2>The Learning Loop</h2>
<div class="loop-container">
${loopSvg}
</div>

<h2>System Metrics</h2>
<div class="metrics-grid">
${metricsGrid}
</div>

<h2>How It Learns</h2>
<div class="explainer-grid">
  <div class="explainer-panel">
    <div class="step-num">1</div>
    <h3>Capture</h3>
    <p>Every correction, rating, and failure is recorded as a signal. The system watches what goes wrong and what goes right.</p>
  </div>
  <div class="explainer-panel">
    <div class="step-num">2</div>
    <h3>Detect &amp; Promote</h3>
    <p>Patterns emerge from repeated corrections. When a pattern appears 3+ times, it becomes a candidate rule and enters the knowledge graph.</p>
  </div>
  <div class="explainer-panel">
    <div class="step-num">3</div>
    <h3>Inject &amp; Measure</h3>
    <p>Only relevant rules fire per session via domain-filtered retrieval. Effectiveness is measured through correlation tracking. Weak rules get evicted.</p>
  </div>
</div>

<h2>Domain Taxonomy</h2>
<table>
  <thead><tr><th>Domain</th><th style="text-align:right">Nodes</th></tr></thead>
  <tbody>${domainRows}</tbody>
</table>

<h2>Rule Performance</h2>
<div class="performer-tables">
  <div>
    <h3>Top 5 Performers</h3>
    <table>
      <thead><tr><th>Rule</th><th style="text-align:right">Rating</th><th style="text-align:right">Injections</th></tr></thead>
      <tbody>${topRows}</tbody>
    </table>
  </div>
  <div>
    <h3>Bottom 5 Performers</h3>
    <table>
      <thead><tr><th>Rule</th><th style="text-align:right">Rating</th><th style="text-align:right">Injections</th></tr></thead>
      <tbody>${bottomRows}</tbody>
    </table>
  </div>
</div>

<h2>System Health</h2>
<table>
  <thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead>
  <tbody>${healthRows}</tbody>
</table>

<footer>
  <p><code>@agentgrit/core@${escapeHtml(m.version)}</code> &middot; ${m.testCount} tests passing &middot; ${m.nodeCount} graph nodes &middot; ${m.edgeCount} edges</p>
  <p>The user should never have to correct the same mistake twice.</p>
</footer>

</body>
</html>`;
}
