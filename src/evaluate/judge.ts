import type { RubricConfig, Score } from "../adapters/types";
import { SCHEMA_VERSION } from "../adapters/types";

export interface JudgeConfig { provider: "gemini" | "claude" | "openai"; model: string; apiKey?: string; temperature?: number; maxRetries?: number; }
export interface Trace { input: string; output: string; id?: string; name?: string; }
export interface BatchResult { traceId: string; scores: Score[]; error?: string; }

function buildPrompt(trace: Trace, rubric: RubricConfig): string {
  const dims = rubric.dimensions.map((d) => `- ${d.name}: ${d.rubric}`).join("\n");
  const shape = rubric.dimensions.map((d) => `"${d.name}": { "score": N, "reasoning": "..." }`).join(", ");
  return `You are evaluating the quality of AI-generated output.\n\n## Content to evaluate\nInput: ${trunc(trace.input, 2000)}\nOutput: ${trunc(trace.output, 4000)}\n\n## Scoring dimensions\nFor each dimension, score 1-5 and provide brief reasoning:\n${dims}\n\nReturn ONLY valid JSON:\n{${shape}}`;
}

function trunc(text: string, maxLen: number): string { return !text ? "(empty)" : text.length > maxLen ? text.slice(0, maxLen) + "..." : text; }

async function callInference(prompt: string, config: JudgeConfig): Promise<Record<string, { score: number; reasoning: string }> | null> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let url: string; let body: string;
  if (config.provider === "openai") {
    if (!config.apiKey) return null; url = "https://api.openai.com/v1/chat/completions"; headers["Authorization"] = `Bearer ${config.apiKey}`;
    body = JSON.stringify({ model: config.model, messages: [{ role: "user", content: prompt }], temperature: config.temperature ?? 0.1, response_format: { type: "json_object" } });
  } else if (config.provider === "claude") {
    if (!config.apiKey) return null; url = "https://api.anthropic.com/v1/messages"; headers["x-api-key"] = config.apiKey; headers["anthropic-version"] = "2023-06-01";
    body = JSON.stringify({ model: config.model, max_tokens: 2048, messages: [{ role: "user", content: prompt }], temperature: config.temperature ?? 0.1 });
  } else if (config.provider === "gemini") {
    if (!config.apiKey) return null; url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`;
    body = JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: config.temperature ?? 0.1, maxOutputTokens: 2048, responseMimeType: "application/json" } });
  } else { return null; }
  const maxRetries = config.maxRetries ?? 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, { method: "POST", headers, body });
      if (resp.status === 429) { await new Promise((r) => setTimeout(r, Math.min(30 * (attempt + 1), 120) * 1000)); continue; }
      if (!resp.ok) return null;
      return extractScores((await resp.json()) as Record<string, unknown>, config.provider);
    } catch { if (attempt === maxRetries) return null; }
  }
  return null;
}

function extractScores(json: Record<string, unknown>, provider: string): Record<string, { score: number; reasoning: string }> | null {
  let text: string | undefined;
  if (provider === "openai") { const c = json.choices as Array<{ message?: { content?: string } }> | undefined; text = c?.[0]?.message?.content ?? undefined; }
  else if (provider === "claude") { const c = json.content as Array<{ text?: string }> | undefined; text = c?.[0]?.text ?? undefined; }
  else if (provider === "gemini") { const c = json.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined; text = c?.[0]?.content?.parts?.[0]?.text ?? undefined; }
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/); if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]); const result: Record<string, { score: number; reasoning: string }> = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val === "object" && val !== null) { const o = val as Record<string, unknown>; const s = Number(o.score ?? o.value); if (s >= 1 && s <= 5) result[key] = { score: s, reasoning: String(o.reasoning ?? o.reason ?? "") }; }
      else if (typeof val === "number" && val >= 1 && val <= 5) result[key] = { score: val, reasoning: "" };
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch { return null; }
}

export async function judgeTrace(trace: Trace, rubric: RubricConfig, config: JudgeConfig): Promise<Score[]> {
  if (!config.apiKey) return [];
  const raw = await callInference(buildPrompt(trace, rubric), config); if (!raw) return [];
  const traceId = trace.id ?? `trace-${Date.now()}`; const timestamp = new Date().toISOString();
  return rubric.dimensions.filter((d) => raw[d.name] !== undefined).map((d) => ({
    traceId, dimension: d.name, value: raw[d.name].score, rubric: d.rubric, judgeModel: config.model,
    reasoning: raw[d.name].reasoning || undefined, timestamp, schemaVersion: SCHEMA_VERSION,
  }));
}

export async function judgeBatch(
  traces: Trace[], rubric: RubricConfig, config: JudgeConfig,
  opts?: { delayMs?: number; onProgress?: (done: number, total: number) => void },
): Promise<{ results: BatchResult[]; evaluated: number; failed: number }> {
  if (!config.apiKey) return { results: traces.map((t) => ({ traceId: t.id ?? `trace-${Date.now()}`, scores: [], error: "no API key configured" })), evaluated: 0, failed: traces.length };
  const results: BatchResult[] = []; let evaluated = 0; let failed = 0; const delayMs = opts?.delayMs ?? 5000;
  for (let i = 0; i < traces.length; i++) {
    const trace = traces[i]; const traceId = trace.id ?? `trace-${Date.now()}-${i}`;
    try { const scores = await judgeTrace(trace, rubric, config); if (scores.length > 0) { results.push({ traceId, scores }); evaluated++; } else { results.push({ traceId, scores: [], error: "judge returned no valid scores" }); failed++; } }
    catch (err) { results.push({ traceId, scores: [], error: err instanceof Error ? err.message : String(err) }); failed++; }
    opts?.onProgress?.(i + 1, traces.length);
    if (i < traces.length - 1 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { results, evaluated, failed };
}

export function scoresToJsonl(scores: Score[]): string { return scores.map((s) => JSON.stringify(s)).join("\n") + (scores.length > 0 ? "\n" : ""); }
export function jsonlToScores(jsonl: string): Score[] {
  return jsonl.split("\n").filter((l) => l.trim().length > 0).map((l) => { try { return JSON.parse(l) as Score; } catch { return null; } }).filter((s): s is Score => s !== null);
}
