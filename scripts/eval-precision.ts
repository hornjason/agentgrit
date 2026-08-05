import { readFileSync } from "fs";
import { join } from "path";
import { getContextRules, detectDomains, initHybridDetection } from "../src/graph/context";
import { buildIndexFromDir } from "../src/graph/bm25";
import { precisionAtK, recallAtK, reciprocalRank } from "../src/evaluate/recall";
import type { Graph } from "../src/graph/types";

const base = join(process.env.HOME!, ".agentgrit");
const graphPath = join(base, "state", "knowledge-graph.json");
const goldPath = join(process.env.HOME!, ".claude/MEMORY/LEARNING/STATE/graph-gold.json");
const memoryDir = join(process.env.HOME!, ".claude/projects/-Users-jhorn--claude/memory");

const graphData = JSON.parse(readFileSync(graphPath, "utf-8")) as Graph;
const goldData = JSON.parse(readFileSync(goldPath, "utf-8"));
const index = buildIndexFromDir(memoryDir);

initHybridDetection(graphData);

console.log(`Graph: ${Object.keys(graphData.nodes).length} nodes`);
console.log(`Index: ${index.docCount} docs`);
console.log(`Gold set: ${Object.keys(goldData.labeled).length} sessions\n`);

let totalP5 = 0, totalR5 = 0, totalR15 = 0, totalMRR = 0;
let count = 0;

for (const [sid, entry] of Object.entries(goldData.labeled) as [string, any][]) {
  const goldRules = entry.relevant_rules ?? entry.relevantRules ?? [];
  if (goldRules.length === 0) continue;

  const queryText = entry.sentiment_summary ?? entry.description ?? sid;
  const domains = entry.domains ?? detectDomains(queryText);

  const retrieved = await getContextRules(graphData, index, domains, 15, undefined, queryText);
  const retrievedIds = retrieved.map(r => r.id);

  const p5 = precisionAtK(goldRules, retrievedIds, 5);
  const r5 = recallAtK(goldRules, retrievedIds, 5);
  const r15 = recallAtK(goldRules, retrievedIds, 15);
  const mrr = reciprocalRank(goldRules, retrievedIds);

  totalP5 += p5;
  totalR5 += r5;
  totalR15 += r15;
  totalMRR += mrr;
  count++;

  if (p5 < 0.2) {
    console.log(`  LOW p5=${p5.toFixed(2)} r15=${r15.toFixed(2)} | ${queryText.slice(0, 60)}`);
  }
}

console.log(`\n--- Results (${count} sessions) ---`);
console.log(`Precision@5:  ${(totalP5 / count).toFixed(3)}`);
console.log(`Recall@5:     ${(totalR5 / count).toFixed(3)}`);
console.log(`Recall@15:    ${(totalR15 / count).toFixed(3)}`);
console.log(`MRR:          ${(totalMRR / count).toFixed(3)}`);
