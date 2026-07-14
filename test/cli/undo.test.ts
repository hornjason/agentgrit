import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, ".tmp-undo-test");

function writeLedger(records: object[]): void {
  const content = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(join(TEST_DIR, "state", "promotions.jsonl"), content);
}

function sampleRecord(id: string) {
  return {
    ruleId: id,
    tier: "learned",
    timestamp: new Date().toISOString(),
    source: "test",
  };
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, "state"), { recursive: true });
  process.env.AGENTGRIT_DIR = TEST_DIR;
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

describe("undo command", () => {
  test("--yes flag is parsed correctly when placed after count", async () => {
    writeLedger([sampleRecord("rule-a"), sampleRecord("rule-b")]);
    const { undoCommand } = await import("../../bin/commands/undo");
    // "undo 1 --yes" should execute without prompting
    await undoCommand(["1", "--yes"]);
    // ledger should have 1 record remaining
    const { getPromotionHistory } = await import("../../src/promote/ledger");
    const remaining = getPromotionHistory(join(TEST_DIR, "state"));
    expect(remaining.length).toBe(1);
    expect(remaining[0].ruleId).toBe("rule-a");
  });

  test("--yes flag works without explicit count (defaults to 1)", async () => {
    writeLedger([sampleRecord("rule-a"), sampleRecord("rule-b")]);
    const { undoCommand } = await import("../../bin/commands/undo");
    await undoCommand(["--yes"]);
    const { getPromotionHistory } = await import("../../src/promote/ledger");
    const remaining = getPromotionHistory(join(TEST_DIR, "state"));
    expect(remaining.length).toBe(1);
    expect(remaining[0].ruleId).toBe("rule-a");
  });

  test("dry run without --yes prints confirmation prompt", async () => {
    writeLedger([sampleRecord("rule-a")]);
    const { undoCommand } = await import("../../bin/commands/undo");
    // Should return without undoing (dry run)
    await undoCommand(["1"]);
    const { getPromotionHistory } = await import("../../src/promote/ledger");
    const remaining = getPromotionHistory(join(TEST_DIR, "state"));
    expect(remaining.length).toBe(1);
  });
});
