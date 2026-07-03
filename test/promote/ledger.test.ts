import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import {
  recordPromotion,
  getPromotionHistory,
  undoPromotions,
} from "../../src/promote/ledger";
import { Tier, type PromotionRecord } from "../../src/adapters/types";

const TMP_DIR = join(import.meta.dir, ".tmp-ledger-test");

function makeRecord(
  id: string,
  ruleId: string,
  overrides: Partial<PromotionRecord> = {},
): PromotionRecord {
  return {
    id,
    ruleId,
    tier: Tier.Global,
    timestamp: new Date().toISOString(),
    beforeSnapshot: "before content",
    afterSnapshot: "after content",
    approved: true,
    ...overrides,
  };
}

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

describe("recordPromotion", () => {
  test("creates ledger file and records entry", async () => {
    await recordPromotion(makeRecord("p1", "r1"), TMP_DIR);
    const path = join(TMP_DIR, "promotions.jsonl");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain('"id":"p1"');
  });

  test("appends multiple entries", async () => {
    await recordPromotion(makeRecord("p1", "r1"), TMP_DIR);
    await recordPromotion(makeRecord("p2", "r2"), TMP_DIR);
    const history = getPromotionHistory(TMP_DIR);
    expect(history).toHaveLength(2);
    expect(history[0].id).toBe("p1");
    expect(history[1].id).toBe("p2");
  });

  test("creates state directory if missing", async () => {
    const nested = join(TMP_DIR, "deep", "nested");
    await recordPromotion(makeRecord("p1", "r1"), nested);
    expect(existsSync(join(nested, "promotions.jsonl"))).toBe(true);
  });
});

describe("getPromotionHistory", () => {
  test("returns empty array when no ledger exists", () => {
    const history = getPromotionHistory(join(TMP_DIR, "nonexistent"));
    expect(history).toEqual([]);
  });

  test("reads all records from ledger", async () => {
    await recordPromotion(makeRecord("p1", "r1"), TMP_DIR);
    await recordPromotion(makeRecord("p2", "r2"), TMP_DIR);
    await recordPromotion(makeRecord("p3", "r3"), TMP_DIR);
    const history = getPromotionHistory(TMP_DIR);
    expect(history).toHaveLength(3);
  });

  test("skips malformed lines", async () => {
    const path = join(TMP_DIR, "promotions.jsonl");
    const valid = JSON.stringify(makeRecord("p1", "r1"));
    await Bun.write(path, valid + "\nnot-json\n" + JSON.stringify(makeRecord("p2", "r2")) + "\n");
    const history = getPromotionHistory(TMP_DIR);
    expect(history).toHaveLength(2);
  });
});

describe("undoPromotions", () => {
  test("removes last N entries and returns them", async () => {
    await recordPromotion(makeRecord("p1", "r1"), TMP_DIR);
    await recordPromotion(makeRecord("p2", "r2"), TMP_DIR);
    await recordPromotion(makeRecord("p3", "r3"), TMP_DIR);

    const undone = await undoPromotions(2, TMP_DIR);
    expect(undone).toHaveLength(2);
    expect(undone[0].id).toBe("p2");
    expect(undone[1].id).toBe("p3");

    const remaining = getPromotionHistory(TMP_DIR);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("p1");
  });

  test("undo restores previous state", async () => {
    await recordPromotion(makeRecord("p1", "r1"), TMP_DIR);
    await recordPromotion(makeRecord("p2", "r2"), TMP_DIR);

    await undoPromotions(1, TMP_DIR);
    const history = getPromotionHistory(TMP_DIR);
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe("p1");
  });

  test("undo all entries leaves empty ledger", async () => {
    await recordPromotion(makeRecord("p1", "r1"), TMP_DIR);
    await recordPromotion(makeRecord("p2", "r2"), TMP_DIR);

    const undone = await undoPromotions(5, TMP_DIR);
    expect(undone).toHaveLength(2);

    const remaining = getPromotionHistory(TMP_DIR);
    expect(remaining).toHaveLength(0);
  });

  test("undo with count 0 returns empty array", async () => {
    await recordPromotion(makeRecord("p1", "r1"), TMP_DIR);
    const undone = await undoPromotions(0, TMP_DIR);
    expect(undone).toEqual([]);
    expect(getPromotionHistory(TMP_DIR)).toHaveLength(1);
  });

  test("undo on empty ledger returns empty array", async () => {
    const undone = await undoPromotions(3, TMP_DIR);
    expect(undone).toEqual([]);
  });
});
