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

  test("shows Highest and Lowest correlation headers", async () => {
    const stats = [
      { ruleId: "rule-a", injectionCount: 20, avgCorrelatedRating: 8.5, sessionRatings: [], highRatingActivations: 10, lowRatingActivations: 0, lastSeen: new Date().toISOString() },
      { ruleId: "rule-b", injectionCount: 15, avgCorrelatedRating: 3.2, sessionRatings: [], highRatingActivations: 2, lowRatingActivations: 8, lastSeen: new Date().toISOString() },
    ];
    writeFileSync(join(TEST_DIR, "state", "rule-stats.json"), JSON.stringify(stats));

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(" "));

    const { statusCommand } = await import("../../bin/commands/status");
    await statusCommand([]);

    console.log = origLog;

    expect(lines.some((l) => l.includes("Highest:"))).toBe(true);
    expect(lines.some((l) => l.includes("Lowest:"))).toBe(true);
    expect(lines.some((l) => l.includes("rule-a") && l.includes("avg: 8.5"))).toBe(true);
    expect(lines.some((l) => l.includes("rule-b") && l.includes("avg: 3.2"))).toBe(true);
  });

  test("shows insufficient data when no rules have enough injections", async () => {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(" "));

    const { statusCommand } = await import("../../bin/commands/status");
    await statusCommand([]);

    console.log = origLog;

    expect(lines.some((l) => l.includes("Insufficient data"))).toBe(true);
  });

  test("bottom 5 requires minimum 10 injections", async () => {
    const stats = [
      { ruleId: "high-inject", injectionCount: 12, avgCorrelatedRating: 2.0, sessionRatings: [], highRatingActivations: 0, lowRatingActivations: 10, lastSeen: new Date().toISOString() },
      { ruleId: "low-inject", injectionCount: 7, avgCorrelatedRating: 1.5, sessionRatings: [], highRatingActivations: 0, lowRatingActivations: 5, lastSeen: new Date().toISOString() },
    ];
    writeFileSync(join(TEST_DIR, "state", "rule-stats.json"), JSON.stringify(stats));

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(" "));

    const { statusCommand } = await import("../../bin/commands/status");
    await statusCommand([]);

    console.log = origLog;

    // high-inject (12 injections) appears in Lowest, low-inject (7 injections) does not
    const lowestSection = lines.findIndex((l) => l.includes("Lowest:"));
    const lowestLines = lowestSection >= 0 ? lines.slice(lowestSection) : [];
    expect(lowestLines.some((l) => l.includes("high-inject"))).toBe(true);
    expect(lowestLines.some((l) => l.includes("low-inject"))).toBe(false);
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
