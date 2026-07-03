import type { Score } from "../adapters/types";

export interface DimensionAnalysis { dimension: string; avg: number; min: number; max: number; stddev: number; count: number; }
export interface TrendResult { dimension: string; direction: "improving" | "declining" | "stable"; recentAvg: number; priorAvg: number; delta: number; }

export function analyzeScores(scores: Score[]): DimensionAnalysis[] {
  const byDim = new Map<string, number[]>();
  for (const s of scores) { if (!byDim.has(s.dimension)) byDim.set(s.dimension, []); byDim.get(s.dimension)!.push(s.value); }
  const results: DimensionAnalysis[] = [];
  for (const [dimension, values] of byDim) {
    if (values.length === 0) continue;
    const sum = values.reduce((a, b) => a + b, 0); const avg = sum / values.length;
    const min = Math.min(...values); const max = Math.max(...values);
    const variance = values.reduce((acc, v) => acc + (v - avg) ** 2, 0) / values.length;
    results.push({ dimension, avg: Math.round(avg * 100) / 100, min, max, stddev: Math.round(Math.sqrt(variance) * 100) / 100, count: values.length });
  }
  return results.sort((a, b) => a.avg - b.avg);
}

export function detectTrends(scores: Score[], windowDays = 7): TrendResult[] {
  if (scores.length === 0) return [];
  const now = Date.now(); const cutoff = now - windowDays * 86400000;
  const byDim = new Map<string, { recent: number[]; prior: number[] }>();
  for (const s of scores) {
    const ts = new Date(s.timestamp).getTime();
    if (!byDim.has(s.dimension)) byDim.set(s.dimension, { recent: [], prior: [] });
    const b = byDim.get(s.dimension)!; (ts >= cutoff ? b.recent : b.prior).push(s.value);
  }
  const results: TrendResult[] = [];
  for (const [dimension, { recent, prior }] of byDim) {
    if (recent.length === 0 || prior.length === 0) continue;
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const priorAvg = prior.reduce((a, b) => a + b, 0) / prior.length;
    const delta = recentAvg - priorAvg;
    const direction = delta > 0.3 ? "improving" as const : delta < -0.3 ? "declining" as const : "stable" as const;
    results.push({ dimension, direction, recentAvg: Math.round(recentAvg * 100) / 100, priorAvg: Math.round(priorAvg * 100) / 100, delta: Math.round(delta * 100) / 100 });
  }
  return results;
}

// ── Impact Analysis ──
export interface RatingEntry { timestamp: string; rating: number; source?: string; ruleIds?: string[]; }
export interface WeeklyTrend { week: string; count: number; avg: number; highPct: number; lowPct: number; }
export interface ImpactReport { totalSessions: number; overallAvg: number; first20Avg: number; last20Avg: number; improvement: number; weeklyTrends: WeeklyTrend[]; ruleAttributionRate: number; }

function weekKey(ts: string): string {
  const d = new Date(ts); const jan1 = new Date(d.getFullYear(), 0, 1);
  const days = Math.floor((d.getTime() - jan1.getTime()) / 86400000);
  return `${d.getFullYear()}-W${String(Math.ceil((days + jan1.getDay() + 1) / 7)).padStart(2, "0")}`;
}

export function analyzeImpact(ratings: RatingEntry[]): ImpactReport {
  if (ratings.length === 0) return { totalSessions: 0, overallAvg: 0, first20Avg: 0, last20Avg: 0, improvement: 0, weeklyTrends: [], ruleAttributionRate: 0 };
  const weeks = new Map<string, number[]>();
  for (const r of ratings) { const w = weekKey(r.timestamp); if (!weeks.has(w)) weeks.set(w, []); weeks.get(w)!.push(r.rating); }
  const weeklyTrends: WeeklyTrend[] = [...weeks.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, vals]) => ({ week, count: vals.length, avg: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10, highPct: Math.round(100 * vals.filter((v) => v >= 7).length / vals.length), lowPct: Math.round(100 * vals.filter((v) => v <= 3).length / vals.length) }));
  const overallAvg = ratings.reduce((s, r) => s + r.rating, 0) / ratings.length;
  const f20 = ratings.slice(0, 20); const l20 = ratings.slice(-20);
  const f20Avg = f20.reduce((s, r) => s + r.rating, 0) / f20.length;
  const l20Avg = l20.reduce((s, r) => s + r.rating, 0) / l20.length;
  const withRules = ratings.filter((r) => r.ruleIds && r.ruleIds.length > 0).length;
  return { totalSessions: ratings.length, overallAvg: Math.round(overallAvg * 10) / 10, first20Avg: Math.round(f20Avg * 10) / 10, last20Avg: Math.round(l20Avg * 10) / 10, improvement: Math.round((l20Avg - f20Avg) * 10) / 10, weeklyTrends, ruleAttributionRate: Math.round(withRules / ratings.length * 100) };
}

// ── Tool Audit ──
export interface ToolAuditEntry { ts?: string; tool?: string; ok?: boolean; }
export interface ToolStats { tool: string; calls: number; errors: number; errorRate: number; }
export interface ToolAuditReport { totalCalls: number; toolCount: number; flaggedCount: number; tools: ToolStats[]; flaggedTools: ToolStats[]; generatedAt: string; }

export function analyzeToolAudit(entries: ToolAuditEntry[], flagThreshold = 0.10): ToolAuditReport {
  const byTool = new Map<string, { calls: number; errors: number }>();
  for (const e of entries) {
    const tool = typeof e.tool === "string" && e.tool.length > 0 ? e.tool : "unknown";
    const s = byTool.get(tool) || { calls: 0, errors: 0 }; s.calls++; if (e.ok === false) s.errors++; byTool.set(tool, s);
  }
  const tools: ToolStats[] = Array.from(byTool.entries())
    .map(([tool, s]) => ({ tool, calls: s.calls, errors: s.errors, errorRate: s.calls === 0 ? 0 : Math.round(s.errors / s.calls * 1000) / 1000 }))
    .sort((a, b) => b.errorRate !== a.errorRate ? b.errorRate - a.errorRate : b.calls - a.calls);
  const flaggedTools = tools.filter((s) => s.calls > 0 && s.errorRate > flagThreshold);
  return { totalCalls: entries.length, toolCount: tools.length, flaggedCount: flaggedTools.length, tools, flaggedTools, generatedAt: new Date().toISOString() };
}
