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

function buildDomainCorpus(graph: Graph): Map<string, string[]> {
  const corpus = new Map<string, string[]>();
  for (const node of Object.values(graph.nodes)) {
    for (const domain of node.domains) {
      if (!(DOMAINS as readonly string[]).includes(domain)) continue;
      const texts = corpus.get(domain) ?? [];
      texts.push(`${node.name} ${node.description}`);
      corpus.set(domain, texts);
    }
  }
  return corpus;
}

function computeGlobalDF(allTokensByDomain: Map<string, string[]>): Map<string, number> {
  const df = new Map<string, number>();
  for (const tokens of allTokensByDomain.values()) {
    const unique = new Set(tokens);
    for (const term of unique) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  return df;
}

function extractTopTerms(
  domainTokens: string[],
  globalDF: Map<string, number>,
  totalDomains: number,
  topK: number,
): string[] {
  const tf = new Map<string, number>();
  for (const t of domainTokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }

  const scored: Array<{ term: string; score: number }> = [];
  for (const [term, count] of tf) {
    const dfVal = globalDF.get(term) ?? 1;
    const idf = Math.log((totalDomains + 1) / (dfVal + 0.5));
    scored.push({ term, score: count * idf });
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

export function generatePatterns(graph: Graph, minRulesPerDomain = 3): DomainPattern[] {
  const seeds = loadSeedPatterns();
  const seedMap = new Map(seeds.map(s => [s.domain, s]));

  const corpus = buildDomainCorpus(graph);
  const allTokensByDomain = new Map<string, string[]>();
  for (const [domain, texts] of corpus) {
    allTokensByDomain.set(domain, tokenize(texts.join(" ")));
  }

  const globalDF = computeGlobalDF(allTokensByDomain);
  const totalDomains = allTokensByDomain.size;

  const patterns: DomainPattern[] = [];

  for (const domain of DOMAINS) {
    const seed = seedMap.get(domain);
    const domainTokens = allTokensByDomain.get(domain);

    const nodeCount = [...Object.values(graph.nodes)].filter(
      n => n.domains.includes(domain),
    ).length;

    if (!domainTokens || nodeCount < minRulesPerDomain) {
      if (seed) {
        patterns.push({ ...seed });
      }
      continue;
    }

    const topTerms = extractTopTerms(domainTokens, globalDF, totalDomains, 15);
    const patternStr = buildPatternFromTerms(topTerms);

    patterns.push({
      domain,
      terms: topTerms,
      pattern: patternStr,
      negativePattern: seed?.negativePattern,
      priority: seed?.priority ?? patterns.length + 1,
    });
  }

  patterns.sort((a, b) => a.priority - b.priority);
  return patterns;
}
