/**
 * langfuse.ts — Langfuse adapter for observability, score sync, and trace caching
 *
 * Consolidated from:
 *   - PAI Tools/langfuse-instrumentation.ts (OTel + Langfuse setup)
 *   - PAI Tools/LangfuseScoreSync.ts (batch sync scores)
 *   - PAI Tools/LangfuseTraceCache.ts (download traces to local cache)
 *
 * Single adapter with: connectLangfuse(), syncScores(), fetchTraces(), cacheTraces()
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { createHash } from "crypto";
import type { Score } from "./types";
import { getBaseDir, stateDir } from "./paths";

// ── Types ──

export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
}

export interface LangfuseTrace {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface SyncState {
  ratingsOffset: number;
  qualityOffset: number;
  lastSync: string;
  scoresPushed: number;
}

export interface SyncResult {
  scoresSynced: number;
  tracesCreated: number;
  errors: string[];
}

export interface CacheResult {
  tracesCached: number;
  cacheFile: string;
}

// ── Connection ──

let _config: LangfuseConfig | null = null;

export function connectLangfuse(config: LangfuseConfig): void {
  _config = config;
}

export function getConfig(): LangfuseConfig | null {
  return _config;
}

function requireConfig(): LangfuseConfig {
  if (!_config) {
    throw new Error("Langfuse not connected. Call connectLangfuse() first.");
  }
  return _config;
}

function authHeader(config: LangfuseConfig): string {
  return `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`;
}

// ── API Helpers ──

async function fetchLangfuse(
  path: string,
  config: LangfuseConfig,
  params?: URLSearchParams,
): Promise<unknown> {
  const baseUrl = config.baseUrl || "https://us.cloud.langfuse.com";
  const url = params ? `${baseUrl}${path}?${params}` : `${baseUrl}${path}`;

  const resp = await fetch(url, {
    headers: { Authorization: authHeader(config) },
  });

  if (resp.status === 429) {
    const body = (await resp.json()) as { details?: { retryAfterSeconds?: number } };
    const wait = body?.details?.retryAfterSeconds || 10;
    await new Promise((r) => setTimeout(r, wait * 1000));
    return fetchLangfuse(path, config, params);
  }

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Langfuse API ${resp.status}: ${body.slice(0, 300)}`);
  }

  return resp.json();
}

async function postLangfuse(
  path: string,
  config: LangfuseConfig,
  body: unknown,
): Promise<unknown> {
  const baseUrl = config.baseUrl || "https://us.cloud.langfuse.com";
  const url = `${baseUrl}${path}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader(config),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (resp.status === 429) {
    await new Promise((r) => setTimeout(r, 10_000));
    return postLangfuse(path, config, body);
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Langfuse API ${resp.status}: ${text.slice(0, 300)}`);
  }

  return resp.json();
}

// ── State persistence ──

function syncStatePath(): string {
  return join(stateDir(), "langfuse-sync.json");
}

function loadSyncState(): SyncState {
  const path = syncStatePath();
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8"));
    }
  } catch { /* ignore */ }
  return { ratingsOffset: 0, qualityOffset: 0, lastSync: "", scoresPushed: 0 };
}

function saveSyncState(state: SyncState): void {
  const path = syncStatePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  state.lastSync = new Date().toISOString();
  writeFileSync(path, JSON.stringify(state, null, 2));
}

// ── Deterministic IDs ──

function deterministicId(source: string, sessionId: string, scoreName: string): string {
  return createHash("sha256")
    .update(`${source}:${sessionId}:${scoreName}`)
    .digest("hex")
    .slice(0, 36);
}

function traceIdForSession(sessionId: string): string {
  return createHash("sha256")
    .update(`agentgrit-trace:${sessionId}`)
    .digest("hex")
    .slice(0, 32);
}

// ── Score Sync ──

