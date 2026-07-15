import { buildGraph, readGraph } from "../src/graph/builder";
import { buildIndexFromDir } from "../src/graph/bm25";
import { getContextRules, detectDomains, filterLearnedRules } from "../src/graph/context";
import { resolveMemoryDir } from "../src/adapters/paths";
import { stateDir } from "../src/adapters/paths";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const memoryDir = resolveMemoryDir();
const sd = stateDir();

const TASKS = [
  { name: "Ship agentgrit issue #130", query: "ship agentgrit issue implement feature build test verify" },
  { name: "Fix DDB deploy bug", query: "fix bug deploy make rebuild container docker DailyBriefDashboard" },
  { name: "Write B2B email outreach", query: "write email outreach customer Red Hat account executive sales" },
  { name: "Security review changed files", query: "security scan vulnerability review rook changed files audit" },
  { name: "Investigate scraper data gaps", query: "scraper data gaps missing items iterate investigation seismic" },
];

async function main() {
  console.log("Building graph from", memoryDir);
  const graph = await buildGraph(memoryDir, sd);
  const index = buildIndexFromDir(memoryDir);

  const nodeCount = Object.keys(graph.nodes).length;
  const edgeCount = graph.edges.length;
  const withDomains = Object.values(graph.nodes).filter(n => n.domains?.length > 0 && n.domains[0]).length;
  const zeroDomains = Object.values(graph.nodes).filter(n => !n.domains?.length || !n.domains[0]);
  const zeroEdges = Object.values(graph.nodes).filter(n => {
    const hasEdge = graph.edges.some(e => e.from === n.id || e.to === n.id);
    return !hasEdge;
  });
  const isolatedWithDomains = zeroEdges.filter(n => n.domains?.length > 0 && n.domains[0]);

  console.log(`\nGraph: ${nodeCount} nodes, ${edgeCount} edges`);
  console.log(`Domain coverage: ${withDomains}/${nodeCount} (${Math.round(withDomains/nodeCount*100)}%)`);
  console.log(`Zero-domain nodes: ${zeroDomains.length}`);
  console.log(`Zero-edge (isolated) nodes: ${zeroEdges.length}`);
  console.log(`Isolated WITH domains (LLM-classified): ${isolatedWithDomains.length}`);
  if (zeroDomains.length > 0) {
    console.log(`\nNodes still missing domains:`);
    for (const n of zeroDomains.slice(0, 10)) {
      console.log(`  ⚠️  ${n.id} (type: ${n.type || "unknown"}, edges: ${graph.edges.filter(e => e.from === n.id || e.to === n.id).length})`);
    }
    if (zeroDomains.length > 10) console.log(`  ... +${zeroDomains.length - 10} more`);
  }

  const vectorPath = join(sd, "vector-cache.json");
  const hasVectors = existsSync(vectorPath);
  console.log(`\nVector cache: ${hasVectors ? "available" : "not found"}`);

  const learnedPath = join(process.env.HOME!, ".claude", "CLAUDE-LEARNED.md");
  const learnedContent = existsSync(learnedPath) ? readFileSync(learnedPath, "utf-8") : "";

  const allResults: Map<string, Set<string>> = new Map();

  for (const task of TASKS) {
    console.log(`\n${"═".repeat(70)}`);
    console.log(`TASK: ${task.name}`);

    const domains = detectDomains(task.query);
    console.log(`DOMAINS: ${domains.length > 0 ? domains.join(", ") : "(none → fallback)"}`);

    const rules = await getContextRules(
      graph, index, domains, 15, undefined, task.query,
      hasVectors ? vectorPath : undefined
    );

    console.log(`RULES INJECTED: ${rules.length}`);
    const ruleIds = new Set(rules.map(r => r.id));
    allResults.set(task.name, ruleIds);

    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      const src = r.domainSource ? ` [${r.domainSource}]` : "";
      const score = r.correlationScore?.toFixed(3) || "?";
      console.log(`  ${i+1}. ${r.id} (${score})${src}`);
      console.log(`     "${r.text.substring(0, 90).replace(/\n/g, " ")}"`);
    }

    // Check if any previously-isolated nodes got retrieved
    const isolatedHits = rules.filter(r => zeroEdges.some(n => n.id === r.id));
    if (isolatedHits.length > 0) {
      console.log(`\n  ✅ ISOLATED NODES REACHED: ${isolatedHits.length}`);
      for (const h of isolatedHits) console.log(`     → ${h.id} (was isolated, now retrieved via BM25/LLM-classify)`);
    }
  }

  // Overlap
  console.log(`\n${"═".repeat(70)}`);
  console.log("OVERLAP ANALYSIS:");
  const taskNames = Array.from(allResults.keys());
  let totalOverlap = 0, pairCount = 0;
  for (let i = 0; i < taskNames.length; i++) {
    for (let j = i + 1; j < taskNames.length; j++) {
      const a = allResults.get(taskNames[i])!;
      const b = allResults.get(taskNames[j])!;
      const intersection = new Set([...a].filter(x => b.has(x)));
      const union = new Set([...a, ...b]);
      const jaccard = union.size > 0 ? intersection.size / union.size : 0;
      totalOverlap += jaccard;
      pairCount++;
      if (jaccard > 0.2) {
        console.log(`  ⚠️  ${(jaccard*100).toFixed(0)}% overlap: "${taskNames[i]}" vs "${taskNames[j]}"`);
      }
    }
  }
  console.log(`  Average overlap: ${((totalOverlap/pairCount)*100).toFixed(1)}% (target: <15%)`);
  console.log(`  Average rules/task: ${(Array.from(allResults.values()).reduce((s,v) => s+v.size, 0) / TASKS.length).toFixed(1)} (budget: ≤20)`);
}

main().catch(console.error);
