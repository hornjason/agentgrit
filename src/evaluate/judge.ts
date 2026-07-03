import type { RubricConfig, Score } from "../adapters/types";
import { SCHEMA_VERSION } from "../adapters/types";

export interface JudgeConfig {
  provider: "gemini" | "claude" | "openai";
  model: string;
  apiKey?: string;
  temperature?: number;
  maxRetries?: number;
}

export interface Trace {
  input: string;
  output: string;
  id?: string;
  name?: string;
}

function buildPrompt(trace: Trace, rubric: RubricConfig): string {
  const dimensionBlock = rubric.dimensions
    .map((d) => `- ${d.name}: ${d.rubric}`)
    .join("\n");

  const jsonShape = rubric.dimensions
    .map((d) => `"${d.name}": { "score": N, "reasoning": "..." }`)
    .join(", ");

  return `You are evaluating the quality of AI-generated output.

## Content to evaluate
Input: ${truncate(trace.input, 2000)}
Output: ${truncate(trace.output, 4000)}

## Scoring dimensions
For each dimension, score 1-5 and provide brief reasoning:
${dimensionBlock}

Return ONLY valid JSON:
{${jsonShape}}`;
}

function truncate(text: string, maxLen: number): string {
  if (!text) return "(empty)";
  return text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
}

async function callInference(
  prompt: string,
  config: JudgeConfig,
): Promise<Record<string, { score: number; reasoning: string }> | null> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let url: string;
  let body: string;

  if (config.provider === "openai") {
    if (!config.apiKey) return null;
    url = "https://api.openai.com/v1/chat/completions";
    headers["Authorization"] = `Bearer ${config.apiKey}`;
    body = JSON.stringify({
      model: config.model,
      messages: [{ role: "user", content: prompt }],
      temperature: config.temperature ?? 0.1,
      response_format: { type: "json_object" },
    });
  } else if (config.provider === "claude") {
    if (!config.apiKey) return null;
    url = "https://api.anthropic.com/v1/messages";
    headers["x-api-key"] = config.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    body = JSON.stringify({
      model: config.model,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
      temperature: config.temperature ?? 0.1,
    });
  } else if (config.provider === "gemini") {
    if (!config.apiKey) return null;
    url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`;
    body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: config.temperature ?? 0.1,
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
      },
    });
  } else {
    return null;
  }

  const maxRetries = config.maxRetries ?? 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, { method: "POST", headers, body });

      if (resp.status === 429) {
        const wait = Math.min(30 * (attempt + 1), 120);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }

      if (!resp.ok) return null;

      const json = (await resp.json()) as Record<string, unknown>;
      return extractScores(json, config.provider);
    } catch {
      if (attempt === maxRetries) return null;
    }
  }

  return null;
}

function extractScores(
  json: Record<string, unknown>,
  provider: string,
): Record<string, { score: number; reasoning: string }> | null {
  let text: string | undefined;

  if (provider === "openai") {
    const choices = json.choices as Array<{ message?: { content?: string } }> | undefined;
    text = choices?.[0]?.message?.content ?? undefined;
  } else if (provider === "claude") {
    const content = json.content as Array<{ text?: string }> | undefined;
    text = content?.[0]?.text ?? undefined;
  } else if (provider === "gemini") {
    const candidates = json.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined;
    text = candidates?.[0]?.content?.parts?.[0]?.text ?? undefined;
  }

  if (!text) return null;

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const result: Record<string, { score: number; reasoning: string }> = {};

    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val === "object" && val !== null) {
        const obj = val as Record<string, unknown>;
        const score = Number(obj.score ?? obj.value);
        const reasoning = String(obj.reasoning ?? obj.reason ?? "");
        if (score >= 1 && score <= 5) {
          result[key] = { score, reasoning };
        }
      } else if (typeof val === "number" && val >= 1 && val <= 5) {
        result[key] = { score: val, reasoning: "" };
      }
    }

    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

export async function judgeTrace(
  trace: Trace,
  rubric: RubricConfig,
  config: JudgeConfig,
): Promise<Score[]> {
  if (!config.apiKey) return [];

  const prompt = buildPrompt(trace, rubric);
  const rawScores = await callInference(prompt, config);
  if (!rawScores) return [];

  const traceId = trace.id ?? `trace-${Date.now()}`;
  const timestamp = new Date().toISOString();

  return rubric.dimensions
    .filter((d) => rawScores[d.name] !== undefined)
    .map((d) => ({
      traceId,
      dimension: d.name,
      value: rawScores[d.name].score,
      rubric: d.rubric,
      judgeModel: config.model,
      reasoning: rawScores[d.name].reasoning || undefined,
      timestamp,
      schemaVersion: SCHEMA_VERSION,
    }));
}