export async function syncScores(
  scores: Score[],
  options?: { backfill?: boolean; dryRun?: boolean },
): Promise<SyncResult> {
  const config = requireConfig();
  const result: SyncResult = { scoresSynced: 0, tracesCreated: 0, errors: [] };

  if (scores.length === 0) return result;

  // Group scores by traceId
  const byTrace = new Map<string, Score[]>();
  for (const score of scores) {
    const group = byTrace.get(score.traceId) || [];
    group.push(score);
    byTrace.set(score.traceId, group);
  }

  // Batch create traces and scores
  const batch: unknown[] = [];

  for (const [traceId, traceScores] of byTrace) {
    // Create anchor trace
    batch.push({
      id: deterministicId("trace", traceId, "anchor"),
      type: "trace-create",
      body: {
        id: traceIdForSession(traceId),
        name: "agentgrit-eval",
        metadata: { source: "agentgrit" },
        timestamp: traceScores[0].timestamp,
      },
    });
    result.tracesCreated++;

    // Attach scores
    for (const score of traceScores) {
      batch.push({
        id: deterministicId("score", traceId, score.dimension),
        type: "score-create",
        body: {
          traceId: traceIdForSession(traceId),
          name: score.dimension,
          value: score.value,
          comment: score.reasoning?.slice(0, 500),
          timestamp: score.timestamp,
        },
      });
    }
  }

  if (options?.dryRun) {
    result.scoresSynced = scores.length;
    return result;
  }

  try {
    await postLangfuse("/api/public/ingestion", config, { batch });
    result.scoresSynced = scores.length;
  } catch (err) {
    result.errors.push(`Batch ingestion failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

// ── Trace Fetching ──

export async function fetchTraces(
  traceTypes: string[],
  limit: number = 100,
): Promise<LangfuseTrace[]> {
  const config = requireConfig();
  const traces: LangfuseTrace[] = [];

  for (const traceType of traceTypes) {
    try {
      const params = new URLSearchParams({ name: traceType, limit: String(limit) });
      const resp = (await fetchLangfuse("/api/public/traces", config, params)) as {
        data?: LangfuseTrace[];
      };

      if (resp.data) {
        for (const trace of resp.data) {
          if (trace.input && trace.output) {
            traces.push({
              id: trace.id,
              name: trace.name,
              input: trace.input,
              output: trace.output,
              timestamp: trace.timestamp,
              metadata: trace.metadata as Record<string, unknown> | undefined,
            });
          }
        }
      }
    } catch (err) {
      // Non-fatal per trace type
      console.error(`[langfuse] Failed to fetch traces for ${traceType}: ${err}`);
    }
  }

  return traces;
}

// ── Trace Caching ──

export async function cacheTraces(
  traceTypes: string[],
  outputPath?: string,
): Promise<CacheResult> {
  const cachePath = outputPath || join(stateDir(), "langfuse-trace-cache.json");
  const dir = dirname(cachePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const traces = await fetchTraces(traceTypes);
  writeFileSync(cachePath, JSON.stringify(traces, null, 2));

  return {
    tracesCached: traces.length,
    cacheFile: cachePath,
  };
}

// ── Load cached traces ──

export function loadCachedTraces(cachePath?: string): LangfuseTrace[] {
  const path = cachePath || join(stateDir(), "langfuse-trace-cache.json");
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as LangfuseTrace[];
  } catch {
    return [];
  }
}

// ── Extract prompts from trace ──

export function extractPrompts(trace: LangfuseTrace): { systemPrompt: string; userPrompt: string } {
  let systemPrompt = "";
  let userPrompt = "";

  // Check metadata for system prompt
  const meta = trace.metadata as Record<string, unknown> | undefined;
  if (meta?.systemPrompt) {
    systemPrompt = typeof meta.systemPrompt === "string" ? meta.systemPrompt : JSON.stringify(meta.systemPrompt);
  }

  const input = trace.input;
  if (typeof input === "string") {
    userPrompt = input;
  } else if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;

    // Messages array format
    if (Array.isArray(obj.messages)) {
      const msgs = obj.messages as Array<{ role?: string; content?: string }>;
      const sysMsg = msgs.find((m) => m.role === "system");
      const userMsg = msgs.find((m) => m.role === "user");
      if (sysMsg?.content && !systemPrompt) systemPrompt = sysMsg.content;
      if (userMsg?.content) userPrompt = userMsg.content;
    }
    // Explicit fields
    else if ("systemPrompt" in obj || "userPrompt" in obj) {
      if (!systemPrompt) systemPrompt = String(obj.systemPrompt || obj.system_prompt || "");
      userPrompt = String(obj.userPrompt || obj.user_prompt || obj.prompt || obj.query || JSON.stringify(obj));
    }
    // Vertex AI format
    else if ("systemInstruction" in obj) {
      if (!systemPrompt) {
        const si = obj.systemInstruction as Record<string, unknown>;
        const parts = si?.parts as Array<{ text?: string }> | undefined;
        systemPrompt = Array.isArray(parts) ? parts.map((p) => p.text || "").join("\n") : JSON.stringify(si);
      }
      if (obj.contents) {
        userPrompt = JSON.stringify(obj.contents);
      }
    }
    // Fallback
    else {
      userPrompt = JSON.stringify(input);
    }
  }

  return { systemPrompt: systemPrompt.trim(), userPrompt: userPrompt.trim() };
}
