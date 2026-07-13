import { existsSync, readFileSync, writeFileSync } from "fs";
import type { SessionContext } from "./context";
import type { Graph } from "./types";
import { readGraph, writeGraphFile } from "./builder";

export function updateEdgeWeightsFromRating(
  sessionContext: SessionContext,
  rating: number,
  graphPath?: string,
): void {
  let graph: Graph;
  if (graphPath && existsSync(graphPath)) {
    graph = JSON.parse(readFileSync(graphPath, "utf-8")) as Graph;
  } else {
    graph = readGraph();
  }

  const ruleIdSet = new Set(sessionContext.ruleIds);
  let changed = false;

  for (const edge of graph.edges) {
    if (edge.relationship !== "co_occurred") continue;
    if (!ruleIdSet.has(edge.from) && !ruleIdSet.has(edge.to)) continue;

    if (rating >= 7) {
      const newStrength = Math.min(2.0, edge.strength * 1.1);
      if (newStrength !== edge.strength) {
        edge.strength = Math.round(newStrength * 10000) / 10000;
        changed = true;
      }
    } else if (rating <= 3) {
      const newStrength = Math.max(0.1, edge.strength * 0.9);
      if (newStrength !== edge.strength) {
        edge.strength = Math.round(newStrength * 10000) / 10000;
        changed = true;
      }
    }
  }

  if (!changed) return;

  if (graphPath) {
    writeFileSync(graphPath, JSON.stringify(graph, null, 2), "utf-8");
  } else {
    writeGraphFile(graph);
  }
}
