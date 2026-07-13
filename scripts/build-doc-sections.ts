#!/usr/bin/env bun
/**
 * Build doc-sections-cache.json from project documentation.
 * Usage: bun scripts/build-doc-sections.ts [--docs path1,path2] [--output path]
 */

import { join } from "path";
import { buildDocSectionCache } from "../src/graph/doc-sections";
import { LocalEmbeddingProvider } from "../src/graph/embeddings";

const DEFAULT_DOCS = [
  join(process.env.HOME!, ".claude", "PAI", "Projects", "DailyBriefDashboard", "ARCHITECTURE.md"),
  join(process.env.HOME!, ".claude", "PAI", "Projects", "DailyBriefDashboard", "PRINCIPLES.md"),
];
const DEFAULT_OUTPUT = join(process.env.HOME!, ".agentgrit", "state", "doc-sections-cache.json");

const args = process.argv.slice(2);
const docsIdx = args.indexOf("--docs");
const outputIdx = args.indexOf("--output");

const docPaths = docsIdx >= 0 ? args[docsIdx + 1].split(",") : DEFAULT_DOCS;
const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : DEFAULT_OUTPUT;

console.log(`Building doc section cache...`);
console.log(`Docs: ${docPaths.join(", ")}`);
console.log(`Output: ${outputPath}`);

const provider = new LocalEmbeddingProvider();
const cache = await buildDocSectionCache(docPaths, provider, outputPath);

console.log(`\nDone.`);
console.log(`Sections: ${cache.sections.length}`);
console.log(`Dimensions: ${cache.sections[0]?.vector.length ?? 0}`);
console.log(`Model: ${cache.model}`);
console.log(`Built at: ${cache.builtAt}`);

// Show section headings
for (const s of cache.sections) {
  console.log(`  - ${s.heading} (${s.sourcePath.split("/").pop()}, L${s.lineStart}, ${s.lineCount} lines)`);
}
