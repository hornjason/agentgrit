import type { BM25Index } from "./types";
import { tokenize, searchIndex } from "./bm25";

export interface PRFResult {
  expandedTerms: string[];
  originalTerms: string[];
  combinedQuery: string;
}

export function expandQueryByPRF(
  originalQuery: string,
  index: BM25Index,
  topK: number = 5,
  expansionTerms: number = 10,
): PRFResult {
  const originalTerms = tokenize(originalQuery);
  const originalSet = new Set(originalTerms);

  if (index.docCount === 0) {
    return { expandedTerms: [], originalTerms, combinedQuery: originalQuery };
  }

  const hits = searchIndex(index, originalQuery, topK);
  if (hits.length === 0) {
    return { expandedTerms: [], originalTerms, combinedQuery: originalQuery };
  }

  const hitIds = new Set(hits.map(h => h.id));
  const hitDocs = index.docs.filter(d => hitIds.has(d.id));

  // Compute TF-IDF score for each term across the top-K docs
  const termScores = new Map<string, number>();
  for (const doc of hitDocs) {
    for (const [term, tf] of Object.entries(doc.tokens)) {
      if (originalSet.has(term)) continue;
      const vocab = index.vocabulary[term];
      if (!vocab) continue;
      const tfidf = tf * vocab.idf;
      termScores.set(term, (termScores.get(term) || 0) + tfidf);
    }
  }

  const ranked = Array.from(termScores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, expansionTerms)
    .map(([term]) => term);

  const combinedQuery = [...originalTerms, ...ranked].join(" ");

  return { expandedTerms: ranked, originalTerms, combinedQuery };
}
