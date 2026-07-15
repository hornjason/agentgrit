import { existsSync } from "fs";
import { getBaseDir } from "../../src/adapters/paths";
import { readGraph } from "../../src/graph/builder";
import { generatePatterns, writeCachedPatterns, loadCachedPatterns } from "../../src/graph/generate-patterns";

export async function patternsCommand(args: string[]): Promise<void> {
  const base = getBaseDir();
  const sub = args[0];

  console.log("\nagentgrit patterns\n");

  if (!existsSync(base)) {
    console.log("  agentgrit not initialized. Run 'agentgrit init' first.\n");
    return;
  }

  if (sub === "generate") {
    const graph = readGraph();
    if (graph.nodeCount === 0) {
      console.log("  Empty graph. Run 'agentgrit graph build' first.\n");
      return;
    }

    console.log("  Generating domain patterns from graph...");
    const patterns = generatePatterns(graph);
    const path = writeCachedPatterns(patterns);

    console.log(`  Generated ${patterns.length} domain patterns`);
    for (const p of patterns) {
      const source = p.terms.length > 0 && !p.cascadePattern ? "bm25" : "seed";
      console.log(`    ${p.domain.padEnd(16)} ${p.terms.length} terms (${source})`);
    }
    console.log(`\n  Cache written to: ${path}`);
  } else if (sub === "show") {
    const cached = loadCachedPatterns();
    if (!cached) {
      console.log("  No cached patterns. Run 'agentgrit patterns generate' first.\n");
      return;
    }
    for (const p of cached) {
      console.log(`  ${p.domain.padEnd(16)} ${p.terms.join(", ")}`);
    }
  } else {
    console.log("  Usage:");
    console.log("    agentgrit patterns generate   Generate patterns from graph");
    console.log("    agentgrit patterns show        Show cached patterns");
  }

  console.log("");
}
