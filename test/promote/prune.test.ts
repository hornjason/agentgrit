import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { pruneTobudget } from "../../src/promote/prune";
import { Tier } from "../../src/adapters/types";

const TMP_DIR = join(import.meta.dir, ".tmp-prune-test");
const CLAUDE_MD = join(TMP_DIR, "CLAUDE.md");
const STATE_DIR = join(TMP_DIR, "state");

function makeClaudeMd(ruleCount: number): string {
  const rules = Array.from({ length: ruleCount }, (_, i) => {
    const id = `rule-${i}`;
    return `- **${id}:** Rule number ${i}`;
  });
  return `# Config\n\n### Rules\n\n${rules.join("\n")}\n\n---\n\n## Other\n`;
}

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

describe("pruneTobudget", () => {
  test("returns early when not over budget", async () => {
    await Bun.write(CLAUDE_MD, makeClaudeMd(5));
    const result = await pruneTobudget(CLAUDE_MD, Tier.Global);
    expect(result.wasOverBudget).toBe(false);
    expect(result.removed).toHaveLength(0);
    expect(result.remaining).toBe(5);
  });

  test("removes weakest rules until under budget", async () => {
    await Bun.write(CLAUDE_MD, makeClaudeMd(30));
    const result = await pruneTobudget(CLAUDE_MD, Tier.Global, {
      stateDir: STATE_DIR,
    });
    expect(result.wasOverBudget).toBe(true);
    expect(result.removed.length).toBeGreaterThan(0);
    expect(result.remaining).toBeLessThanOrEqual(25);

    const content = readFileSync(CLAUDE_MD, "utf-8");
    for (const id of result.removed) {
      expect(content).not.toContain(`- **${id}:**`);
    }
  });

  test("dry run does not modify the file", async () => {
    await Bun.write(CLAUDE_MD, makeClaudeMd(30));
    const before = readFileSync(CLAUDE_MD, "utf-8");

    const result = await pruneTobudget(CLAUDE_MD, Tier.Global, {
      dryRun: true,
    });

    expect(result.wasOverBudget).toBe(true);
    expect(result.removed.length).toBeGreaterThan(0);

    const after = readFileSync(CLAUDE_MD, "utf-8");
    expect(after).toBe(before);
  });

  test("respects maxPrune limit", async () => {
    await Bun.write(CLAUDE_MD, makeClaudeMd(30));
    const result = await pruneTobudget(CLAUDE_MD, Tier.Global, {
      maxPrune: 2,
      stateDir: STATE_DIR,
    });
    expect(result.removed.length).toBeLessThanOrEqual(2);
  });

  test("records removals in ledger when stateDir provided", async () => {
    await Bun.write(CLAUDE_MD, makeClaudeMd(30));
    await pruneTobudget(CLAUDE_MD, Tier.Global, { stateDir: STATE_DIR });

    const ledgerPath = join(STATE_DIR, "promotions.jsonl");
    expect(existsSync(ledgerPath)).toBe(true);

    const lines = readFileSync(ledgerPath, "utf-8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);

    const record = JSON.parse(lines[0]);
    expect(record.tier).toBe(Tier.Global);
    expect(record.approved).toBe(true);
  });
});
