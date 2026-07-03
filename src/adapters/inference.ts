/**
 * inference.ts — Unified LLM inference with three run levels
 *
 * Consolidated from PAI Tools/Inference.ts.
 * Provides a single interface for all LLM calls across the system:
 *   - fast:     cheap/quick (Haiku-class)
 *   - standard: balanced reasoning (Sonnet-class)
 *   - smart:    deep reasoning (Opus-class)
 *
 * Multi-provider support via environment variables:
 *   - Claude (default): uses `claude` CLI
 *   - Gemini: GEMINI_API_KEY or gcloud ADC
 *   - OpenAI: OPENAI_API_KEY
 */

import { spawn } from "child_process";

export type InferenceLevel = "fast" | "standard" | "smart";
export type InferenceProvider = "claude-cli" | "gemini" | "openai";

export interface InferenceOptions {
  systemPrompt: string;
  userPrompt: string;
  level?: InferenceLevel;
  provider?: InferenceProvider;
  expectJson?: boolean;
  timeout?: number;
}

export interface InferenceResult {
  success: boolean;
  output: string;
  parsed?: unknown;
  error?: string;
  latencyMs: number;
  level: InferenceLevel;
  provider: InferenceProvider;
}

// ── Level Configs ──

interface LevelConfig {
  model: string;
  defaultTimeout: number;
}

const CLAUDE_LEVELS: Record<InferenceLevel, LevelConfig> = {
  fast: { model: "claude-haiku-4-5-20251001", defaultTimeout: 15_000 },
  standard: { model: "claude-sonnet-5", defaultTimeout: 30_000 },
  smart: { model: "claude-opus-4-6", defaultTimeout: 90_000 },
};

const GEMINI_LEVELS: Record<InferenceLevel, LevelConfig> = {
  fast: { model: "gemini-2.0-flash-lite", defaultTimeout: 15_000 },
  standard: { model: "gemini-2.0-flash", defaultTimeout: 30_000 },
  smart: { model: "gemini-2.5-pro", defaultTimeout: 90_000 },
};

const OPENAI_LEVELS: Record<InferenceLevel, LevelConfig> = {
  fast: { model: "gpt-4o-mini", defaultTimeout: 15_000 },
  standard: { model: "gpt-4o", defaultTimeout: 30_000 },
  smart: { model: "o3", defaultTimeout: 90_000 },
};

function getConfig(provider: InferenceProvider, level: InferenceLevel): LevelConfig {
  switch (provider) {
    case "gemini": return GEMINI_LEVELS[level];
    case "openai": return OPENAI_LEVELS[level];
    case "claude-cli":
    default: return CLAUDE_LEVELS[level];
  }
}

// ── Provider: Claude CLI ──

function inferenceClaude(options: InferenceOptions, config: LevelConfig, timeout: number): Promise<InferenceResult> {
  const level = options.level || "standard";

  return new Promise((resolve) => {
    // Strip API key and CLAUDECODE to force subscription auth and prevent
    // recursive invocation when running inside Claude Code
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.CLAUDECODE;

    const args = [
      "--print",
      "--bare",
      "--model", config.model,
      "--tools", "",
      "--output-format", options.expectJson ? "json" : "text",
      "--max-tokens", "4096",
      "--system-prompt", options.systemPrompt,
    ];

    let stdout = "";
    let stderr = "";
    const startTime = Date.now();

    const proc = spawn("claude", args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Write prompt via stdin to avoid ARG_MAX limits on large inputs
    proc.stdin.write(options.userPrompt);
    proc.stdin.end();

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    const timeoutId = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({
        success: false,
        output: "",
        error: `Timeout after ${timeout}ms`,
        latencyMs: Date.now() - startTime,
        level,
        provider: "claude-cli",
      });
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timeoutId);
      const latencyMs = Date.now() - startTime;

      if (code !== 0) {
        resolve({ success: false, output: stdout, error: stderr || `exit ${code}`, latencyMs, level, provider: "claude-cli" });
        return;
      }

      const output = stdout.trim();

      if (options.expectJson) {
        const parsed = tryParseJson(output);
        if (parsed !== undefined) {
          resolve({ success: true, output, parsed, latencyMs, level, provider: "claude-cli" });
        } else {
          resolve({ success: false, output, error: "Failed to parse JSON response", latencyMs, level, provider: "claude-cli" });
        }
        return;
      }

      resolve({ success: true, output, latencyMs, level, provider: "claude-cli" });
    });

    proc.on("error", (err) => {
      clearTimeout(timeoutId);
      const msg = err.message.includes("ENOENT")
        ? "claude CLI not found — install Claude Code first"
        : err.message;
      resolve({ success: false, output: "", error: msg, latencyMs: Date.now() - startTime, level, provider: "claude-cli" });
    });
  });
}

