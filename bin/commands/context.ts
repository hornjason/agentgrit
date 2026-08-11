import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { execSync } from "child_process";
import { homedir } from "os";
import { getBaseDir, resolveMemoryDir, resolveSignalDir } from "../../src/adapters/paths";
import { readGraph } from "../../src/graph/builder";
import { queryGraph } from "../../src/graph/query";
import { buildIndexFromDir } from "../../src/graph/bm25";
import {
  initHybridDetection,
  detectDomains,
  getContextRules,
  retrieveByEmbeddingSeed,
  writeSessionContext,
  detectDomainsFromGitStatus,
  computeSmartDefaults,
  formatGraphContext,
  type RetrievalStrategy,
} from "../../src/graph/context";
import { loadVectorCache } from "../../src/graph/embeddings";
import { diagnoseBM25, tokenize } from "../../src/graph/bm25";
import { RRF_WEIGHTS } from "../../src/graph/retrieval";

const GRAPH_CONTEXT_PATH = join(homedir(), ".claude", "MEMORY", "STATE", "GRAPH-CONTEXT.md");

function parseArgs(args: string[]): { text?: string; issue?: number; file?: string; limit: number; verbose: boolean; strategy: RetrievalStrategy } {
  let text: string | undefined;
  let issue: number | undefined;
  let file: string | undefined;
  let limit = 10;
  let verbose = false;
  let strategy: RetrievalStrategy = "current";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--text" && args[i + 1]) {
      text = args[++i];
    } else if (args[i] === "--issue" && args[i + 1]) {
      issue = parseInt(args[++i], 10);
    } else if (args[i] === "--file" && args[i + 1]) {
      file = args[++i];
    } else if (args[i] === "--limit" && args[i + 1]) {
      limit = parseInt(args[++i], 10) || 10;
    } else if (args[i] === "--verbose") {
      verbose = true;
    } else if (args[i] === "--strategy" && args[i + 1]) {
      const val = args[++i];
      if (val === "embeddings" || val === "current") strategy = val;
    }
  }

  return { text, issue, file, limit, verbose, strategy };
}

function resolveInputText(opts: { text?: string; issue?: number; file?: string }): string {
  if (opts.text) return opts.text;

  if (opts.issue) {
    try {
      const output = execSync(
        `gh issue view ${opts.issue} --json title,body,labels`,
        { encoding: "utf-8", timeout: 10000 },
      ).trim();
      const data = JSON.parse(output) as { title?: string; body?: string; labels?: Array<{ name: string }> };
      const parts = [data.title || "", data.body || ""];
      if (data.labels?.length) {
        parts.push(data.labels.map(l => l.name).join(" "));
      }
      return parts.join("\n");
    } catch (err) {
      console.error(`  Failed to fetch issue #${opts.issue}: ${err instanceof Error ? err.message : err}`);
      return "";
    }
  }

  if (opts.file) {
    if (!existsSync(opts.file)) {
      console.error(`  File not found: ${opts.file}`);
      return "";
    }
    return readFileSync(opts.file, "utf-8");
  }

  return "";
}

