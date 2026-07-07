import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import type { InferenceResult } from "../../src/adapters/inference";
import type { Graph } from "../../src/graph/types";

const TEST_DIR = "/tmp/agentgrit-consolidator-test-" + process.pid;

function mockGraph(nodeNames: string[] = []): Graph {
  const nodes: Record<string, import("../../src/adapters/types").GraphNode> = {};
  for (const name of nodeNames) {
    nodes[name] = {
      id: name,
      file: `${name}.md`,
      type: "rule",
      name,
      description: `Description for ${name}`,
      domains: ["verification"],
      severity: 3,
      occurrence_count: 0,
      last_updated: new Date().toISOString(),
      content_hash: "abc123",
      memoryType: "behavioral-rule",
    };
  }
  return {
    version: "1.0",
    builtAt: new Date().toISOString(),
    nodeCount: nodeNames.length,
    edgeCount: 0,
    nodes,
    edges: [],
  };
}

function makeRatingLine(rating: number, summary: string, timestamp?: string): string {
  return JSON.stringify({
    timestamp: timestamp ?? new Date().toISOString(),
    rating,
    session_id: `sess-${Math.random().toString(36).slice(2, 8)}`,
    source: "explicit",
    sentiment_summary: summary,
  });
}

function mockCritiqueInfer() {
  let callCount = 0;
  return async (opts: { expectJson?: boolean }) => {
    callCount++;
    if (opts.expectJson) {
      return {
        success: true,
        output: JSON.stringify([
          {
            name: "unverified_assertions",
            episodes: [1, 2, 3],
            failure: "The assistant made claims without checking first",
          },
        ]),
        parsed: [
          {
            name: "unverified_assertions",
            episodes: [1, 2, 3],
            failure: "The assistant made claims without checking first",
          },
        ],
        latencyMs: 100,
        level: "standard" as const,
        provider: "claude" as const,
      } as InferenceResult;
    }
    return {
      success: true,
      output: "Verify all claims with evidence before stating them as fact.",
      latencyMs: 50,
      level: "standard" as const,
      provider: "claude" as const,
    } as InferenceResult;
  };
}

