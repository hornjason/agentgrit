import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, ".tmp-status-test");

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, "signals"), { recursive: true });
  mkdirSync(join(TEST_DIR, "state"), { recursive: true });
  mkdirSync(join(TEST_DIR, "rubrics"), { recursive: true });
  process.env.AGENTGRIT_DIR = TEST_DIR;
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

describe("status command", () => {
  test("handles empty signals directory", async () => {
    const { statusCommand } = await import("../../bin/commands/status");
    await statusCommand([]);
  });

  test("reads signal counts from JSONL files", async () => {
    const signals = [
      { id: "1", type: "rating", timestamp: new Date().toISOString(), session_id: "s1", schemaVersion: 1, rating: 7, source: "explicit" },
      { id: "2", type: "rating", timestamp: new Date().toISOString(), session_id: "s2", schemaVersion: 1, rating: 8, source: "explicit" },
    ];

    const ratingsPath = join(TEST_DIR, "signals", "ratings.jsonl");
    writeFileSync(ratingsPath, signals.map((s) => JSON.stringify(s)).join("\n") + "\n");

    const { statusCommand } = await import("../../bin/commands/status");
    await statusCommand([]);
  });

  test("shows rule budget from graph", async () => {
    const graph = { version: "1.0", builtAt: new Date().toISOString(), nodeCount: 5, edgeCount: 3, nodes: {}, edges: [] };
    writeFileSync(join(TEST_DIR, "state", "knowledge-graph.json"), JSON.stringify(graph));

    const { statusCommand } = await import("../../bin/commands/status");
    await statusCommand([]);
  });
});
