import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { expirePendingRules } from "../../src/promote/evict";

const TMP_DIR = join(import.meta.dir, ".tmp-pending-expiry-test");
const PENDING_MD = join(TMP_DIR, "PENDING-RULES.md");

function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function makePendingMd(
  entries: Array<{ status: string; date: string; slug: string; body?: string }>,
): string {
  const header = `# Pending Learning Rules\n\nAuto-generated.\n\n`;
  const sections = entries.map(
    (e) =>
      `## [${e.status} - ${e.date}] ${e.slug}\n\n**Source:** /debrief\n**Session context:** Test context\n**Proposed rule:** ${e.body ?? "Some rule text."}\n`,
  );
  return header + sections.join("\n");
}

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

describe("expirePendingRules", () => {
  test("expires entries older than maxAgeDays", () => {
    const content = makePendingMd([
      { status: "PROPOSED", date: daysAgo(45), slug: "old-rule" },
      { status: "PROPOSED", date: daysAgo(10), slug: "recent-rule" },
      { status: "PROMOTED", date: daysAgo(60), slug: "ancient-promoted" },
    ]);
    writeFileSync(PENDING_MD, content);

    const result = expirePendingRules(PENDING_MD, 30);

    expect(result.expired).toHaveLength(2);
    expect(result.expired.map((e) => e.slug)).toContain("old-rule");
    expect(result.expired.map((e) => e.slug)).toContain("ancient-promoted");
    expect(result.kept).toBe(1);
    expect(result.total).toBe(3);

    const remaining = readFileSync(PENDING_MD, "utf-8");
    expect(remaining).toContain("recent-rule");
    expect(remaining).not.toContain("old-rule");
    expect(remaining).not.toContain("ancient-promoted");
  });

  test("no-op when all entries are recent", () => {
    const content = makePendingMd([
      { status: "PROPOSED", date: daysAgo(5), slug: "fresh-1" },
      { status: "PROPOSED", date: daysAgo(10), slug: "fresh-2" },
    ]);
    writeFileSync(PENDING_MD, content);

    const result = expirePendingRules(PENDING_MD, 30);

    expect(result.expired).toHaveLength(0);
    expect(result.kept).toBe(2);

    const remaining = readFileSync(PENDING_MD, "utf-8");
    expect(remaining).toContain("fresh-1");
    expect(remaining).toContain("fresh-2");
  });

  test("handles missing file", () => {
    const result = expirePendingRules("/nonexistent/path.md", 30);
    expect(result.expired).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  test("expires all entries when all are old", () => {
    const content = makePendingMd([
      { status: "PROPOSED", date: daysAgo(90), slug: "old-1" },
      { status: "PROMOTED", date: daysAgo(60), slug: "old-2" },
    ]);
    writeFileSync(PENDING_MD, content);

    const result = expirePendingRules(PENDING_MD, 30);

    expect(result.expired).toHaveLength(2);
    expect(result.kept).toBe(0);
  });

  test("respects custom maxAgeDays", () => {
    const content = makePendingMd([
      { status: "PROPOSED", date: daysAgo(8), slug: "just-outside" },
      { status: "PROPOSED", date: daysAgo(5), slug: "just-inside" },
    ]);
    writeFileSync(PENDING_MD, content);

    const result = expirePendingRules(PENDING_MD, 7);

    expect(result.expired).toHaveLength(1);
    expect(result.expired[0].slug).toBe("just-outside");
    expect(result.kept).toBe(1);
  });

  test("preserves non-section content (headers, preamble)", () => {
    const content = makePendingMd([
      { status: "PROPOSED", date: daysAgo(45), slug: "expired-rule" },
    ]);
    writeFileSync(PENDING_MD, content);

    const result = expirePendingRules(PENDING_MD, 30);

    expect(result.expired).toHaveLength(1);
    const remaining = readFileSync(PENDING_MD, "utf-8");
    expect(remaining).toContain("# Pending Learning Rules");
    expect(remaining).toContain("Auto-generated.");
  });

  test("cleans up consecutive blank lines after removal", () => {
    const content = makePendingMd([
      { status: "PROPOSED", date: daysAgo(45), slug: "old-rule" },
      { status: "PROPOSED", date: daysAgo(5), slug: "new-rule" },
    ]);
    writeFileSync(PENDING_MD, content);

    expirePendingRules(PENDING_MD, 30);

    const remaining = readFileSync(PENDING_MD, "utf-8");
    expect(remaining).not.toMatch(/\n\n\n/);
  });

  test("ageDays in result is rounded", () => {
    const content = makePendingMd([
      { status: "PROPOSED", date: daysAgo(45), slug: "old-rule" },
    ]);
    writeFileSync(PENDING_MD, content);

    const result = expirePendingRules(PENDING_MD, 30);
    expect(Number.isInteger(result.expired[0].ageDays)).toBe(true);
  });
});
