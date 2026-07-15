import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { stateDir } from "../adapters/paths";
import type { Graph } from "./types";
import { tokenize } from "./bm25";
import { DOMAINS } from "./builder";
import seedData from "./domain-seeds.json";

export interface DomainPattern {
  domain: string;
  terms: string[];
  pattern: string;
  cascadePattern?: string;
  negativePattern?: string;
  priority: number;
}

export interface CachedPatterns {
  generatedAt: string;
  patterns: DomainPattern[];
}

const CACHE_FILENAME = "domain-patterns.json";

const STOP_WORDS = new Set([
  "the", "it", "is", "are", "no", "go", "an", "in", "on", "at", "to", "of",
  "or", "if", "so", "as", "by", "up", "we", "do", "be", "he", "me", "my",
  "us", "am", "has", "had", "was", "but", "not", "all", "can", "her", "his",
  "our", "its", "who", "how", "may", "did", "get", "let", "say", "see",
  "use", "way", "own", "set", "run", "put", "old", "new", "try", "ask",
  "end", "far", "low", "big", "few", "got", "out", "any", "two", "one",
  "day", "off", "man", "too", "yet", "now", "ago", "nor", "per", "via",
  "non", "for", "and", "with", "that", "this", "from", "they", "been",
  "have", "were", "will", "been", "each", "than", "them", "then", "what",
  "when", "your", "also", "into", "just", "more", "most", "only", "some",
  "such", "very", "would", "could", "should", "about", "after", "before",
  "other", "which", "there", "these", "those", "where", "every", "first",
  "rule", "rule-", "related", "content", "terms",
]);

const MIN_TERM_LENGTH = 3;

function cachePath(): string {
  return join(stateDir(), CACHE_FILENAME);
}

export function loadSeedPatterns(): DomainPattern[] {
  return seedData.patterns as DomainPattern[];
}

export function loadCachedPatterns(): DomainPattern[] | null {
  const path = cachePath();
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as CachedPatterns;
    if (!data.patterns || !Array.isArray(data.patterns)) return null;
    return data.patterns;
  } catch {
    return null;
  }
}

export function writeCachedPatterns(patterns: DomainPattern[]): string {
  const path = cachePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const data: CachedPatterns = {
    generatedAt: new Date().toISOString(),
    patterns,
  };
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
  return path;
}

export function loadPatterns(): DomainPattern[] {
  return loadCachedPatterns() ?? loadSeedPatterns();
}

function extractBigrams(tokens: string[]): string[] {
  const bigrams: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    bigrams.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return bigrams;
}

interface DomainCorpusEntry {
  unigrams: string[];
  bigrams: string[];
}

function buildDomainCorpus(graph: Graph): Map<string, DomainCorpusEntry> {
  const corpus = new Map<string, DomainCorpusEntry>();
  for (const node of Object.values(graph.nodes)) {
    for (const domain of node.domains) {
      if (!(DOMAINS as readonly string[]).includes(domain)) continue;
      const entry = corpus.get(domain) ?? { unigrams: [], bigrams: [] };
      const text = `${node.name} ${node.description}`;
      const tokens = tokenize(text);
      entry.unigrams.push(...tokens);
      entry.bigrams.push(...extractBigrams(tokens));
      corpus.set(domain, entry);
    }
  }
  return corpus;
}

