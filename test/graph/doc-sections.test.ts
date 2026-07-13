import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import {
  splitDocSections,
  buildDocSectionCache,
  loadDocSectionCache,
  retrieveRelevantSections,
} from "../../src/graph/doc-sections";
import type { EmbeddingProvider } from "../../src/adapters/types";

const TMP_DIR = join(import.meta.dir, ".tmp-doc-sections-test");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

const SAMPLE_DOC = `# Top Title

Intro text before first section.

## Section One

Content for section one.
More content here.

## Section Two

Content for section two.
With multiple lines.
And even more.

## Section Three

Short section.
`;

describe("splitDocSections", () => {
  test("splits by ## headings", () => {
    const sections = splitDocSections(SAMPLE_DOC, "/test/doc.md");
    expect(sections.length).toBe(3);
    expect(sections[0].heading).toBe("Section One");
    expect(sections[1].heading).toBe("Section Two");
    expect(sections[2].heading).toBe("Section Three");
  });

  test("captures content between headings", () => {
    const sections = splitDocSections(SAMPLE_DOC, "/test/doc.md");
    expect(sections[0].content).toContain("Content for section one");
    expect(sections[1].content).toContain("multiple lines");
  });

  test("records sourcePath and line positions", () => {
    const sections = splitDocSections(SAMPLE_DOC, "/path/to/doc.md");
    expect(sections[0].sourcePath).toBe("/path/to/doc.md");
    expect(sections[0].lineStart).toBeGreaterThan(0);
    expect(sections[0].lineCount).toBeGreaterThan(0);
  });

  test("ignores content before first ## heading", () => {
    const sections = splitDocSections(SAMPLE_DOC, "/test/doc.md");
    for (const s of sections) {
      expect(s.content).not.toContain("Intro text before first section");
    }
  });

  test("returns empty array for doc with no ## headings", () => {
    const sections = splitDocSections("# Only h1\nSome content\n", "/test/doc.md");
    expect(sections.length).toBe(0);
  });

  test("handles ### subheadings as content within ## sections", () => {
    const doc = `## Main Section\n\nIntro.\n\n### Sub Section\n\nSub content.\n`;
    const sections = splitDocSections(doc, "/test/doc.md");
    expect(sections.length).toBe(1);
    expect(sections[0].content).toContain("### Sub Section");
    expect(sections[0].content).toContain("Sub content");
  });
});

// Mock embedding provider that returns deterministic vectors
function mockProvider(dim: number = 4): EmbeddingProvider {
  let callCount = 0;
  return {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text, i) => {
        callCount++;
        const vec = new Array(dim).fill(0);
        // Make vectors slightly different based on text hash
        const hash = text.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
        vec[0] = Math.sin(hash + callCount);
        vec[1] = Math.cos(hash + callCount);
        vec[2] = Math.sin(hash * 2 + callCount);
        vec[3] = Math.cos(hash * 2 + callCount);
        return vec;
      });
    },
  };
}

describe("buildDocSectionCache", () => {
  test("builds cache from doc files", async () => {
    const docPath = join(TMP_DIR, "test.md");
    writeFileSync(docPath, SAMPLE_DOC, "utf-8");
    const cachePath = join(TMP_DIR, "cache.json");

    const cache = await buildDocSectionCache([docPath], mockProvider(), cachePath);

    expect(cache.sections.length).toBe(3);
    expect(cache.model).toBe("local");
    expect(cache.builtAt).toBeTruthy();
    for (const s of cache.sections) {
      expect(s.vector.length).toBe(4);
    }
  });

  test("writes cache file to disk", async () => {
    const docPath = join(TMP_DIR, "test.md");
    writeFileSync(docPath, SAMPLE_DOC, "utf-8");
    const cachePath = join(TMP_DIR, "cache.json");

    await buildDocSectionCache([docPath], mockProvider(), cachePath);

    expect(existsSync(cachePath)).toBe(true);
    const raw = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(raw.sections.length).toBe(3);
  });

  test("skips missing doc files", async () => {
    const cachePath = join(TMP_DIR, "cache.json");
    const cache = await buildDocSectionCache(
      ["/nonexistent/doc.md"],
      mockProvider(),
      cachePath,
    );
    expect(cache.sections.length).toBe(0);
  });

  test("merges sections from multiple docs", async () => {
    const doc1 = join(TMP_DIR, "a.md");
    const doc2 = join(TMP_DIR, "b.md");
    writeFileSync(doc1, "## A1\nContent A1\n## A2\nContent A2\n", "utf-8");
    writeFileSync(doc2, "## B1\nContent B1\n", "utf-8");
    const cachePath = join(TMP_DIR, "cache.json");

    const cache = await buildDocSectionCache([doc1, doc2], mockProvider(), cachePath);
    expect(cache.sections.length).toBe(3);
    expect(cache.sections.map(s => s.heading)).toEqual(["A1", "A2", "B1"]);
  });
});

