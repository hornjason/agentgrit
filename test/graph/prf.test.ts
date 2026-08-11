import { describe, it, expect } from "bun:test";
import { expandQueryByPRF } from "../../src/graph/prf";
import { buildIndex, tokenize } from "../../src/graph/bm25";
import type { BM25Index } from "../../src/graph/types";

function makeIndex(docs: Array<{ id: string; text: string }>): BM25Index {
  const entries = docs.map(d => {
    const tokens = tokenize(d.text);
    const counts: Record<string, number> = {};
    for (const t of tokens) counts[t] = (counts[t] || 0) + 1;
    return { id: d.id, tokens: counts, len: tokens.length };
  });
  const N = entries.length;
  const avgDocLen = N > 0 ? entries.reduce((s, e) => s + e.len, 0) / N : 0;
  const df: Record<string, number> = {};
  for (const doc of entries) {
    for (const term of Object.keys(doc.tokens)) {
      df[term] = (df[term] || 0) + 1;
    }
  }
  const vocabulary: Record<string, { idf: number; df: number }> = {};
  for (const [term, dfVal] of Object.entries(df)) {
    vocabulary[term] = {
      idf: Math.log((N - dfVal + 0.5) / (dfVal + 0.5) + 1),
      df: dfVal,
    };
  }
  return { builtAt: new Date().toISOString(), docCount: N, avgDocLen, vocabulary, docs: entries };
}

describe("expandQueryByPRF", () => {
  it("returns expanded terms not in the original query", () => {
    const index = makeIndex([
      { id: "doc1", text: "signal capture drops ratings when file exceeds limit threshold overflow" },
      { id: "doc2", text: "signal capture pipeline handles ratings overflow gracefully with retry" },
      { id: "doc3", text: "domain detection uses pattern matching for keyword extraction" },
      { id: "doc4", text: "graph builder constructs edges between related nodes" },
      { id: "doc5", text: "BM25 scoring algorithm computes term frequency inverse document frequency" },
    ]);

    const result = expandQueryByPRF("signal capture", index, 5, 10);

    expect(result.originalTerms).toEqual(["signal", "capture"]);
    expect(result.expandedTerms.length).toBeGreaterThan(0);
    for (const term of result.expandedTerms) {
      expect(["signal", "capture"]).not.toContain(term);
    }
    expect(result.combinedQuery).toContain("signal");
    expect(result.combinedQuery).toContain("capture");
    for (const term of result.expandedTerms) {
      expect(result.combinedQuery).toContain(term);
    }
  });

  it("returns at least 3 expansion terms for SC-2", () => {
    const index = makeIndex([
      { id: "doc1", text: "path duplication signal directory causes duplicate entries in index" },
      { id: "doc2", text: "signal directory path resolution fails when duplicate paths detected" },
      { id: "doc3", text: "fix path normalization prevents duplicate signal file entries" },
      { id: "doc4", text: "graph domain propagation unrelated topic about other things" },
      { id: "doc5", text: "deployment container setup with docker and kubernetes" },
    ]);

    const result = expandQueryByPRF("fix path duplication", index, 5, 10);
    expect(result.expandedTerms.length).toBeGreaterThanOrEqual(3);
  });

  it("handles empty index gracefully", () => {
    const index = makeIndex([]);
    const result = expandQueryByPRF("test query", index, 5, 10);

    expect(result.expandedTerms).toEqual([]);
    expect(result.originalTerms).toEqual(["test", "query"]);
    expect(result.combinedQuery).toBe("test query");
  });

  it("handles query with no BM25 hits", () => {
    const index = makeIndex([
      { id: "doc1", text: "completely unrelated content about cooking recipes" },
    ]);

    const result = expandQueryByPRF("quantum physics", index, 5, 10);
    expect(result.expandedTerms).toEqual([]);
    expect(result.combinedQuery).toBe("quantum physics");
  });

  it("respects expansionTerms limit", () => {
    const index = makeIndex([
      { id: "doc1", text: "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu" },
      { id: "doc2", text: "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu" },
      { id: "doc3", text: "alpha omega sigma tau upsilon phi chi psi rho xi" },
    ]);

    const result = expandQueryByPRF("alpha", index, 5, 3);
    expect(result.expandedTerms.length).toBeLessThanOrEqual(3);
  });

  it("picks discriminative terms (high TF in top-K, high IDF globally)", () => {
    const index = makeIndex([
      { id: "doc1", text: "retrieval scoring algorithm precision recall metrics evaluation" },
      { id: "doc2", text: "retrieval algorithm optimization benchmark precision recall" },
      { id: "doc3", text: "the and is of for with from this that are" },
      { id: "doc4", text: "deployment container setup infrastructure docker" },
      { id: "doc5", text: "testing validation framework assertion coverage metrics" },
    ]);

    const result = expandQueryByPRF("retrieval algorithm", index, 5, 5);
    expect(result.expandedTerms.length).toBeGreaterThan(0);
    // Terms like "precision", "recall", "scoring" should appear — discriminative for the top-K docs
    const expanded = new Set(result.expandedTerms);
    const atLeastOneRelevant = expanded.has("precision") || expanded.has("recall") || expanded.has("scoring") || expanded.has("metrics");
    expect(atLeastOneRelevant).toBe(true);
  });

  it("does not modify BM25 index (SC-A1)", () => {
    const index = makeIndex([
      { id: "doc1", text: "signal capture drops ratings" },
      { id: "doc2", text: "signal processing pipeline" },
    ]);

    const docsBefore = JSON.stringify(index.docs);
    const vocabBefore = JSON.stringify(index.vocabulary);

    expandQueryByPRF("signal", index, 5, 10);

    expect(JSON.stringify(index.docs)).toBe(docsBefore);
    expect(JSON.stringify(index.vocabulary)).toBe(vocabBefore);
  });
});
