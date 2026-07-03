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
        "rule-1": { id: "rule-1", file: "rule-1.md", type: "rule", name: "verify-first", description: "Always verify before asserting", domains: ["verification"], severity: 4, occurrence_count: 5, last_updated: new Date().toISOString(), content_hash: "abc12345", memoryType: "behavioral-rule" },
        "rule-2": { id: "rule-2", file: "rule-2.md", type: "rule", name: "delegate-code", description: "Delegate code changes to Marcus", domains: ["delegation"], severity: 3, occurrence_count: 3, last_updated: new Date().toISOString(), content_hash: "def67890", memoryType: "behavioral-rule" },
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
