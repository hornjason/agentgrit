import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import type { InferenceResult } from "../../src/adapters/inference";

const TEST_DIR = "/tmp/agentgrit-ctx-embed-test-" + process.pid;
const MEMORY_DIR = join(TEST_DIR, "memory");
const CACHE_PATH = join(TEST_DIR, "cache.json");

function mockInfer(prefix: string) {
  return async () =>
    ({
      success: true,
      output: prefix,
      latencyMs: 10,
      level: "fast",
      provider: "claude",
    }) as InferenceResult;
}

function failInfer() {
  return async () =>
    ({
      success: false,
      output: "",
      error: "mock failure",
      latencyMs: 0,
      level: "fast",
      provider: "claude",
    }) as InferenceResult;
}

function mockEmbed() {
  return async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]);
}

function writeMemoryFile(name: string, content: string): string {
  const path = join(MEMORY_DIR, name);
  writeFileSync(path, content);
  return path;
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(MEMORY_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("generatePrefix", () => {
  test("returns prefix from inference", async () => {
    const { generatePrefix } = await import("../../src/graph/contextual-embedder");
    const result = await generatePrefix(
      "test.md",
      "Some body text",
      mockInfer("[Category: feedback] [Topic: testing rules]"),
    );
    expect(result).toBe("[Category: feedback] [Topic: testing rules]");
  });

  test("returns null on inference failure", async () => {
    const { generatePrefix } = await import("../../src/graph/contextual-embedder");
    const result = await generatePrefix("test.md", "body", failInfer());
    expect(result).toBeNull();
  });
});

describe("processFile", () => {
  test("processes file and stores in cache", async () => {
    const { processFile } = await import("../../src/graph/contextual-embedder");

    const filePath = writeMemoryFile(
      "test-rule.md",
      "---\nname: test-rule\n---\n\nSome rule content here.",
    );

    const cache = {};
    const result = await processFile(filePath, cache, "fake-key", {
      infer: mockInfer("[Category: feedback] [Topic: test rule]"),
      embedBatch: mockEmbed(),
    });

    expect(result.skipped).toBe(false);
    expect(result.prefix).toBe("[Category: feedback] [Topic: test rule]");
    expect(result.nodeId).toBe("test-rule");
    expect(cache).toHaveProperty("contextual_embeddings");
    expect(cache).toHaveProperty("contextual_prefixes");
    expect(cache).toHaveProperty("contextual_hashes");
  });

  test("skips file when hash unchanged", async () => {
    const { processFile } = await import("../../src/graph/contextual-embedder");

    const filePath = writeMemoryFile("cached.md", "---\nname: cached\n---\n\nBody text.");

    const cache = {
      contextual_embeddings: { cached: [0.1] },
      contextual_prefixes: { cached: "[Category: test] [Topic: cached]" },
      contextual_hashes: {} as Record<string, string>,
    };

    // First, process to get the hash
    const result1 = await processFile(filePath, {}, "fake-key", {
      infer: mockInfer("[Category: test] [Topic: first]"),
      embedBatch: mockEmbed(),
    });

    // Now set the hash in cache to match
    const { createHash } = await import("crypto");
    const body = "Body text.";
    cache.contextual_hashes["cached"] = createHash("md5").update(body).digest("hex");

    const result = await processFile(filePath, cache, "fake-key", {
      infer: mockInfer("[Category: test] [Topic: should not reach]"),
      embedBatch: mockEmbed(),
    });

    expect(result.skipped).toBe(true);
  });

  test("dry run does not embed", async () => {
    const { processFile } = await import("../../src/graph/contextual-embedder");

    const filePath = writeMemoryFile("dry.md", "---\nname: dry\n---\n\nDry run content.");
    let embedCalled = false;

    const cache = {};
    const result = await processFile(filePath, cache, "fake-key", {
      dryRun: true,
      infer: mockInfer("[Category: test] [Topic: dry]"),
      embedBatch: async () => {
        embedCalled = true;
        return [[0.1]];
      },
    });

    expect(result.skipped).toBe(false);
    expect(result.prefix).toBe("[Category: test] [Topic: dry]");
    expect(embedCalled).toBe(false);
  });

  test("returns error for unreadable file", async () => {
    const { processFile } = await import("../../src/graph/contextual-embedder");

    const result = await processFile("/nonexistent/path.md", {}, "fake-key", {
      infer: mockInfer("prefix"),
      embedBatch: mockEmbed(),
    });

    expect(result.skipped).toBe(true);
    expect(result.error).toBe("Could not read file");
  });
});

describe("backfill", () => {
  test("processes all markdown files in directory", async () => {
    const { backfill } = await import("../../src/graph/contextual-embedder");

    writeMemoryFile("rule-a.md", "---\nname: rule-a\n---\n\nRule A content.");
    writeMemoryFile("rule-b.md", "---\nname: rule-b\n---\n\nRule B content.");
    writeMemoryFile("not-md.txt", "should be ignored");

    const result = await backfill(MEMORY_DIR, CACHE_PATH, "fake-key", {
      infer: mockInfer("[Category: feedback] [Topic: test]"),
      embedBatch: mockEmbed(),
    });

    expect(result.processed).toBe(2);
    expect(result.errors).toBe(0);
    expect(existsSync(CACHE_PATH)).toBe(true);

    const cache = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
    expect(Object.keys(cache.contextual_embeddings)).toHaveLength(2);
  });

  test("returns zeros for empty directory", async () => {
    const { backfill } = await import("../../src/graph/contextual-embedder");

    const emptyDir = join(TEST_DIR, "empty");
    mkdirSync(emptyDir);

    const result = await backfill(emptyDir, CACHE_PATH, "fake-key", {
      infer: mockInfer("prefix"),
      embedBatch: mockEmbed(),
    });

    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
  });
});

describe("getStats", () => {
  test("returns correct stats", async () => {
    const { getStats } = await import("../../src/graph/contextual-embedder");

    writeMemoryFile("a.md", "content a");
    writeMemoryFile("b.md", "content b");
    writeMemoryFile("c.md", "content c");

    writeFileSync(
      CACHE_PATH,
      JSON.stringify({
        contextual_embeddings: { a: [0.1], b: [0.2] },
        contextual_prefixes: { a: "prefix-a", b: "prefix-b" },
      }),
    );

    const stats = getStats(MEMORY_DIR, CACHE_PATH);
    expect(stats.memoryFileCount).toBe(3);
    expect(stats.contextualEmbeddingCount).toBe(2);
    expect(stats.contextualPrefixCount).toBe(2);
    expect(stats.coveragePercent).toBe(67);
  });

  test("handles missing directory", async () => {
    const { getStats } = await import("../../src/graph/contextual-embedder");

    const stats = getStats("/nonexistent/dir", "/nonexistent/cache.json");
    expect(stats.memoryFileCount).toBe(0);
    expect(stats.contextualEmbeddingCount).toBe(0);
    expect(stats.coveragePercent).toBe(0);
  });
});
