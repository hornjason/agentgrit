import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import type { BM25Index, DocEntry, SearchResult, VocabEntry } from "./types";

const K1 = 1.5;
const B = 0.75;

// ── Text Processing ──

function stripFrontmatter(content: string): string {
  return content.replace(/^---[\s\S]*?---\n?/, "");
}

function stripMarkdown(text: string): string {
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/\*([^*]+)\*/g, "$1");
  text = text.replace(/`[^`]+`/g, " ");
  text = text.replace(/```[\s\S]*?```/g, " ");
  return text;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= 2);
}

function countTerms(tokens: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of tokens) {
    counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
}

// ── Build Index ──

export function buildIndex(files: string[]): BM25Index {
  const docs: DocEntry[] = [];

  for (const file of files) {
    if (!existsSync(file)) continue;
    const raw = readFileSync(file, "utf-8");
    const body = stripMarkdown(stripFrontmatter(raw));
    const tokens = tokenize(body);
    const id = file.split("/").pop()!.replace(/\.md$/, "");

    docs.push({
      id,
      tokens: countTerms(tokens),
      len: tokens.length,
    });
  }

  const N = docs.length;
  const avgDocLen = N > 0
    ? docs.reduce((sum, d) => sum + d.len, 0) / N
    : 0;

  // Compute document frequency per term
  const df: Record<string, number> = {};
  for (const doc of docs) {
    for (const term of Object.keys(doc.tokens)) {
      df[term] = (df[term] || 0) + 1;
    }
  }

  // Compute IDF (smooth variant)
  const vocabulary: Record<string, VocabEntry> = {};
  for (const [term, dfVal] of Object.entries(df)) {
    const idf = Math.log((N - dfVal + 0.5) / (dfVal + 0.5) + 1);
    vocabulary[term] = { idf, df: dfVal };
  }

  return {
    builtAt: new Date().toISOString(),
    docCount: N,
    avgDocLen,
    vocabulary,
    docs,
  };
}

// ── Build from directory ──

export function buildIndexFromDir(dir: string): BM25Index {
  if (!existsSync(dir)) return buildIndex([]);
  const files = readdirSync(dir)
    .filter(f => f.endsWith(".md"))
    .map(f => join(dir, f));
  return buildIndex(files);
}

// ── Score a single document ──

function scoreDoc(
  doc: DocEntry,
  queryTerms: string[],
  vocabulary: Record<string, VocabEntry>,
  avgDocLen: number,
): number {
  let score = 0;
  for (const term of queryTerms) {
    const vocab = vocabulary[term];
    if (!vocab) continue;
    const tf = doc.tokens[term] || 0;
    if (tf === 0) continue;
    const idf = vocab.idf;
    const tfNorm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (doc.len / avgDocLen)));
    score += idf * tfNorm;
  }
  return score;
}

// ── Search ──

export function searchIndex(
  index: BM25Index,
  query: string,
  limit: number = 15,
): SearchResult[] {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  const scored: SearchResult[] = index.docs.map(doc => ({
    id: doc.id,
    score: scoreDoc(doc, queryTerms, index.vocabulary, index.avgDocLen),
  }));

  return scored
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
