export type {
  Graph,
  RankedCluster,
  ConnectedNode,
  BM25Index,
  DocEntry,
  VocabEntry,
  SearchResult,
  RetrievalResult,
  EmbedConfig,
  Embedding,
} from "./types";

export { buildGraph, updateGraph, readGraph, writeGraphFile, pruneStaleNodes, keywordClassify, resetClassifyPatterns, parseFrontmatter, inferSeverity, loadRuleDomains, defaultRuleDomainsPath } from "./builder";
export { queryGraph } from "./query";
export { buildIndex, buildIndexFromDir, searchIndex, tokenize } from "./bm25";
export { hybridRetrieve } from "./retrieval";
export { embedRules, semanticSearch, cosine, findEmbeddingEdges } from "./embedder";
export { getContextRules, detectDomains, initHybridDetection, resetDetectPatterns, parseLearnedRules, filterLearnedRules } from "./context";
export { generatePatterns, loadPatterns, loadSeedPatterns, loadCachedPatterns, writeCachedPatterns, loadHybridPatterns } from "./generate-patterns";
export type { DomainPattern, CachedPatterns } from "./generate-patterns";
