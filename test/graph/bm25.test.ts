import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { buildIndex, buildIndexFromDir, searchIndex, tokenize } from "../../src/graph/bm25";

const TMP_DIR = join(import.meta.dir, ".tmp-bm25-test");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

function writeDoc(filename: string, content: string): string {
  const path = join(TMP_DIR, filename);
  writeFileSync(path, content, "utf-8");
  return path;
}

describe("tokenize", () => {
  test("lowercases and splits on whitespace", () => {
    const tokens = tokenize("Hello World Test");
    expect(tokens).toEqual(["hello", "world", "test"]);
  });

  test("removes punctuation", () => {
    const tokens = tokenize("don't, stop! (please)");
    expect(tokens).toContain("don");
    expect(tokens).toContain("stop");
    expect(tokens).toContain("please");
  });

  test("filters tokens shorter than 2 chars", () => {
    const tokens = tokenize("a bb ccc d ee");
    expect(tokens).toEqual(["bb", "ccc", "ee"]);
  });

  test("handles empty string", () => {
    expect(tokenize("")).toEqual([]);
  });
});

describe("buildIndex", () => {
  test("builds index from file list", () => {
    const f1 = writeDoc("rule_a.md", `---
name: rule-a
---
Always verify state before deploying to production.`);

    const f2 = writeDoc("rule_b.md", `---
name: rule-b
---
Deploy after testing.`);

    const index = buildIndex([f1, f2]);

    expect(index.docCount).toBe(2);
    expect(index.avgDocLen).toBeGreaterThan(0);
    expect(Object.keys(index.vocabulary).length).toBeGreaterThan(0);
    expect(index.vocabulary["verify"]).toBeDefined();
    expect(index.vocabulary["deploy"]).toBeDefined();
  });

  test("handles empty file list", () => {
    const index = buildIndex([]);
    expect(index.docCount).toBe(0);
    expect(index.avgDocLen).toBe(0);
  });

  test("skips non-existent files", () => {
    const f1 = writeDoc("exists.md", "some content here");
    const index = buildIndex([f1, "/nonexistent/file.md"]);
    expect(index.docCount).toBe(1);
  });

  test("strips frontmatter before indexing", () => {
    const f1 = writeDoc("doc.md", `---
name: test-rule
description: metadata here
---
The actual rule body text.`);

    const index = buildIndex([f1]);
    expect(index.vocabulary["name"]).toBeUndefined();
    expect(index.vocabulary["test-rule"]).toBeUndefined();
    expect(index.vocabulary["actual"]).toBeDefined();
    expect(index.vocabulary["rule"]).toBeDefined();
  });

  test("computes IDF correctly", () => {
    const f1 = writeDoc("a.md", "verify verify verify");
    const f2 = writeDoc("b.md", "deploy deploy deploy");
    const f3 = writeDoc("c.md", "verify deploy both");

    const index = buildIndex([f1, f2, f3]);

    // "verify" appears in 2/3 docs, "deploy" in 2/3 — same IDF
    expect(index.vocabulary["verify"].df).toBe(2);
    expect(index.vocabulary["deploy"].df).toBe(2);
    expect(index.vocabulary["verify"].idf).toBeCloseTo(index.vocabulary["deploy"].idf);
  });
});

describe("buildIndexFromDir", () => {
  test("builds from directory of .md files", () => {
    writeDoc("rule_one.md", "deploy containers");
    writeDoc("rule_two.md", "verify endpoints");
    writeDoc("not_md.txt", "ignored file");

    const index = buildIndexFromDir(TMP_DIR);
    expect(index.docCount).toBe(2);
  });

  test("handles non-existent directory", () => {
    const index = buildIndexFromDir("/nonexistent/dir");
    expect(index.docCount).toBe(0);
  });
});

describe("searchIndex", () => {
  test("returns scored results for matching query", () => {
    const f1 = writeDoc("deploy_rule.md", "always run make rebuild before deploying to production environment");
    const f2 = writeDoc("verify_rule.md", "verify all endpoints are healthy before claiming done");
    const f3 = writeDoc("scope_rule.md", "keep scope minimal and stay focused");

    const index = buildIndex([f1, f2, f3]);
    const results = searchIndex(index, "deploy production");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe("deploy_rule");
    expect(results[0].score).toBeGreaterThan(0);
  });

  test("returns empty for no match", () => {
    const f1 = writeDoc("rule.md", "verify endpoints");
    const index = buildIndex([f1]);
    const results = searchIndex(index, "xyzzy foobarbaz");
    expect(results).toEqual([]);
  });

  test("returns empty for empty query", () => {
    const f1 = writeDoc("rule.md", "some content");
    const index = buildIndex([f1]);
    expect(searchIndex(index, "")).toEqual([]);
  });

  test("respects limit", () => {
    const files = Array.from({ length: 10 }, (_, i) => {
      return writeDoc(`rule_${i}.md`, `deploy production environment ${i}`);
    });

    const index = buildIndex(files);
    const results = searchIndex(index, "deploy production", 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  test("ranks by relevance", () => {
    const f1 = writeDoc("high.md", "deploy deploy deploy production production");
    const f2 = writeDoc("low.md", "deploy once to staging");

    const index = buildIndex([f1, f2]);
    const results = searchIndex(index, "deploy production");

    expect(results.length).toBe(2);
    expect(results[0].id).toBe("high");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });
});
