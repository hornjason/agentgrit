import { existsSync } from "fs";
import { getBaseDir } from "../../src/adapters/paths";
import { readGraph } from "../../src/graph/builder";
import { generatePatterns, writeCachedPatterns, loadCachedPatterns, loadSeedPatterns } from "../../src/graph/generate-patterns";

export async function patternsCommand(args: string[]): Promise<void> {
  const base = getBaseDir();
  const sub = args[0];
  const dryRun = args.includes("--dry-run");

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

    console.log(`  Generating domain patterns from graph...${dryRun ? " (dry-run)" : ""}`);
    const patterns = generatePatterns(graph);
    const seeds = loadSeedPatterns();
    const seedMap = new Map(seeds.map(s => [s.domain, s]));

    console.log(`  Generated ${patterns.length} domain patterns`);
    for (const p of patterns) {
      const seed = seedMap.get(p.domain);
      const seedTerms = new Set(seed?.terms.map(t => t.toLowerCase()) ?? []);
      const genTerms = new Set(p.terms.map(t => t.toLowerCase()));
      const bigrams = p.terms.filter(t => t.includes(" "));

      if (dryRun) {
        const added = p.terms.filter(t => !seedTerms.has(t.toLowerCase()));
        const removed = (seed?.terms ?? []).filter(t => !genTerms.has(t.toLowerCase()));
        console.log(`\n  ${p.domain}`);
        console.log(`    seed terms:      ${seed?.terms.join(", ") ?? "(none)"}`);
        console.log(`    generated terms: ${p.terms.join(", ")}`);
        console.log(`    bigrams:         ${bigrams.length > 0 ? bigrams.join(", ") : "(none)"}`);
        console.log(`    cascadePattern:  ${p.cascadePattern ?? "(none)"}`);
        if (added.length > 0) console.log(`    + added:         ${added.join(", ")}`);
        if (removed.length > 0) console.log(`    - removed:       ${removed.join(", ")}`);
      } else {
        const source = seed && JSON.stringify(p.terms) === JSON.stringify(seed.terms) ? "seed" : "bm25";
        console.log(`    ${p.domain.padEnd(16)} ${p.terms.length} terms, ${bigrams.length} bigrams (${source})`);
      }
    }

    if (!dryRun) {
      const path = writeCachedPatterns(patterns);
      console.log(`\n  Cache written to: ${path}`);
    } else {
      console.log("\n  Dry run — no cache written.");
    }
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
    console.log("    agentgrit patterns generate [--dry-run]   Generate patterns from graph");
    console.log("    agentgrit patterns show                    Show cached patterns");
  }

  console.log("");
}
