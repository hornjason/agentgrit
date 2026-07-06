import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { getBaseDir, resolveSignalDir, resolveSignalFile } from "../../src/adapters/paths";

export async function exportCommand(args: string[]): Promise<void> {
  const base = getBaseDir();

  if (args.includes("--help")) {
    console.log("\nagentgrit export\n");
    console.log("  Usage:");
    console.log("    agentgrit export [<output-file>] [--stdout]");
    console.log("");
    console.log("  Exports the full agentgrit state as JSON:");
    console.log("    - Knowledge graph (nodes + edges)");
    console.log("    - Rubric definitions");
    console.log("    - Config (secrets redacted)");
    console.log("    - Promotion ledger");
    console.log("    - Recall evaluation results");
    console.log("    - Signal summaries (counts per file)");
    console.log("");
    console.log("  If <output-file> is given, writes to that path.");
    console.log("  Otherwise prints to stdout.\n");
    return;
  }

  if (!existsSync(base)) {
    console.error("agentgrit not initialized. Run 'agentgrit init' first.");
    process.exit(1);
  }

  const exported: Record<string, unknown> = {
    version: "0.1.0",
    exportedAt: new Date().toISOString(),
  };

  const graphPath = join(base, "state", "knowledge-graph.json");
  if (existsSync(graphPath)) {
    exported.graph = JSON.parse(readFileSync(graphPath, "utf-8"));
  }

  const rubricsDir = join(base, "rubrics");
  if (existsSync(rubricsDir)) {
    const rubrics: Record<string, unknown> = {};
    for (const file of readdirSync(rubricsDir).filter((f) => f.endsWith(".json"))) {
      rubrics[file] = JSON.parse(readFileSync(join(rubricsDir, file), "utf-8"));
    }
    exported.rubrics = rubrics;
  }

  const configPath = join(base, "config.json");
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    delete config.langfuse;
    delete config.judge?.apiKey;
    exported.config = config;
  }

  const ledgerPath = join(base, "state", "promotions.jsonl");
  if (existsSync(ledgerPath)) {
    const lines = readFileSync(ledgerPath, "utf-8").split("\n").filter((l) => l.trim());
    exported.promotions = lines.map((l) => JSON.parse(l));
  }

  const recallPath = join(base, "state", "recall-eval.json");
  if (existsSync(recallPath)) {
    exported.recallEval = JSON.parse(readFileSync(recallPath, "utf-8"));
  }

  const signalDir = resolveSignalDir();
  if (existsSync(signalDir)) {
    const signalFiles = readdirSync(signalDir).filter((f) => f.endsWith(".jsonl"));
    const signalSummary: Record<string, number> = {};
    for (const file of signalFiles) {
      const lines = readFileSync(join(signalDir, file), "utf-8").split("\n").filter((l) => l.trim());
      signalSummary[file] = lines.length;
    }
    exported.signals = signalSummary;
  }

  const output = JSON.stringify(exported, null, 2);

  if (args.includes("--stdout") || !args[0]) {
    console.log(output);
  } else {
    const outPath = args[0];
    writeFileSync(outPath, output);
    console.error(`Exported to ${outPath}`);
  }
}