async function doRefresh(args: string[]): Promise<void> {
  const base = getBaseDir();
  if (!existsSync(base)) {
    console.error("  agentgrit not initialized. Run 'agentgrit init' first.");
    process.exit(1);
  }

  const opts = parseArgs(args);
  const inputText = resolveInputText(opts);

  const graph = readGraph();
  if (graph.nodeCount === 0) {
    console.error("  Empty graph. Run 'agentgrit graph build' first.");
    process.exit(1);
  }

  initHybridDetection(graph);

  let domains: string[] = [];
  let domainSource: "metadata" | "keyword" | "bm25" = "keyword";

  if (inputText) {
    domains = detectDomains(inputText);
  }

  if (domains.length === 0) {
    domains = detectDomainsFromGitStatus();
    domainSource = "keyword";
    if (domains.length > 0) {
      console.log(`  Fallback: domains from git status → [${domains.join(", ")}]`);
    }
  }

  if (domains.length === 0) {
    const signalDir = resolveSignalDir();
    domains = computeSmartDefaults(signalDir);
    domainSource = "bm25";
    if (domains.length > 0) {
      console.log(`  Fallback: smart defaults → [${domains.join(", ")}]`);
    }
  }

  if (domains.length === 0) {
    domains = ["verification", "delivery", "deployment"];
    domainSource = "bm25";
    console.log(`  Fallback: last resort defaults → [${domains.join(", ")}]`);
  }

  const memoryDir = resolveMemoryDir();
  const signalDir = resolveSignalDir();
  const index = buildIndexFromDir(memoryDir);

  const searchText = inputText || domains.join(" ");

  if (opts.verbose) {
    const terms = tokenize(searchText);
    console.log(`  Query terms: [${terms.join(", ")}]`);

    const diag = diagnoseBM25(index, searchText);
    console.log(`  BM25 Diagnostic:`);
    console.log(`    Corpus: ${diag.corpusSize} docs, avg length ${diag.avgDocLen.toFixed(1)}`);
    console.log(`    Vocabulary: ${diag.vocabularySize} terms`);
    console.log(`    Query terms in vocab: [${diag.queryTermsInVocab.join(", ")}]`);
    console.log(`    Query terms missing: [${diag.queryTermsMissing.join(", ")}]`);
    console.log(`    IDF stats: min=${diag.idfStats.min.toFixed(3)} max=${diag.idfStats.max.toFixed(3)} mean=${diag.idfStats.mean.toFixed(3)} stddev=${diag.idfStats.stddev.toFixed(3)}`);
    console.log(`    Root cause: ${diag.rootCause}`);
    console.log(`    Evidence: ${diag.rootCauseEvidence}`);
    console.log(`  Top 10 BM25 scores:`);
    for (const s of diag.topScores) {
      console.log(`    ${s.id}: ${s.score.toFixed(4)}`);
    }
    console.log(`  RRF weights: bm25=${RRF_WEIGHTS.bm25} graph=${RRF_WEIGHTS.graph} vector=${RRF_WEIGHTS.vector}`);
    console.log(`  Domains detected: [${domains.join(", ")}] (source: ${domainSource})`);
  }

  let rules;
  if (opts.strategy === "embeddings") {
    const vectorCachePath = join(base, "state", "vector-cache.json");
    const vectorCache = loadVectorCache(vectorCachePath);
    if (vectorCache && vectorCache.size > 0) {
      rules = retrieveByEmbeddingSeed(
        searchText, graph, index, vectorCache, opts.limit,
      );
      if (opts.verbose) {
        console.log(`  Strategy: embeddings (${vectorCache.size} vectors)`);
      }
    } else {
      console.log("  Warning: no vector cache found, falling back to current strategy");
      rules = await getContextRules(
        graph, index, domains, opts.limit, signalDir,
        inputText || undefined,
      );
    }
  } else {
    rules = await getContextRules(
      graph, index, domains, opts.limit, signalDir,
      inputText || undefined,
    );
  }

  const clusters = queryGraph(graph, domains, 5);

  const markdown = formatGraphContext(clusters, rules, domains);

  const dir = dirname(GRAPH_CONTEXT_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(GRAPH_CONTEXT_PATH, markdown, "utf-8");

  const totalContextLines = markdown.split("\n").length;
  writeSessionContext(rules, domains, domainSource, totalContextLines);

  console.log(`  Domains: [${domains.join(", ")}]`);
  console.log(`  Clusters: ${clusters.length}`);
  console.log(`  Rules: ${rules.length}`);
  console.log(`  Output: ${GRAPH_CONTEXT_PATH}`);
  console.log(`  Lines: ${totalContextLines}`);
}

export async function contextCommand(args: string[]): Promise<void> {
  const sub = args[0];
  const subArgs = args.slice(1);

  console.log("\nagentgrit context\n");

  if (sub === "refresh") {
    await doRefresh(subArgs);
  } else {
    console.log("  Usage: agentgrit context refresh [--text TEXT | --issue N | --file PATH] [--strategy current|embeddings] [--verbose]");
    console.log("  Options:");
    console.log("    --text TEXT       Use text directly for domain detection");
    console.log("    --issue N         Fetch GitHub issue N as input text");
    console.log("    --file PATH       Read file contents as input text");
    console.log("    --limit N         Max context rules (default: 10)");
    console.log("    --strategy STR    Retrieval strategy: current (default) or embeddings");
    console.log("    --verbose         Show BM25 diagnostic, scores, and query analysis");
  }

  console.log("");
}
