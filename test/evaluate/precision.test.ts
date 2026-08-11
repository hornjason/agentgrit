import { describe, expect, it } from "bun:test";
import { computePrecisionAtK } from "../../src/evaluate/precision";
import { diagnoseBM25 } from "../../src/graph/bm25";
import type { BM25Index } from "../../src/graph/types";

describe("computePrecisionAtK", () => {
  it("returns correct precision for partial overlap", () => {
    const retrieved = ["A", "B", "C", "D", "E"];
    const expected = ["A", "C", "F"];
    expect(computePrecisionAtK(retrieved, expected, 5)).toBeCloseTo(0.4, 5);
  });

  it("returns 1.0 for perfect retrieval", () => {
    const retrieved = ["A", "B", "C"];
    const expected = ["A", "B", "C"];
    expect(computePrecisionAtK(retrieved, expected, 3)).toBeCloseTo(1.0, 5);
  });

  it("returns 0.0 for no overlap", () => {
    const retrieved = ["A", "B", "C"];
    const expected = ["D", "E", "F"];
    expect(computePrecisionAtK(retrieved, expected, 3)).toBeCloseTo(0.0, 5);
  });

  it("handles k larger than retrieved", () => {
    const retrieved = ["A", "B"];
    const expected = ["A", "B", "C"];
    expect(computePrecisionAtK(retrieved, expected, 5)).toBeCloseTo(1.0, 5);
  });

  it("handles empty retrieved", () => {
    expect(computePrecisionAtK([], ["A", "B"], 5)).toBe(0);
  });

  it("handles empty expected", () => {
    expect(computePrecisionAtK(["A", "B"], [], 5)).toBeCloseTo(0.0, 5);
  });

  it("truncates retrieved to k", () => {
    const retrieved = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
    const expected = ["A", "B"];
    expect(computePrecisionAtK(retrieved, expected, 5)).toBeCloseTo(0.4, 5);
  });
});

describe("diagnoseBM25", () => {
  function makeEmptyIndex(): BM25Index {
    return {
      builtAt: new Date().toISOString(),
      docCount: 0,
      avgDocLen: 0,
      vocabulary: {},
      docs: [],
    };
  }

  function makeHealthyIndex(): BM25Index {
    return {
      builtAt: new Date().toISOString(),
      docCount: 5,
      avgDocLen: 20,
      vocabulary: {
        fix: { idf: 1.5, df: 2 },
        deploy: { idf: 2.1, df: 1 },
        docker: { idf: 2.5, df: 1 },
        container: { idf: 2.3, df: 1 },
        test: { idf: 0.8, df: 3 },
      },
      docs: [
        { id: "doc1", tokens: { fix: 2, deploy: 1, test: 1 }, len: 25 },
        { id: "doc2", tokens: { docker: 3, container: 2 }, len: 30 },
        { id: "doc3", tokens: { test: 2, fix: 1 }, len: 15 },
        { id: "doc4", tokens: { deploy: 1, container: 1, test: 1 }, len: 20 },
        { id: "doc5", tokens: { fix: 1, docker: 1, deploy: 2 }, len: 10 },
      ],
    };
  }

  it("diagnoses empty corpus", () => {
    const result = diagnoseBM25(makeEmptyIndex(), "fix deploy");
    expect(result.rootCause).toBe("empty-corpus");
    expect(result.corpusSize).toBe(0);
  });

  it("diagnoses short query", () => {
    const index = makeHealthyIndex();
    const result = diagnoseBM25(index, "fix");
    expect(result.rootCause).toBe("short-query");
    expect(result.queryTerms.length).toBe(1);
  });

  it("diagnoses missing terms", () => {
    const index = makeHealthyIndex();
    const result = diagnoseBM25(index, "kubernetes helm ingress");
    expect(result.rootCause).toBe("missing-terms");
    expect(result.queryTermsMissing.length).toBe(3);
  });

  it("reports healthy for good corpus and query", () => {
    const index = makeHealthyIndex();
    const result = diagnoseBM25(index, "fix deploy docker");
    expect(result.rootCause).toBe("healthy");
    expect(result.queryTermsInVocab).toContain("fix");
    expect(result.queryTermsInVocab).toContain("deploy");
    expect(result.queryTermsInVocab).toContain("docker");
  });

  it("computes correct IDF stats", () => {
    const index = makeHealthyIndex();
    const result = diagnoseBM25(index, "fix deploy docker");
    expect(result.idfStats.min).toBeCloseTo(0.8, 1);
    expect(result.idfStats.max).toBeCloseTo(2.5, 1);
    expect(result.idfStats.mean).toBeGreaterThan(0);
    expect(result.idfStats.stddev).toBeGreaterThan(0);
  });

  it("returns corpus stats", () => {
    const index = makeHealthyIndex();
    const result = diagnoseBM25(index, "fix deploy");
    expect(result.corpusSize).toBe(5);
    expect(result.avgDocLen).toBe(20);
    expect(result.vocabularySize).toBe(5);
  });

  it("returns top scores sorted descending", () => {
    const index = makeHealthyIndex();
    const result = diagnoseBM25(index, "fix deploy docker");
    expect(result.topScores.length).toBeGreaterThan(0);
    for (let i = 1; i < result.topScores.length; i++) {
      expect(result.topScores[i - 1].score).toBeGreaterThanOrEqual(result.topScores[i].score);
    }
  });
});
