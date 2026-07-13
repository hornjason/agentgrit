import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { cosine } from "./embedder";
import type { Graph, VectorCache } from "./types";
import type { EmbeddingProvider } from "../adapters/types";

// ── Vector Cache I/O ──

export function loadVectorCache(path: string): Map<string, number[]> | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as VectorCache;
    if (!raw.vectors || typeof raw.vectors !== "object") return null;
    return new Map(Object.entries(raw.vectors));
  } catch {
    return null;
  }
}

export function saveVectorCache(
  vectors: Map<string, number[]>,
  model: string,
  dimensions: number,
  outputPath: string,
): void {
  const dir = dirname(outputPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const cache: VectorCache = {
    model,
    dimensions,
    builtAt: new Date().toISOString(),
    vectors: Object.fromEntries(vectors),
  };
  writeFileSync(outputPath, JSON.stringify(cache), "utf-8");
}

// ── Vector Ranking ──

export function rankByVectorSimilarity(
  queryVector: number[],
  cache: Map<string, number[]>,
  limit: number,
): Array<{ id: string; score: number }> {
  const scored: Array<{ id: string; score: number }> = [];

  for (const [id, vector] of cache) {
    scored.push({ id, score: cosine(queryVector, vector) });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ── Centroid from BM25 hits ──

export function computeCentroid(
  hitIds: string[],
  cache: Map<string, number[]>,
): number[] | null {
  const vectors: number[][] = [];
  for (const id of hitIds) {
    const v = cache.get(id);
    if (v) vectors.push(v);
  }
  if (vectors.length === 0) return null;

  const dim = vectors[0].length;
  const centroid = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) {
      centroid[i] += v[i];
    }
  }
  for (let i = 0; i < dim; i++) {
    centroid[i] /= vectors.length;
  }
  return centroid;
}

// ── Local Embedding Provider ──

export class LocalEmbeddingProvider implements EmbeddingProvider {
  private model: string;
  private extractor: any | null = null;

  constructor(model: string = "Xenova/all-MiniLM-L6-v2") {
    this.model = model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.extractor) {
      // Dynamic import — only fails if actually called without transformers.js installed
      const mod = await import(/* webpackIgnore: true */ "@huggingface/transformers" as string);
      this.extractor = await mod.pipeline("feature-extraction", this.model, { dtype: "fp32" });
    }
    const output = await this.extractor(texts, { pooling: "mean", normalize: true });
    return output.tolist() as number[][];
  }
}

// ── Compute and Save Cache ──

export async function computeAndSaveCache(
  graph: Graph,
  provider: EmbeddingProvider,
  outputPath: string,
  batchSize: number = 20,
): Promise<void> {
  const ids = Object.keys(graph.nodes);
  if (ids.length === 0) return;

  const vectors = new Map<string, number[]>();
  let dimensions = 0;

  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const texts = batch.map(id => {
      const node = graph.nodes[id];
      return `${node.name}\n${node.description}`.slice(0, 4000);
    });

    const embeddings = await provider.embed(texts);
    if (dimensions === 0 && embeddings.length > 0) {
      dimensions = embeddings[0].length;
    }

    for (let j = 0; j < batch.length; j++) {
      vectors.set(batch[j], embeddings[j]);
    }
  }

  saveVectorCache(vectors, "local", dimensions, outputPath);
}