function computeGlobalDF(allTermsByDomain: Map<string, string[]>): Map<string, number> {
  const df = new Map<string, number>();
  for (const terms of allTermsByDomain.values()) {
    const unique = new Set(terms);
    for (const term of unique) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  return df;
}

function isStopWord(term: string): boolean {
  if (term.length < MIN_TERM_LENGTH) return true;
  if (STOP_WORDS.has(term)) return true;
  if (/^\d+$/.test(term)) return true;
  return false;
}

function buildSeedTermSet(): Set<string> {
  const seeds = loadSeedPatterns();
  const seedTerms = new Set<string>();
  for (const s of seeds) {
    for (const t of s.terms) {
      seedTerms.add(t.toLowerCase());
    }
  }
  return seedTerms;
}

function extractTopTerms(
  domainTerms: string[],
  globalDF: Map<string, number>,
  totalDomains: number,
  topK: number,
  seedTermSet: Set<string>,
  crossDomainExclusions: Set<string>,
): string[] {
  const highDFThreshold = Math.max(Math.floor(totalDomains * 10 / 14), 2);

  const tf = new Map<string, number>();
  for (const t of domainTerms) {
    if (isStopWord(t)) continue;
    if (crossDomainExclusions.has(t)) continue;
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }

  const scored: Array<{ term: string; score: number; isBigram: boolean }> = [];
  for (const [term, count] of tf) {
    const dfVal = globalDF.get(term) ?? 1;
    if (dfVal > highDFThreshold) continue;
    const idf = Math.log((totalDomains + 1) / (dfVal + 0.5));
    let score = count * idf;
    const isBigram = term.includes(" ");
    if (isBigram && seedTermSet.has(term)) score *= 2;
    scored.push({ term, score, isBigram });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map(s => s.term);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPatternFromTerms(terms: string[]): string {
  return terms.map(t => escapeRegex(t)).join("|");
}

function buildCascadePattern(terms: string[], seed?: DomainPattern): string {
  const bigrams = terms.filter(t => t.includes(" "));
  const unigrams = terms.filter(t => !t.includes(" "));
  const cascadeTerms: string[] = [];

  for (const b of bigrams) {
    cascadeTerms.push(escapeRegex(b));
  }
  for (const u of unigrams) {
    cascadeTerms.push(`\\b${escapeRegex(u)}\\b`);
  }

  if (cascadeTerms.length === 0 && seed?.cascadePattern) {
    return seed.cascadePattern;
  }

  return cascadeTerms.join("|");
}

function computeCrossDomainExclusions(
  allTermsByDomain: Map<string, string[]>,
  globalDF: Map<string, number>,
): Set<string> {
  const exclusions = new Set<string>();
  const domainCount = allTermsByDomain.size;
  if (domainCount < 3) return exclusions;

  for (const [term, df] of globalDF) {
    if (df < 3) continue;

    const freqs: number[] = [];
    for (const terms of allTermsByDomain.values()) {
      const count = terms.filter(t => t === term).length;
      freqs.push(count);
    }
    const nonZero = freqs.filter(f => f > 0);
    if (nonZero.length < 3) continue;

    const mean = nonZero.reduce((a, b) => a + b, 0) / nonZero.length;
    if (mean === 0) continue;
    const variance = nonZero.reduce((sum, f) => sum + (f - mean) ** 2, 0) / nonZero.length;
    const cv = Math.sqrt(variance) / mean;
    if (cv < 0.5) exclusions.add(term);
  }
  return exclusions;
}

export function generatePatterns(graph: Graph, minRulesPerDomain = 3): DomainPattern[] {
  const seeds = loadSeedPatterns();
  const seedMap = new Map(seeds.map(s => [s.domain, s]));
  const seedTermSet = buildSeedTermSet();

  const corpus = buildDomainCorpus(graph);

  const allTermsByDomain = new Map<string, string[]>();
  for (const [domain, entry] of corpus) {
    const combined = [
      ...entry.unigrams.filter(t => !isStopWord(t)),
      ...entry.bigrams.filter(b => !b.split(" ").every(w => isStopWord(w))),
    ];
    allTermsByDomain.set(domain, combined);
  }

  const globalDF = computeGlobalDF(allTermsByDomain);
  const totalDomains = allTermsByDomain.size;
  const crossDomainExclusions = computeCrossDomainExclusions(allTermsByDomain, globalDF);

  const patterns: DomainPattern[] = [];

  for (const domain of DOMAINS) {
    const seed = seedMap.get(domain);
    const domainEntry = corpus.get(domain);

    const nodeCount = [...Object.values(graph.nodes)].filter(
      n => n.domains.includes(domain),
    ).length;

    if (!domainEntry || nodeCount < minRulesPerDomain) {
      if (seed) {
        patterns.push({ ...seed });
      }
      continue;
    }

    const domainTerms = allTermsByDomain.get(domain) ?? [];
    const topTerms = extractTopTerms(domainTerms, globalDF, totalDomains, 15, seedTermSet, crossDomainExclusions);
    const patternStr = buildPatternFromTerms(topTerms);
    const cascadePatternStr = buildCascadePattern(topTerms, seed);

    patterns.push({
      domain,
      terms: topTerms,
      pattern: patternStr,
      cascadePattern: cascadePatternStr,
      negativePattern: seed?.negativePattern,
      priority: seed?.priority ?? patterns.length + 1,
    });
  }

  patterns.sort((a, b) => a.priority - b.priority);
  return patterns;
}