// ── Provider: Gemini ──

async function inferenceGemini(options: InferenceOptions, config: LevelConfig, timeout: number): Promise<InferenceResult> {
  const level = options.level || "standard";
  const startTime = Date.now();

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { success: false, output: "", error: "GEMINI_API_KEY not set", latencyMs: 0, level, provider: "gemini" };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${apiKey}`;

  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: options.userPrompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
  };

  if (options.systemPrompt) {
    body.systemInstruction = { parts: [{ text: options.systemPrompt }] };
  }
  if (options.expectJson) {
    (body.generationConfig as Record<string, unknown>).responseMimeType = "application/json";
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const latencyMs = Date.now() - startTime;

    if (!resp.ok) {
      const errText = await resp.text();
      return { success: false, output: "", error: `Gemini ${resp.status}: ${errText.slice(0, 200)}`, latencyMs, level, provider: "gemini" };
    }

    const json = await resp.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (options.expectJson) {
      const parsed = tryParseJson(text);
      if (parsed !== undefined) {
        return { success: true, output: text, parsed, latencyMs, level, provider: "gemini" };
      }
      return { success: false, output: text, error: "Failed to parse JSON response", latencyMs, level, provider: "gemini" };
    }

    return { success: true, output: text, latencyMs, level, provider: "gemini" };
  } catch (err: unknown) {
    return { success: false, output: "", error: String(err), latencyMs: Date.now() - startTime, level, provider: "gemini" };
  }
}

// ── Provider: OpenAI ──

async function inferenceOpenAI(options: InferenceOptions, config: LevelConfig, timeout: number): Promise<InferenceResult> {
  const level = options.level || "standard";
  const startTime = Date.now();

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { success: false, output: "", error: "OPENAI_API_KEY not set", latencyMs: 0, level, provider: "openai" };
  }

  const messages = [
    { role: "system" as const, content: options.systemPrompt },
    { role: "user" as const, content: options.userPrompt },
  ];

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.3,
        max_tokens: 4096,
        ...(options.expectJson ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const latencyMs = Date.now() - startTime;

    if (!resp.ok) {
      const errText = await resp.text();
      return { success: false, output: "", error: `OpenAI ${resp.status}: ${errText.slice(0, 200)}`, latencyMs, level, provider: "openai" };
    }

    const json = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = json.choices?.[0]?.message?.content || "";

    if (options.expectJson) {
      const parsed = tryParseJson(text);
      if (parsed !== undefined) {
        return { success: true, output: text, parsed, latencyMs, level, provider: "openai" };
      }
      return { success: false, output: text, error: "Failed to parse JSON response", latencyMs, level, provider: "openai" };
    }

    return { success: true, output: text, latencyMs, level, provider: "openai" };
  } catch (err: unknown) {
    return { success: false, output: "", error: String(err), latencyMs: Date.now() - startTime, level, provider: "openai" };
  }
}

// ── JSON Parser ──

function tryParseJson(text: string): unknown | undefined {
  const cleaned = text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();

  // Try object match first, then array
  for (const pattern of [/\{[\s\S]*\}/, /\[[\s\S]*\]/]) {
    const match = cleaned.match(pattern);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* try next */ }
    }
  }
  // Try the whole string
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  return undefined;
}

// ── Detect provider ──

function detectProvider(): InferenceProvider {
  if (process.env.AGENTGRIT_PROVIDER) {
    const p = process.env.AGENTGRIT_PROVIDER.toLowerCase();
    if (p === "gemini") return "gemini";
    if (p === "openai") return "openai";
    if (p === "claude-cli" || p === "claude") return "claude-cli";
  }
  // Default to claude CLI — every AgentGrit user has Claude Code installed
  return "claude-cli";
}

// ── Main Inference Function ──

export async function inference(options: InferenceOptions): Promise<InferenceResult> {
  const level = options.level || "standard";
  const provider = options.provider || detectProvider();
  const config = getConfig(provider, level);
  const timeout = options.timeout || config.defaultTimeout;

  switch (provider) {
    case "gemini":
      return inferenceGemini(options, config, timeout);
    case "openai":
      return inferenceOpenAI(options, config, timeout);
    case "claude-cli":
    default:
      return inferenceClaude(options, config, timeout);
  }
}
