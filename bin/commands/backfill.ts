import { existsSync } from "fs";
import { join } from "path";
import { getBaseDir, resolveMemoryDir, resolveSignalDir } from "../../src/adapters/paths";
import { buildGraph, readGraph } from "../../src/graph/builder";
import { runReview } from "../../src/promote/review";

export async function backfillCommand(args: string[]): Promise<void> {
  const base = getBaseDir();

  if (!existsSync(base)) {
    console.log("agentgrit not initialized. Run 'agentgrit init' first.");
    return;
  }

  console.log("\nagentgrit backfill\n");

  // Step 1: Build graph from memory files
  const memoryDir = resolveMemoryDir();
  console.log("  Step 1: Building knowledge graph...");
  console.log(`    Memory dir: ${memoryDir}`);

  if (!existsSync(memoryDir)) {
    console.log(`    ✗ Memory directory not found: ${memoryDir}`);
    console.log("    Set memoryDir in ~/.agentgrit/config.json or run 'agentgrit init --bootstrap'\n");
    return;
  }

  const graph = await buildGraph(memoryDir, join(base, "state"));
  console.log(`    ✓ Built: ${graph.nodeCount} nodes, ${graph.edgeCount} edges`);

  // Step 2: Run review (detect patterns, propose candidates)
  const sigDir = resolveSignalDir();
  console.log("\n  Step 2: Detecting patterns...");
  console.log(`    Signal dir: ${sigDir}`);

  if (!existsSync(sigDir)) {
    console.log("    ✗ No signals directory found");
    console.log("    Skipping pattern detection.\n");
  } else {
    const result = await runReview(sigDir, join(base, "state"));
    console.log(`    ✓ Patterns found: ${result.patternsFound}`);
    console.log(`    ✓ Candidates proposed: ${result.candidatesProposed}`);
    if (result.scoreTrend.count > 0) {
      const dir = result.scoreTrend.direction === "up" ? "↑" : result.scoreTrend.direction === "down" ? "↓" : "→";
      console.log(`    ✓ Score trend: ${result.scoreTrend.avg.toFixed(1)} avg (${result.scoreTrend.count} ratings) ${dir}`);
    }
  }

  // Step 3: Report results
  console.log("\n  Step 3: Summary");
  const finalGraph = readGraph();
  console.log(`    Graph: ${finalGraph.nodeCount} nodes, ${finalGraph.edgeCount} edges`);
  console.log(`    Built: ${finalGraph.builtAt}`);

  const domains = new Map<string, number>();
  for (const node of Object.values(finalGraph.nodes)) {
    for (const d of node.domains) {
      domains.set(d, (domains.get(d) ?? 0) + 1);
    }
  }
  if (domains.size > 0) {
    console.log(`    Domains: ${domains.size}`);
    const sorted = [...domains.entries()].sort((a, b) => b[1] - a[1]);
    for (const [domain, count] of sorted.slice(0, 5)) {
      console.log(`      ${domain.padEnd(20)} ${count} nodes`);
    }
  }

  console.log("\n  ✓ Backfill complete. Run 'agentgrit status' to verify.\n");
}
