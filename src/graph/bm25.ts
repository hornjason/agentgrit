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

// ── BM25 Diagnostic ──

export interface BM25Diagnostic {
  corpusSize: number;
  avgDocLen: number;
  vocabularySize: number;
  queryTerms: string[];
  queryTermsInVocab: string[];
  queryTermsMissing: string[];
  idfStats: { min: number; max: number; mean: number; stddev: number };
  topScores: Array<{ id: string; score: number }>;
  rootCause: "short-query" | "flat-idf" | "missing-terms" | "low-variance" | "empty-corpus" | "healthy";
  rootCauseEvidence: string;
}

export function diagnoseBM25(index: BM25Index, query: string): BM25Diagnostic {
  const queryTerms = tokenize(query);

  const idfValues = Object.values(index.vocabulary).map(v => v.idf);
  const idfMin = idfValues.length > 0 ? Math.min(...idfValues) : 0;
  const idfMax = idfValues.length > 0 ? Math.max(...idfValues) : 0;
  const idfMean = idfValues.length > 0
    ? idfValues.reduce((a, b) => a + b, 0) / idfValues.length
    : 0;
  const idfVariance = idfValues.length > 0
    ? idfValues.reduce((sum, v) => sum + (v - idfMean) ** 2, 0) / idfValues.length
    : 0;
  const idfStddev = Math.sqrt(idfVariance);

  const inVocab = queryTerms.filter(t => t in index.vocabulary);
  const missing = queryTerms.filter(t => !(t in index.vocabulary));

  const scores = index.docs.map(doc => ({
    id: doc.id,
    score: scoreDoc(doc, queryTerms, index.vocabulary, index.avgDocLen),
  }));
  const topScores = scores
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  let rootCause: BM25Diagnostic["rootCause"];
  let rootCauseEvidence: string;

  if (index.docCount === 0) {
    rootCause = "empty-corpus";
    rootCauseEvidence = "Index contains 0 documents";
  } else if (queryTerms.length < 2) {
    rootCause = "short-query";
    rootCauseEvidence = `Query has ${queryTerms.length} term(s): [${queryTerms.join(", ")}]`;
  } else if (missing.length > queryTerms.length / 2) {
    rootCause = "missing-terms";
    rootCauseEvidence = `${missing.length}/${queryTerms.length} query terms not in vocabulary: [${missing.join(", ")}]`;
  } else if (idfStddev < 0.5) {
    rootCause = "flat-idf";
    rootCauseEvidence = `IDF stddev=${idfStddev.toFixed(4)} (< 0.5 threshold). All terms have similar rarity`;
  } else if (topScores.length >= 2) {
    const scoreVals = topScores.map(s => s.score);
    const scoreMean = scoreVals.reduce((a, b) => a + b, 0) / scoreVals.length;
    const scoreVar = scoreVals.reduce((sum, v) => sum + (v - scoreMean) ** 2, 0) / scoreVals.length;
    const scoreStddev = Math.sqrt(scoreVar);
    if (scoreStddev < 0.01) {
      rootCause = "low-variance";
      rootCauseEvidence = `Top ${topScores.length} scores have stddev=${scoreStddev.toFixed(6)} (< 0.01 threshold)`;
    } else {
      rootCause = "healthy";
      rootCauseEvidence = `Score variance=${scoreStddev.toFixed(4)}, IDF stddev=${idfStddev.toFixed(4)}, ${inVocab.length}/${queryTerms.length} terms matched`;
    }
  } else {
    rootCause = "healthy";
    rootCauseEvidence = `IDF stddev=${idfStddev.toFixed(4)}, ${inVocab.length}/${queryTerms.length} terms matched`;
  }

  return {
    corpusSize: index.docCount,
    avgDocLen: index.avgDocLen,
    vocabularySize: Object.keys(index.vocabulary).length,
    queryTerms,
    queryTermsInVocab: inVocab,
    queryTermsMissing: missing,
    idfStats: { min: idfMin, max: idfMax, mean: idfMean, stddev: idfStddev },
    topScores,
    rootCause,
    rootCauseEvidence,
  };
}
