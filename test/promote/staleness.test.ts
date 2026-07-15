import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "fs";
import { join } from "path";
import { detectStaleMemories, type StaleEntry } from "../../src/promote/staleness";

const TMP_DIR = join(import.meta.dir, ".tmp-staleness-test");

function writeFile(path: string, content: string): void {
  writeFileSync(path, content, "utf-8");
}

function setMtime(path: string, daysAgo: number): void {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  utimesSync(path, date, date);
}

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

describe("detectStaleMemories", () => {
  test("fresh linked file is NOT flagged as stale", async () => {
    const linkedFile = join(TMP_DIR, "project_active.md");
    writeFile(linkedFile, "# Active project");
    setMtime(linkedFile, 10); // 10 days ago — well within 60-day threshold

    const memoryMd = join(TMP_DIR, "MEMORY.md");
    writeFile(memoryMd, `# Memory\n\n- [active-project](project_active.md) — Active project notes\n`);

    const result = await detectStaleMemories(memoryMd);
    expect(result).toHaveLength(0);
  });

  test("stale linked file IS flagged (>= 60 days old)", async () => {
    const linkedFile = join(TMP_DIR, "old_project.md");
    writeFile(linkedFile, "# Old project");
    setMtime(linkedFile, 90); // 90 days ago — stale

    const memoryMd = join(TMP_DIR, "MEMORY.md");
    writeFile(memoryMd, `# Memory\n\n- [old-project](old_project.md) — Stale project notes\n`);

    const result = await detectStaleMemories(memoryMd);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("old-project");
    expect(result[0].filePath).toContain("old_project.md");
    expect(result[0].daysStale).toBeGreaterThanOrEqual(60);
    expect(result[0].status).toBe("stale");
  });

  test("missing linked file IS flagged", async () => {
    const memoryMd = join(TMP_DIR, "MEMORY.md");
    writeFile(memoryMd, `# Memory\n\n- [gone-project](nonexistent.md) — This file was deleted\n`);

    const result = await detectStaleMemories(memoryMd);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("gone-project");
    expect(result[0].status).toBe("missing");
  });

  test("mixed: fresh, stale, and missing entries", async () => {
    const freshFile = join(TMP_DIR, "fresh.md");
    writeFile(freshFile, "# Fresh");
    setMtime(freshFile, 5);

    const staleFile = join(TMP_DIR, "stale.md");
    writeFile(staleFile, "# Stale");
    setMtime(staleFile, 120);

    // missing file: no write

    const memoryMd = join(TMP_DIR, "MEMORY.md");
    writeFile(memoryMd, [
      "# Memory Index",
      "",
      "## Section A",
      "- [fresh-entry](fresh.md) — Fresh content",
      "- [stale-entry](stale.md) — Stale content",
      "- [missing-entry](gone.md) — Missing file",
      "",
    ].join("\n"));

    const result = await detectStaleMemories(memoryMd);
    // Only stale and missing should appear
    expect(result).toHaveLength(2);

    const staleResult = result.find((e) => e.name === "stale-entry");
    expect(staleResult).toBeDefined();
    expect(staleResult!.status).toBe("stale");
    expect(staleResult!.daysStale).toBeGreaterThanOrEqual(60);

    const missingResult = result.find((e) => e.name === "missing-entry");
    expect(missingResult).toBeDefined();
    expect(missingResult!.status).toBe("missing");
  });

  test("custom threshold overrides default 60 days", async () => {
    const linkedFile = join(TMP_DIR, "medium_age.md");
    writeFile(linkedFile, "# Medium age");
    setMtime(linkedFile, 35); // 35 days — stale at 30-day threshold, not at 60

    const memoryMd = join(TMP_DIR, "MEMORY.md");
    writeFile(memoryMd, `# Memory\n\n- [medium](medium_age.md) — Medium age file\n`);

    const resultDefault = await detectStaleMemories(memoryMd);
    expect(resultDefault).toHaveLength(0); // Not stale at 60 days

    const resultCustom = await detectStaleMemories(memoryMd, { thresholdDays: 30 });
    expect(resultCustom).toHaveLength(1); // Stale at 30 days
  });

  test("handles relative paths with subdirectories", async () => {
    const subDir = join(TMP_DIR, "sub");
    mkdirSync(subDir, { recursive: true });
    const linkedFile = join(subDir, "deep.md");
    writeFile(linkedFile, "# Deep file");
    setMtime(linkedFile, 100);

    const memoryMd = join(TMP_DIR, "MEMORY.md");
    writeFile(memoryMd, `# Memory\n\n- [deep-entry](sub/deep.md) — Nested file\n`);

    const result = await detectStaleMemories(memoryMd);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("deep-entry");
  });

  test("handles parent-relative paths (../)", async () => {
    const parentFile = join(TMP_DIR, "..", "parent_file.md");
    writeFile(parentFile, "# Parent");
    setMtime(parentFile, 80);

    const subDir = join(TMP_DIR, "sub");
    mkdirSync(subDir, { recursive: true });
    const memoryMd = join(subDir, "MEMORY.md");
    writeFile(memoryMd, `# Memory\n\n- [parent-entry](../../parent_file.md) — Parent-relative\n`);

    const result = await detectStaleMemories(memoryMd);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("parent-entry");

    // Cleanup parent file
    if (existsSync(parentFile)) rmSync(parentFile);
  });

  test("ignores non-md links and bare text", async () => {
    const memoryMd = join(TMP_DIR, "MEMORY.md");
    writeFile(memoryMd, [
      "# Memory",
      "",
      "## Notes",
      "- Just some text with no link",
      "- [external](https://example.com) — URL link",
      "",
    ].join("\n"));

    const result = await detectStaleMemories(memoryMd);
    expect(result).toHaveLength(0);
  });
});