function mockNoneInfer() {
  return async (opts: { expectJson?: boolean }) => {
    if (opts.expectJson) {
      return {
        success: true,
        output: JSON.stringify([
          {
            name: "existing_pattern",
            episodes: [1, 2, 3],
            failure: "Already covered",
          },
        ]),
        parsed: [
          {
            name: "existing_pattern",
            episodes: [1, 2, 3],
            failure: "Already covered",
          },
        ],
        latencyMs: 100,
        level: "standard" as const,
        provider: "claude" as const,
      } as InferenceResult;
    }
    return {
      success: true,
      output: "NONE",
      latencyMs: 50,
      level: "standard" as const,
      provider: "claude" as const,
    } as InferenceResult;
  };
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("loadEpisodes", () => {
  test("loads and filters low-rated episodes", async () => {
    const { loadEpisodes } = await import("../../src/promote/consolidator");

    const ratingsPath = join(TEST_DIR, "ratings.jsonl");
    const lines = [
      makeRatingLine(2, "bad session"),
      makeRatingLine(3, "mediocre"),
      makeRatingLine(8, "great session"),
      makeRatingLine(4, "borderline"),
    ];
    writeFileSync(ratingsPath, lines.join("\n"));

    const episodes = loadEpisodes(ratingsPath);
    expect(episodes).toHaveLength(3);
    expect(episodes.every((e) => e.rating <= 4)).toBe(true);
  });

  test("returns empty for nonexistent file", async () => {
    const { loadEpisodes } = await import("../../src/promote/consolidator");
    const episodes = loadEpisodes("/nonexistent/ratings.jsonl");
    expect(episodes).toHaveLength(0);
  });

  test("filters entries without sentiment", async () => {
    const { loadEpisodes } = await import("../../src/promote/consolidator");

    const ratingsPath = join(TEST_DIR, "ratings.jsonl");
    const lines = [
      JSON.stringify({ timestamp: new Date().toISOString(), rating: 2, source: "explicit", session_id: "s1" }),
      makeRatingLine(2, "has summary"),
    ];
    writeFileSync(ratingsPath, lines.join("\n"));

    const episodes = loadEpisodes(ratingsPath);
    expect(episodes).toHaveLength(1);
  });
});

describe("runCritiqueStep", () => {
  test("extracts patterns from episodes", async () => {
    const { runCritiqueStep, loadEpisodes } = await import("../../src/promote/consolidator");

    const ratingsPath = join(TEST_DIR, "ratings.jsonl");
    const lines = Array.from({ length: 5 }, (_, i) =>
      makeRatingLine(2, `failure episode ${i}`),
    );
    writeFileSync(ratingsPath, lines.join("\n"));

    const episodes = loadEpisodes(ratingsPath);
    const patterns = await runCritiqueStep(episodes, mockCritiqueInfer());

    expect(patterns).toHaveLength(1);
    expect(patterns[0].name).toBe("unverified_assertions");
    expect(patterns[0].episodes).toHaveLength(3);
  });

  test("filters patterns with fewer than 3 episodes", async () => {
    const { runCritiqueStep } = await import("../../src/promote/consolidator");

    const infer = async (opts: { expectJson?: boolean }) => {
      if (opts.expectJson) {
        return {
          success: true,
          output: "[]",
          parsed: [{ name: "small", episodes: [1, 2], failure: "too few" }],
          latencyMs: 50,
          level: "standard" as const,
          provider: "claude" as const,
        } as InferenceResult;
      }
      return { success: true, output: "", latencyMs: 50, level: "standard" as const, provider: "claude" as const } as InferenceResult;
    };

    const patterns = await runCritiqueStep(
      [{ timestamp: "", rating: 2, source: "explicit", sentiment_summary: "bad" }],
      infer,
    );
    expect(patterns).toHaveLength(0);
  });
});

describe("runProposeStep", () => {
  test("returns proposed rule text", async () => {
    const { runProposeStep } = await import("../../src/promote/consolidator");

    const infer = async () =>
      ({
        success: true,
        output: "Verify all claims with evidence before stating them.",
        latencyMs: 50,
        level: "standard" as const,
        provider: "claude" as const,
      }) as InferenceResult;

    const result = await runProposeStep(
      { name: "test", episodes: [1, 2, 3], failure: "test failure" },
      [],
      infer,
    );
    expect(result).toBe("Verify all claims with evidence before stating them.");
  });

  test("returns null for NONE response", async () => {
    const { runProposeStep } = await import("../../src/promote/consolidator");

    const infer = async () =>
      ({
        success: true,
        output: "NONE - already covered",
        latencyMs: 50,
        level: "standard" as const,
        provider: "claude" as const,
      }) as InferenceResult;

    const result = await runProposeStep(
      { name: "test", episodes: [1, 2, 3], failure: "covered" },
      [],
      infer,
    );
    expect(result).toBeNull();
  });
});

describe("formatPendingBlock", () => {
  test("produces markdown block", async () => {
    const { formatPendingBlock } = await import("../../src/promote/consolidator");

    const block = formatPendingBlock(
      { name: "test_pattern", episodes: [1, 2, 3], failure: "Test failure" },
      "Always verify before claiming.",
      "2026-07-07",
    );

    expect(block).toContain("## test_pattern [PROPOSED - needs review]");
    expect(block).toContain("**Proposed rule:** Always verify before claiming.");
    expect(block).toContain("**Date:** 2026-07-07");
    expect(block).toContain("3 low-rated sessions");
  });
});

describe("consolidateEpisodes", () => {
  test("full pipeline: load, critique, propose, write", async () => {
    const { consolidateEpisodes } = await import("../../src/promote/consolidator");

    const ratingsPath = join(TEST_DIR, "ratings.jsonl");
    const pendingPath = join(TEST_DIR, "PENDING-RULES.md");

    const lines = Array.from({ length: 5 }, (_, i) =>
      makeRatingLine(2, `failure ${i}`, `2026-07-0${i + 1}T00:00:00Z`),
    );
    writeFileSync(ratingsPath, lines.join("\n"));

    const result = await consolidateEpisodes(ratingsPath, pendingPath, {
      infer: mockCritiqueInfer(),
      graph: mockGraph(["existing-rule"]),
    });

    expect(result.patternsFound).toBe(1);
    expect(result.rulesProposed).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(existsSync(pendingPath)).toBe(true);

    const content = readFileSync(pendingPath, "utf-8");
    expect(content).toContain("Pending Learning Rules");
    expect(content).toContain("unverified_assertions");
  });

  test("skips duplicate pattern names", async () => {
    const { consolidateEpisodes } = await import("../../src/promote/consolidator");

    const ratingsPath = join(TEST_DIR, "ratings.jsonl");
    const pendingPath = join(TEST_DIR, "PENDING-RULES.md");

    writeFileSync(pendingPath, "## unverified_assertions [PROPOSED]\nExisting entry.\n");

    const lines = Array.from({ length: 5 }, (_, i) =>
      makeRatingLine(2, `failure ${i}`),
    );
    writeFileSync(ratingsPath, lines.join("\n"));

    const result = await consolidateEpisodes(ratingsPath, pendingPath, {
      infer: mockCritiqueInfer(),
      graph: mockGraph(),
    });

    expect(result.duplicateNames).toBe(1);
    expect(result.rulesProposed).toBe(0);
  });

  test("handles NONE responses from propose", async () => {
    const { consolidateEpisodes } = await import("../../src/promote/consolidator");

    const ratingsPath = join(TEST_DIR, "ratings.jsonl");
    const pendingPath = join(TEST_DIR, "PENDING-RULES.md");

    const lines = Array.from({ length: 5 }, (_, i) =>
      makeRatingLine(2, `failure ${i}`),
    );
    writeFileSync(ratingsPath, lines.join("\n"));

    const result = await consolidateEpisodes(ratingsPath, pendingPath, {
      infer: mockNoneInfer(),
      graph: mockGraph(),
    });

    expect(result.patternsFound).toBe(1);
    expect(result.noneCount).toBe(1);
    expect(result.rulesProposed).toBe(0);
  });

  test("dry run does not write file", async () => {
    const { consolidateEpisodes } = await import("../../src/promote/consolidator");

    const ratingsPath = join(TEST_DIR, "ratings.jsonl");
    const pendingPath = join(TEST_DIR, "PENDING-RULES.md");

    const lines = Array.from({ length: 5 }, (_, i) =>
      makeRatingLine(2, `failure ${i}`),
    );
    writeFileSync(ratingsPath, lines.join("\n"));

    const result = await consolidateEpisodes(ratingsPath, pendingPath, {
      dryRun: true,
      infer: mockCritiqueInfer(),
      graph: mockGraph(),
    });

    expect(result.rulesProposed).toBe(1);
    expect(existsSync(pendingPath)).toBe(false);
  });

  test("returns early for empty episodes", async () => {
    const { consolidateEpisodes } = await import("../../src/promote/consolidator");

    const ratingsPath = join(TEST_DIR, "ratings.jsonl");
    writeFileSync(ratingsPath, "");

    const result = await consolidateEpisodes(ratingsPath, join(TEST_DIR, "pending.md"), {
      infer: mockCritiqueInfer(),
      graph: mockGraph(),
    });

    expect(result.patternsFound).toBe(0);
    expect(result.rulesProposed).toBe(0);
  });
});
