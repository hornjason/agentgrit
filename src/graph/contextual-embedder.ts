import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { inference } from "../adapters/inference";
import type { InferenceResult } from "../adapters/inference";

const DEFAULT_MODEL = "voyage-3-lite";
const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 100;

export interface ContextualEmbedCache {
  contextual_embeddings?: Record<string, number[]>;
  contextual_prefixes?: Record<string, string>;
  contextual_hashes?: Record<string, string>;
}

export interface ContextualEmbedResult {
  nodeId: string;
  prefix: string;
  skipped: boolean;
  error?: string;
}

export interface BackfillResult {
  processed: number;
  skipped: number;
  errors: number;
}

export interface ContextualEmbedStats {
  memoryFileCount: number;
  contextualEmbeddingCount: number;
  contextualPrefixCount: number;
  coveragePercent: number;
}

type InferenceFn = (opts: {
  systemPrompt: string;
  userPrompt: string;
  level: "fast" | "standard" | "smart";
}) => Promise<InferenceResult>;

type EmbedBatchFn = (texts: string[], apiKey: string, model: string) => Promise<number[][]>;

// ── Frontmatter stripping ──

function stripFrontmatter(content: string): string {
  const match = content.match(/^---[\s\S]*?---\n([\s\S]*)$/);
  if (match) return match[1].trim();
  return content.trim();
}

function md5(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

// ── Prefix generation ──

const PREFIX_SYSTEM_PROMPT =
  "You generate a 1-sentence context prefix for a memory/rule entry. " +
  "Output only the prefix string. Format: [Category: X] [Topic: Y] where X is one of: " +
  "feedback, success, user, project, reference, and Y is a 2-5 word topic.";

export async function generatePrefix(
  filename: string,
  bodyText: string,
  infer: InferenceFn = inference,
): Promise<string | null> {
  const preview = bodyText.slice(0, 500);
  const userPrompt = `${filename}\n\n${preview}`;

  try {
    const result = await infer({
      systemPrompt: PREFIX_SYSTEM_PROMPT,
      userPrompt,
      level: "fast",
    });

    if (!result.success || !result.output) return null;
    return result.output.trim();
  } catch {
    return null;
  }
}

// ── Voyage API ──

async function voyageEmbedBatch(
  texts: string[],
  apiKey: string,
  model: string,
): Promise<number[][]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input: texts }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Voyage API error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return data.data.map((d) => d.embedding);
}

// ── Process a single file ──

export async function processFile(
  filePath: string,
  cache: ContextualEmbedCache,
  apiKey: string,
  opts?: {
    dryRun?: boolean;
    infer?: InferenceFn;
    embedBatch?: EmbedBatchFn;
    model?: string;
  },
): Promise<ContextualEmbedResult> {
  const nodeId = filePath.split("/").pop()!.replace(/\.md$/, "");
  const infer = opts?.infer ?? inference;
  const embed = opts?.embedBatch ?? voyageEmbedBatch;
  const model = opts?.model ?? DEFAULT_MODEL;

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return { nodeId, prefix: "", skipped: true, error: "Could not read file" };
  }

  const body = stripFrontmatter(content);
  const hash = md5(body);

  const existingHash = cache.contextual_hashes?.[nodeId];
  const hasEmbedding = !!cache.contextual_embeddings?.[nodeId];
  if (hasEmbedding && existingHash === hash) {
    return { nodeId, prefix: cache.contextual_prefixes?.[nodeId] ?? "", skipped: true };
  }

  const prefix = await generatePrefix(nodeId + ".md", body, infer);
  if (!prefix) {
    return { nodeId, prefix: "", skipped: true, error: "Prefix generation failed" };
  }

  if (opts?.dryRun) {
    return { nodeId, prefix, skipped: false };
  }

  const textToEmbed = prefix + "\n" + body;
  const vectors = await embed([textToEmbed], apiKey, model);
  const vector = vectors[0];

  cache.contextual_embeddings = cache.contextual_embeddings ?? {};
  cache.contextual_prefixes = cache.contextual_prefixes ?? {};
  cache.contextual_hashes = cache.contextual_hashes ?? {};

  cache.contextual_embeddings[nodeId] = vector;
  cache.contextual_prefixes[nodeId] = prefix;
  cache.contextual_hashes[nodeId] = hash;

  return { nodeId, prefix, skipped: false };
}

// ── Backfill all files in a directory ──

export async function backfill(
  memoryDir: string,
  cachePath: string,
  apiKey: string,
  opts?: {
    dryRun?: boolean;
    infer?: InferenceFn;
    embedBatch?: EmbedBatchFn;
    model?: string;
  },
): Promise<BackfillResult> {
  const model = opts?.model ?? DEFAULT_MODEL;
  const infer = opts?.infer ?? inference;
  const embed = opts?.embedBatch ?? voyageEmbedBatch;

  let cache: ContextualEmbedCache = {};
  try {
    if (existsSync(cachePath)) {
      cache = JSON.parse(readFileSync(cachePath, "utf-8")) as ContextualEmbedCache;
    }
  } catch { /* start fresh */ }

  const files = readdirSync(memoryDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(memoryDir, f));

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);

    for (const filePath of batch) {
      const result = await processFile(filePath, cache, apiKey, {
        dryRun: opts?.dryRun,
        infer,
        embedBatch: embed,
        model,
      });

      if (result.error) {
        errors++;
      } else if (result.skipped) {
        skipped++;
      } else {
        processed++;
      }
    }

    if (!opts?.dryRun && processed > 0) {
      writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf-8");
    }

    if (i + BATCH_SIZE < files.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  if (!opts?.dryRun && processed > 0) {
    writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf-8");
  }

  return { processed, skipped, errors };
}

// ── Stats ──

export function getStats(
  memoryDir: string,
  cachePath: string,
): ContextualEmbedStats {
  let memoryFileCount = 0;
  try {
    memoryFileCount = readdirSync(memoryDir).filter((f) => f.endsWith(".md")).length;
  } catch { /* dir missing */ }

  let cache: ContextualEmbedCache = {};
  try {
    if (existsSync(cachePath)) {
      cache = JSON.parse(readFileSync(cachePath, "utf-8")) as ContextualEmbedCache;
    }
  } catch { /* no cache */ }

  const contextualEmbeddingCount = Object.keys(cache.contextual_embeddings ?? {}).length;
  const contextualPrefixCount = Object.keys(cache.contextual_prefixes ?? {}).length;
  const coveragePercent = memoryFileCount > 0
    ? Math.round((contextualEmbeddingCount / memoryFileCount) * 100)
    : 0;

  return {
    memoryFileCount,
    contextualEmbeddingCount,
    contextualPrefixCount,
    coveragePercent,
  };
}
