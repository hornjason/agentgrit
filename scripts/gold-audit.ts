#!/usr/bin/env bun
/**
 * Gold set audit script — shows what the system retrieves vs what's labeled
 * for each gold session, to identify under-labeled relevant_rules.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { readGraph } from "../src/graph/builder";
import { buildIndexFromDir } from "../src/graph/bm25";
import { getContextRules } from "../src/graph/context";
import { LocalEmbeddingProvider } from "../src/graph/embeddings";

const HOME = homedir();
const GOLD_PATH = join(HOME, ".claude", "MEMORY", "LEARNING", "STATE", "graph-gold.json");
const GRAPH_PATH = join(HOME, ".agentgrit", "state", "knowledge-graph.json");
const SIGNALS_DIR = join(HOME, ".claude", "projects", "-Users-jhorn--claude", "memory");
const VECTOR_CACHE = join(HOME, ".agentgrit", "state", "vector-cache.json");

interface GoldSession {
  session_id: string;
  task_context?: string;
  sentiment_summary?: string;
  relevant_rules: string[];
  domains?: string[];
  synthetic?: boolean;
  auto_labeled?: boolean;
}

const goldSet = JSON.parse(readFileSync(GOLD_PATH, "utf-8"));
const sessions: Record<string, GoldSession> = goldSet.labeled;

const graph = readGraph();
const index = buildIndexFromDir(SIGNALS_DIR);
const embeddingProvider = new LocalEmbeddingProvider();

// For each session, run getContextRules and compare
for (const [id, session] of Object.entries(sessions)) {
  const domains = session.domains?.length ? session.domains : ["verification", "delivery", "deployment"];
  const queryText = session.task_context || session.sentiment_summary || "";

  // Retrieve top 15 rules
  const rules = await getContextRules(graph, index, domains, 15, SIGNALS_DIR, queryText, VECTOR_CACHE, embeddingProvider);
  const retrievedIds = rules.map(r => r.id);

  const goldSet = new Set(session.relevant_rules);
  const retrievedSet = new Set(retrievedIds);

  // Rules retrieved but NOT in gold (potential under-labeling)
  const falsePositives = retrievedIds.filter(r => !goldSet.has(r));
  // Rules in gold but NOT retrieved (misses)
  const misses = session.relevant_rules.filter(r => !retrievedSet.has(r));
  // Hits
  const hits = retrievedIds.filter(r => goldSet.has(r));

  const precision5 = retrievedIds.slice(0, 5).filter(r => goldSet.has(r)).length / 5;
  const recall5 = retrievedIds.slice(0, 5).filter(r => goldSet.has(r)).length / session.relevant_rules.length;

  console.log(`\n${"=".repeat(80)}`);
  console.log(`SESSION: ${id}`);
  console.log(`  Task: ${(session.task_context || session.sentiment_summary || "").substring(0, 100)}`);
  console.log(`  Domains: ${domains.join(", ")}`);
  console.log(`  Gold rules: ${session.relevant_rules.length} | Retrieved: ${retrievedIds.length}`);
  console.log(`  Hits: ${hits.length} | P@5: ${precision5.toFixed(2)} | R@5: ${recall5.toFixed(2)}`);

  if (falsePositives.length > 0) {
    console.log(`  RETRIEVED BUT NOT IN GOLD (check if should be added):`);
    for (const fp of falsePositives) {
      const node = graph.nodes[fp];
      const desc = node?.description?.substring(0, 100) || "(no description)";
      console.log(`    - ${fp}: ${desc}`);
    }
  }

  if (misses.length > 0) {
    console.log(`  IN GOLD BUT NOT RETRIEVED (misses):`);
    for (const m of misses) {
      console.log(`    - ${m}`);
    }
  }
}
