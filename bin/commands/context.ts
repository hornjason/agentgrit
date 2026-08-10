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
  writeSessionContext,
  detectDomainsFromGitStatus,
  computeSmartDefaults,
  formatGraphContext,
} from "../../src/graph/context";

const GRAPH_CONTEXT_PATH = join(homedir(), ".claude", "MEMORY", "STATE", "GRAPH-CONTEXT.md");

function parseArgs(args: string[]): { text?: string; issue?: number; file?: string; limit: number } {
  let text: string | undefined;
  let issue: number | undefined;
  let file: string | undefined;
  let limit = 10;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--text" && args[i + 1]) {
      text = args[++i];
    } else if (args[i] === "--issue" && args[i + 1]) {
      issue = parseInt(args[++i], 10);
    } else if (args[i] === "--file" && args[i + 1]) {
      file = args[++i];
    } else if (args[i] === "--limit" && args[i + 1]) {
      limit = parseInt(args[++i], 10) || 10;
    }
  }

  return { text, issue, file, limit };
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

  const rules = await getContextRules(
    graph, index, domains, opts.limit, signalDir,
    inputText || undefined,
  );

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
    console.log("  Usage: agentgrit context refresh [--text TEXT | --issue N | --file PATH]");
    console.log("  Options:");
    console.log("    --text TEXT   Use text directly for domain detection");
    console.log("    --issue N     Fetch GitHub issue N as input text");
    console.log("    --file PATH   Read file contents as input text");
    console.log("    --limit N     Max context rules (default: 10)");
  }

  console.log("");
}