describe("loadDocSectionCache", () => {
  test("returns null when file missing", () => {
    expect(loadDocSectionCache("/nonexistent/cache.json")).toBeNull();
  });

  test("returns null on malformed JSON", () => {
    const p = join(TMP_DIR, "bad.json");
    writeFileSync(p, "not json", "utf-8");
    expect(loadDocSectionCache(p)).toBeNull();
  });

  test("returns null when sections field missing", () => {
    const p = join(TMP_DIR, "bad.json");
    writeFileSync(p, JSON.stringify({ model: "x" }), "utf-8");
    expect(loadDocSectionCache(p)).toBeNull();
  });

  test("loads valid cache", async () => {
    const docPath = join(TMP_DIR, "test.md");
    writeFileSync(docPath, SAMPLE_DOC, "utf-8");
    const cachePath = join(TMP_DIR, "cache.json");
    await buildDocSectionCache([docPath], mockProvider(), cachePath);

    const loaded = loadDocSectionCache(cachePath);
    expect(loaded).not.toBeNull();
    expect(loaded!.sections.length).toBe(3);
  });
});

describe("retrieveRelevantSections", () => {
  test("returns top-K sections sorted by similarity", async () => {
    const docPath = join(TMP_DIR, "test.md");
    writeFileSync(docPath, SAMPLE_DOC, "utf-8");
    const cachePath = join(TMP_DIR, "cache.json");
    const cache = await buildDocSectionCache([docPath], mockProvider(), cachePath);

    // Use a query vector that will have varying similarity to sections
    const queryVec = [1, 0, 0, 0];
    const results = retrieveRelevantSections(queryVec, cache, 2);

    expect(results.length).toBe(2);
    // Results should not include vector field
    for (const r of results) {
      expect(r).not.toHaveProperty("vector");
      expect(r.heading).toBeTruthy();
      expect(r.content).toBeTruthy();
    }
  });

  test("returns fewer than topK if cache has fewer sections", async () => {
    const docPath = join(TMP_DIR, "small.md");
    writeFileSync(docPath, "## Only Section\nContent\n", "utf-8");
    const cachePath = join(TMP_DIR, "cache.json");
    const cache = await buildDocSectionCache([docPath], mockProvider(), cachePath);

    const results = retrieveRelevantSections([1, 0, 0, 0], cache, 5);
    expect(results.length).toBe(1);
  });

  test("returns empty array for empty cache", () => {
    const emptyCache: import("../../src/graph/doc-sections").DocSectionCache = {
      sections: [],
      builtAt: new Date().toISOString(),
      model: "local",
    };
    const results = retrieveRelevantSections([1, 0, 0, 0], emptyCache, 5);
    expect(results.length).toBe(0);
  });

  test("returns subset of sections from large doc", async () => {
    // Simulate a large doc with many sections
    const lines = [];
    for (let i = 0; i < 20; i++) {
      lines.push(`## Section ${i}`);
      lines.push(`Content for section ${i} with some details about topic ${i}.`);
      lines.push("");
    }
    const docPath = join(TMP_DIR, "large.md");
    writeFileSync(docPath, lines.join("\n"), "utf-8");
    const cachePath = join(TMP_DIR, "cache.json");
    const cache = await buildDocSectionCache([docPath], mockProvider(), cachePath);

    expect(cache.sections.length).toBe(20);
    const results = retrieveRelevantSections([1, 0, 0, 0], cache, 5);
    expect(results.length).toBe(5);
    expect(results.length).toBeLessThan(cache.sections.length);
  });
});
