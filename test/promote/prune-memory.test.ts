import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, utimesSync } from "fs";
import { join } from "path";
import { pruneStaleMemories, type PruneResult } from "../../src/promote/staleness";

const TMP_DIR = join(import.meta.dir, ".tmp-prune-test");

function writeFile(path: string, content: string): void {
  writeFileSync(path, content, "utf-8");
}

function readFile(path: string): string {
  return readFileSync(path, "utf-8");
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

describe("pruneStaleMemories", () => {
  test("moves stale entry from MEMORY.md to MEMORY-ARCHIVE.md", async () => {
    // Setup: one stale file
    const staleFile = join(TMP_DIR, "old_project.md");
    writeFile(staleFile, "# Old project");
    setMtime(staleFile, 90);

    const freshFile = join(TMP_DIR, "active.md");
    writeFile(freshFile, "# Active");
    setMtime(freshFile, 5);

    const memoryPath = join(TMP_DIR, "MEMORY.md");
    const archivePath = join(TMP_DIR, "MEMORY-ARCHIVE.md");

    writeFile(memoryPath, [
      "# Memory Index",
      "",
      "## Projects",
      "- [active-project](active.md) — Active project",
      "- [old-project](old_project.md) — Old project notes",
      "",
    ].join("\n"));

    const result = await pruneStaleMemories(memoryPath, {
      archivePath,
    });

    // Stale entry was archived
    expect(result.archived).toHaveLength(1);
    expect(result.archived[0]).toContain("old-project");

    // Fresh entry was kept
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]).toContain("active-project");

    // MEMORY.md no longer contains stale line
    const memoryContent = readFile(memoryPath);
    expect(memoryContent).not.toContain("old-project");
    expect(memoryContent).toContain("active-project");

    // Archive file was created with the stale entry
    expect(existsSync(archivePath)).toBe(true);
    const archiveContent = readFile(archivePath);
    expect(archiveContent).toContain("old-project");
    expect(archiveContent).toContain("## Archived");
  });

  test("dry-run shows what would be archived without modifying files", async () => {
    const staleFile = join(TMP_DIR, "stale.md");
    writeFile(staleFile, "# Stale");
    setMtime(staleFile, 100);

    const memoryPath = join(TMP_DIR, "MEMORY.md");
    const archivePath = join(TMP_DIR, "MEMORY-ARCHIVE.md");

    const originalContent = [
      "# Memory Index",
      "",
      "- [stale-entry](stale.md) — Stale content",
      "",
    ].join("\n");
    writeFile(memoryPath, originalContent);

    const result = await pruneStaleMemories(memoryPath, {
      archivePath,
      dryRun: true,
    });

    // Reports what would be archived
    expect(result.archived).toHaveLength(1);
    expect(result.archived[0]).toContain("stale-entry");

    // MEMORY.md unchanged
    expect(readFile(memoryPath)).toBe(originalContent);

    // No archive file created
    expect(existsSync(archivePath)).toBe(false);
  });

  test("archive file is created with timestamp header", async () => {
    const staleFile = join(TMP_DIR, "old.md");
    writeFile(staleFile, "# Old");
    setMtime(staleFile, 70);

    const memoryPath = join(TMP_DIR, "MEMORY.md");
    const archivePath = join(TMP_DIR, "MEMORY-ARCHIVE.md");

    writeFile(memoryPath, [
      "# Memory",
      "",
      "- [old-entry](old.md) — Old content",
      "",
    ].join("\n"));

    await pruneStaleMemories(memoryPath, { archivePath });

    const archive = readFile(archivePath);
    // Should have date header in format ## Archived YYYY-MM-DD
    expect(archive).toMatch(/## Archived \d{4}-\d{2}-\d{2}/);
    expect(archive).toContain("old-entry");
  });

  test("appends to existing archive file", async () => {
    const staleFile = join(TMP_DIR, "newer_stale.md");
    writeFile(staleFile, "# Newer stale");
    setMtime(staleFile, 80);

    const memoryPath = join(TMP_DIR, "MEMORY.md");
    const archivePath = join(TMP_DIR, "MEMORY-ARCHIVE.md");

    // Pre-existing archive
    writeFile(archivePath, [
      "# Memory Archive",
      "",
      "## Archived 2026-01-01",
      "- [old-archived](old.md) — Previously archived",
      "",
    ].join("\n"));

    writeFile(memoryPath, [
      "# Memory",
      "",
      "- [newer-stale](newer_stale.md) — Newer stale entry",
      "",
    ].join("\n"));

    await pruneStaleMemories(memoryPath, { archivePath });

    const archive = readFile(archivePath);
    // Both old and new entries present
    expect(archive).toContain("old-archived");
    expect(archive).toContain("newer-stale");
  });

  test("missing file entries are also pruned", async () => {
    const memoryPath = join(TMP_DIR, "MEMORY.md");
    const archivePath = join(TMP_DIR, "MEMORY-ARCHIVE.md");

    writeFile(memoryPath, [
      "# Memory",
      "",
      "- [gone-entry](nonexistent.md) — File was deleted",
      "",
    ].join("\n"));

    const result = await pruneStaleMemories(memoryPath, { archivePath });

    expect(result.archived).toHaveLength(1);
    expect(result.archived[0]).toContain("gone-entry");

    const memory = readFile(memoryPath);
    expect(memory).not.toContain("gone-entry");
  });

  test("returns empty archived when no stale entries", async () => {
    const freshFile = join(TMP_DIR, "fresh.md");
    writeFile(freshFile, "# Fresh");
    setMtime(freshFile, 5);

    const memoryPath = join(TMP_DIR, "MEMORY.md");
    const archivePath = join(TMP_DIR, "MEMORY-ARCHIVE.md");

    writeFile(memoryPath, [
      "# Memory",
      "",
      "- [fresh-entry](fresh.md) — Recent content",
      "",
    ].join("\n"));

    const result = await pruneStaleMemories(memoryPath, { archivePath });

    expect(result.archived).toHaveLength(0);
    expect(result.kept).toHaveLength(1);
    expect(existsSync(archivePath)).toBe(false);
  });

  test("custom threshold respected", async () => {
    const file = join(TMP_DIR, "medium.md");
    writeFile(file, "# Medium");
    setMtime(file, 35); // 35 days old

    const memoryPath = join(TMP_DIR, "MEMORY.md");
    const archivePath = join(TMP_DIR, "MEMORY-ARCHIVE.md");

    writeFile(memoryPath, "# Memory\n\n- [medium-entry](medium.md) — Medium age\n");

    // At default 60 threshold: not stale
    const r1 = await pruneStaleMemories(memoryPath, { archivePath, dryRun: true });
    expect(r1.archived).toHaveLength(0);

    // At 30 threshold: stale
    const r2 = await pruneStaleMemories(memoryPath, {
      archivePath,
      dryRun: true,
      threshold: 30,
    });
    expect(r2.archived).toHaveLength(1);
  });
});
