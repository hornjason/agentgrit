import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getBaseDir, stateDir } from "../../src/adapters/paths";
import { readGraph, buildGraph, writeGraphFile } from "../../src/graph/builder";
import { queryGraph } from "../../src/graph/query";
import { relativeTime } from "../../src/adapters/time";

function showStats(base: string): void {
  const graphPath = join(base, "state", "knowledge-graph.json");
  if (!existsSync(graphPath)) {
    console.log("  No graph found. Run 'agentgrit graph build' first.\n");
    return;
  }

  const graph = readGraph();
  console.log(`  Nodes:   ${graph.nodeCount}`);
  console.log(`  Edges:   ${graph.edgeCount}`);
  console.log(`  Built:   ${relativeTime(graph.builtAt)}`);

  const domains = new Map<string, number>();
  for (const node of Object.values(graph.nodes)) {
    for (const d of node.domains) {
      domains.set(d, (domains.get(d) ?? 0) + 1);
    }
  }

  if (domains.size > 0) {
    console.log(`  Domains: ${domains.size}`);
    const sorted = [...domains.entries()].sort((a, b) => b[1] - a[1]);
    for (const [domain, count] of sorted.slice(0, 10)) {
      console.log(`    ${domain.padEnd(20)} ${count} nodes`);
    }
    if (sorted.length > 10) {
      console.log(`    ... and ${sorted.length - 10} more`);
    }
  }
}

async function doBuild(base: string, full: boolean): Promise<void> {
  const rulesDir = join(base, "rubrics");
  console.log(`  Building graph${full ? " (full)" : " (incremental)"}...`);
  const graph = await buildGraph(rulesDir, join(base, "state"));
  console.log(`  ✓ Built: ${graph.nodeCount} nodes, ${graph.edgeCount} edges`);
}

function doQuery(base: string, queryStr: string): void {
  const graph = readGraph();
  if (graph.nodeCount === 0) {
    console.log("  Empty graph. Run 'agentgrit graph build' first.\n");
    return;
  }

  const domains = queryStr.split(",").map((d) => d.trim()).filter(Boolean);
  const clusters = queryGraph(graph, domains, 5);

  if (clusters.length === 0) {
    console.log(`  No clusters found for domains: ${domains.join(", ")}\n`);
    return;
  }

  console.log(`  ${clusters.length} cluster(s) for: ${domains.join(", ")}\n`);
  for (const cluster of clusters) {
    const text = cluster.primary.ruleText?.slice(0, 80) ?? "";
    console.log(`  [${cluster.score.toFixed(3)}] ${cluster.primary.id}`);
    console.log(`         ${text}`);
    console.log(`         domains: ${cluster.domains.join(", ")}`);
    if (cluster.connected.length > 0) {
      console.log(`         connected: ${cluster.connected.map((c) => c.node.id).join(", ")}`);
    }
  }
}

export async function graphCommand(args: string[]): Promise<void> {
  const base = getBaseDir();
  const sub = args[0];

  console.log("\nagentgrit graph\n");

  if (!existsSync(base)) {
    console.log("  agentgrit not initialized. Run 'agentgrit init' first.\n");
    return;
  }

  if (sub === "build") {
    await doBuild(base, args.includes("--full"));
  } else if (sub === "query") {
    const query = args.slice(1).join(" ");
    if (!query) {
      console.log("  Usage: agentgrit graph query <domains>\n");
      return;
    }
    doQuery(base, query);
  } else if (sub === "stats") {
    showStats(base);
  } else {
    showStats(base);
  }

  console.log("");
}
