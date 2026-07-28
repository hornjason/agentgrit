import { existsSync, readFileSync, writeFileSync } from "fs";
import type { SessionContext } from "./context";
import type { Graph } from "./types";
import { readGraph, writeGraphFile } from "./builder";

export function proportionalAdjustment(rating: number): number {
  if (rating === 5) return 0;
  if (rating === 6) return 0.05;
  if (rating === 4) return -0.05;
  if (rating === 7) return 0.10;
  if (rating === 3) return -0.10;
  if (rating === 8) return 0.15;
  if (rating === 2) return -0.15;
  if (rating >= 9) return 0.15;
  if (rating <= 1) return -0.15;
  return 0;
}

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

    const adjustment = proportionalAdjustment(rating);
    if (adjustment === 0) continue;

    const factor = 1 + adjustment;
    const newStrength = Math.min(2.0, Math.max(0.1, edge.strength * factor));
    if (newStrength !== edge.strength) {
      edge.strength = Math.round(newStrength * 10000) / 10000;
      changed = true;
    }
  }

  if (!changed) return;

  if (graphPath) {
    writeFileSync(graphPath, JSON.stringify(graph, null, 2), "utf-8");
  } else {
    writeGraphFile(graph);
  }
}
