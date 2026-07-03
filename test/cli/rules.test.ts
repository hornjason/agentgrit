import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, ".tmp-rules-test");

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, "state"), { recursive: true });
  process.env.AGENTGRIT_DIR = TEST_DIR;
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

describe("rules command", () => {
  test("shows budget with empty graph", async () => {
    const { rulesCommand } = await import("../../bin/commands/rules");
    await rulesCommand(["status"]);
  });

  test("lists rules from graph", async () => {
    const graph = {
      version: "1.0",
      builtAt: new Date().toISOString(),
      nodeCount: 2,
      edgeCount: 1,
      nodes: {
        "rule-1": { id: "rule-1", name: "verify-first", domains: ["verification"], ruleText: "Always verify before asserting", stats: { injectionCount: 5, avgRating: 7, highRatingActivations: 3, lowRatingActivations: 0, sessionRatings: [], lastSeen: new Date().toISOString() } },
        "rule-2": { id: "rule-2", name: "delegate-code", domains: ["delegation"], ruleText: "Delegate code changes to Marcus", stats: { injectionCount: 3, avgRating: 8, highRatingActivations: 2, lowRatingActivations: 0, sessionRatings: [], lastSeen: new Date().toISOString() } },
      },
      edges: [],
    };

    writeFileSync(join(TEST_DIR, "state", "knowledge-graph.json"), JSON.stringify(graph));

    const { rulesCommand } = await import("../../bin/commands/rules");
    await rulesCommand([]);
  });

  test("handles rebalance subcommand", async () => {
    const { rulesCommand } = await import("../../bin/commands/rules");
    await rulesCommand(["rebalance"]);
  });

  test("handles compact subcommand", async () => {
    const { rulesCommand } = await import("../../bin/commands/rules");
    await rulesCommand(["compact"]);
  });
});
