import type { Graph } from "./types";
import type { GraphNode } from "../adapters/types";
import { DOMAINS } from "./builder";
import { inference } from "../adapters/inference";
import { writeGraphFile } from "./builder";

export interface ClassifyResult {
  nodeId: string;
  domains: string[];
  source: "ai";
  confidence: number;
}

const CLASSIFY_SYSTEM = `You are a behavioral rule classifier. Given a rule, assign 1-2 domain tags.
Available domains: ${DOMAINS.join(", ")}
Respond with JSON only: {"domains": ["tag1"]}`;

function isIsolated(node: GraphNode, edgeIndex: Set<string>): boolean {
  return node.domains.length === 0 && !edgeIndex.has(node.id);
}

function buildEdgeIndex(graph: Graph): Set<string> {
  const ids = new Set<string>();
  for (const edge of graph.edges) {
    ids.add(edge.from);
    ids.add(edge.to);
  }
  return ids;
}

export async function classifyIsolatedNodes(
  graph: Graph,
  opts?: { maxNodes?: number; dryRun?: boolean },
): Promise<ClassifyResult[]> {
  const max = opts?.maxNodes ?? 20;
  const edgeIndex = buildEdgeIndex(graph);

  const isolated = Object.values(graph.nodes).filter(n => isIsolated(n, edgeIndex));
  if (isolated.length === 0) return [];

  const batch = isolated.slice(0, max);
  const results: ClassifyResult[] = [];

  for (const node of batch) {
    const text = node.description || node.name;
    try {
      const res = await inference({
        systemPrompt: CLASSIFY_SYSTEM,
        userPrompt: `Rule: ${text.slice(0, 500)}`,
        level: "fast",
        expectJson: true,
        timeout: 15_000,
      });

      if (res.success && res.parsed) {
        const parsed = res.parsed as { domains?: string[] };
        const valid = (parsed.domains || []).filter(
          (d: string) => (DOMAINS as readonly string[]).includes(d),
        );
        if (valid.length > 0) {
          if (!opts?.dryRun) {
            node.domains = valid;
            node.domainSource = "ai";
          }
          results.push({
            nodeId: node.id,
            domains: valid,
            source: "ai",
            confidence: 0.7,
          });
        }
      }
    } catch {
      // inference unavailable — skip silently
    }
  }

  if (!opts?.dryRun && results.length > 0) {
    writeGraphFile(graph);
  }

  return results;
}
