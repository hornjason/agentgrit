import { Tier, type Rule } from "../adapters/types";
import type { EmbedConfig, Embedding } from "./types";

const DEFAULT_MODEL = "voyage-3-lite";
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_MAX_EDGES = 8;
const DEFAULT_SIMILARITY_FLOOR = 0.60;
const DEFAULT_DUPLICATE_THRESHOLD = 0.92;

const SIMILARITY_TIERS = [
  { min: 0.75, strength: 1.0 },
  { min: 0.65, strength: 0.6 },
  { min: 0.60, strength: 0.3 },
];

function getTierStrength(sim: number): number | null {
  for (const tier of SIMILARITY_TIERS) {
    if (sim >= tier.min) return tier.strength;
  }
  return null;
}

// ── Cosine Similarity ──

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Voyage API ──

async function embedBatch(texts: string[], apiKey: string, model: string): Promise<number[][]> {
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
  return data.data.map(d => d.embedding);
}

// ── Embed Rules ──

export async function embedRules(
  rules: Rule[],
  config?: EmbedConfig,
): Promise<Embedding[]> {
  const apiKey = config?.apiKey;
  if (!apiKey) throw new Error("embedRules requires an API key in config.apiKey");

  const model = config?.model || DEFAULT_MODEL;
  const batchSize = config?.batchSize || DEFAULT_BATCH_SIZE;

  const texts = rules.map(r => `${r.id}\n${r.text}`.slice(0, 4000));
  const embeddings: Embedding[] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const vectors = await embedBatch(batch, apiKey, model);

    for (let j = 0; j < vectors.length; j++) {
      embeddings.push({
        id: rules[i + j].id,
        vector: vectors[j],
      });
    }
  }

  return embeddings;
}

// ── Semantic Search ──

export function semanticSearch(
  query: string,
  embeddings: Embedding[],
  limit: number = 10,
  queryEmbedding?: number[],
): Rule[] {
  if (!queryEmbedding || embeddings.length === 0) return [];

  const scored = embeddings.map(emb => ({
    id: emb.id,
    similarity: cosine(queryEmbedding, emb.vector),
  }));

  scored.sort((a, b) => b.similarity - a.similarity);

  return scored
    .slice(0, limit)
    .filter(s => s.similarity > DEFAULT_SIMILARITY_FLOOR)
    .map(s => ({
      id: s.id,
      text: "",
      tier: Tier.Graph,
      tags: [],
      created: "",
      correlationScore: s.similarity,
      sourceSignals: [],
      schemaVersion: 1,
    }));
}

// ── Find Embedding Edges ──

export function findEmbeddingEdges(
  embeddings: Embedding[],
  config?: Pick<EmbedConfig, "maxEdgesPerNode" | "similarityFloor">,
): Array<{ from: string; to: string; strength: number }> {
  const maxEdges = config?.maxEdgesPerNode ?? DEFAULT_MAX_EDGES;
  const floor = config?.similarityFloor ?? DEFAULT_SIMILARITY_FLOOR;
  const edges: Array<{ from: string; to: string; strength: number }> = [];
  const seen = new Set<string>();

  for (let i = 0; i < embeddings.length; i++) {
    const candidates: Array<{ id: string; sim: number }> = [];

    for (let j = 0; j < embeddings.length; j++) {
      if (i === j) continue;
      const sim = cosine(embeddings[i].vector, embeddings[j].vector);
      if (sim >= floor) candidates.push({ id: embeddings[j].id, sim });
    }

    candidates.sort((a, b) => b.sim - a.sim);

    for (const neighbor of candidates.slice(0, maxEdges)) {
      const pairKey = [embeddings[i].id, neighbor.id].sort().join("::");
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      const strength = getTierStrength(neighbor.sim);
      if (strength !== null) {
        edges.push({
          from: embeddings[i].id,
          to: neighbor.id,
          strength,
        });
      }
    }
  }

  return edges;
}

// ── Near-Duplicate Detection (from MemoryConsolidator) ──

export interface DuplicateCluster {
  nodes: string[];
  maxSimilarity: number;
  pairs: Array<{ a: string; b: string; similarity: number }>;
}

export function findNearDuplicates(
  embeddings: Embedding[],
  threshold: number = DEFAULT_DUPLICATE_THRESHOLD,
): DuplicateCluster[] {
  const pairs: Array<{ a: string; b: string; similarity: number }> = [];

  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) {
      const sim = cosine(embeddings[i].vector, embeddings[j].vector);
      if (sim >= threshold) {
        pairs.push({ a: embeddings[i].id, b: embeddings[j].id, similarity: sim });
      }
    }
  }

  if (pairs.length === 0) return [];

  // Union-find clustering
  const parent = new Map<string, string>();
  function find(x: string): string {
    if (!parent.has(x)) parent.set(x, x);
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!));
    return parent.get(x)!;
  }
  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const p of pairs) {
    union(p.a, p.b);
  }

  // Group by root
  const groups = new Map<string, Set<string>>();
  const allNodes = new Set(pairs.flatMap((p) => [p.a, p.b]));
  for (const node of allNodes) {
    const root = find(node);
    if (!groups.has(root)) groups.set(root, new Set());
    groups.get(root)!.add(node);
  }

  return [...groups.values()].map((nodes) => {
    const nodeArr = [...nodes];
    const clusterPairs = pairs.filter((p) => nodes.has(p.a) && nodes.has(p.b));
    const maxSimilarity = Math.max(...clusterPairs.map((p) => p.similarity));
    return { nodes: nodeArr, maxSimilarity, pairs: clusterPairs };
  });
}

// ── Memory Classification (from MemoryTagger) ──

export type MemoryType = "episodic" | "procedural" | "semantic";

const MEMORY_TYPE_PATTERNS: Record<MemoryType, RegExp[]> = {
  episodic: [
    /\bfound\b/i, /\bdiscovered\b/i, /\boccurred\b/i, /\bhappened\b/i,
    /\bconfirmed\b/i, /\bbroke\b/i, /\bfailed\b/i, /\bincident\b/i,
    /\bsession\b.*\b(revealed|showed|exposed)\b/i,
  ],
  procedural: [
    /\balways\b/i, /\bnever\b/i, /\bmust\b/i, /\bstep\s*\d/i,
    /\bworkflow\b/i, /\bprocess\b/i, /\bsequence\b/i, /\bbefore\b.*\bafter\b/i,
    /\bfirst\b.*\bthen\b/i, /\bpipeline\b/i,
  ],
  semantic: [
    /\buser\s+(is|prefers|uses|wants)\b/i, /\bproject\s+(uses|has|requires)\b/i,
    /\bsystem\s+(is|uses|has)\b/i, /\barchitecture\b/i, /\bpreference\b/i,
    /\bfact\b/i, /\bconfiguration\b/i,
  ],
};

export function classifyMemoryType(content: string): MemoryType {
  const scores: Record<MemoryType, number> = { episodic: 0, procedural: 0, semantic: 0 };

  for (const [type, patterns] of Object.entries(MEMORY_TYPE_PATTERNS) as Array<[MemoryType, RegExp[]]>) {
    for (const pattern of patterns) {
      if (pattern.test(content)) scores[type]++;
    }
  }

  let best: MemoryType = "semantic";
  let bestScore = 0;
  for (const [type, score] of Object.entries(scores) as Array<[MemoryType, number]>) {
    if (score > bestScore) {
      best = type;
      bestScore = score;
    }
  }

  return best;
}
