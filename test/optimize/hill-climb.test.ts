import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { hillClimb } from "../../src/optimize/hill-climb";

const TMP_DIR = join(import.meta.dir, ".tmp-hill-climb-test");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

describe("hillClimb", () => {
  test("improvement is kept when score increases", async () => {
    const scores = [0.5, 0.7]; // baseline, then proposal
    let idx = 0;
    const longText = "x".repeat(200);
    const result = await hillClimb({
      current: longText,
      rounds: 1,
      stateDir: TMP_DIR,
      evaluate: async () => scores[idx++] ?? 0.7,
      propose: async (text) => text + " improved",
    });

    expect(result.initialScore).toBe(0.5);
    expect(result.finalScore).toBe(0.7);
    expect(result.kept).toBe(1);
    expect(result.discarded).toBe(0);
    expect(result.finalText).toBe(longText + " improved");
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0].outcome).toBe("kept");
  });

  test("regression is discarded when score decreases", async () => {
    const scores = [0.7, 0.5]; // baseline, then proposal (worse)
    let idx = 0;
    const longText = "x".repeat(200);
    const result = await hillClimb({
      current: longText,
      rounds: 1,
      stateDir: TMP_DIR,
      evaluate: async () => scores[idx++] ?? 0.5,
      propose: async (text) => text + " worse",
    });

    expect(result.initialScore).toBe(0.7);
    expect(result.finalScore).toBe(0.7);
    expect(result.kept).toBe(0);
    expect(result.discarded).toBe(1);
    expect(result.finalText).toBe(longText);
    expect(result.rounds[0].outcome).toBe("discarded");
  });

  test("15% change limit is enforced", async () => {
    const original = "x".repeat(100);
    const result = await hillClimb({
      current: original,
      rounds: 1,
      stateDir: TMP_DIR,
      maxChangeRatio: 0.15,
      evaluate: async () => 0.5,
      propose: async () => "x".repeat(200),
    });

    expect(result.rejected).toBe(1);
    expect(result.kept).toBe(0);
    expect(result.rounds[0].outcome).toBe("rejected_size");
    expect(result.finalText).toBe(original);
  });

  test("change within limit is accepted", async () => {
    const original = "x".repeat(100);
    let callCount = 0;
    const result = await hillClimb({
      current: original,
      rounds: 1,
      stateDir: TMP_DIR,
      maxChangeRatio: 0.15,
      evaluate: async () => {
        callCount++;
        return callCount === 1 ? 0.5 : 0.8;
      },
      propose: async () => "x".repeat(110),
    });

    expect(result.rejected).toBe(0);
    expect(result.kept).toBe(1);
  });

  test("multiple rounds accumulate improvements", async () => {
    const scores = [0.3, 0.5, 0.7, 0.9];
    let idx = 0;
    const result = await hillClimb({
      current: "x".repeat(200),
      rounds: 3,
      stateDir: TMP_DIR,
      evaluate: async () => scores[idx++] ?? 0.9,
      propose: async (text) => text + "+",
    });

    expect(result.rounds).toHaveLength(3);
    expect(result.finalScore).toBeGreaterThan(result.initialScore);
    expect(result.kept).toBe(3);
  });

  test("experiment log is written to stateDir", async () => {
    await hillClimb({
      current: "x".repeat(200),
      rounds: 1,
      stateDir: TMP_DIR,
      evaluate: async () => 0.5,
      propose: async (text) => text + " v2",
    });

    const logPath = join(TMP_DIR, "experiments.jsonl");
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.round).toBe(1);
    expect(entry.timestamp).toBeDefined();
  });

  test("large improvement (>15% delta) is flagged for review", async () => {
    const scores = [0.3, 0.8]; // baseline=0.3, proposal=0.8 (delta=0.5 > 0.15 threshold)
    let idx = 0;
    const result = await hillClimb({
      current: "x".repeat(200),
      rounds: 1,
      stateDir: TMP_DIR,
      evaluate: async () => scores[idx++] ?? 0.8,
      propose: async (text) => text + "!",
    });

    expect(result.reviewFlagged).toHaveLength(1);
    expect(result.reviewFlagged[0].delta).toBeGreaterThan(0.15);
  });

  test("proposal failure is handled gracefully", async () => {
    const result = await hillClimb({
      current: "x".repeat(200),
      rounds: 2,
      stateDir: TMP_DIR,
      evaluate: async () => 0.5,
      propose: async () => {
        throw new Error("inference failed");
      },
    });

    expect(result.kept).toBe(0);
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0].outcome).toBe("proposal_failed");
  });

  test("identical proposal is treated as failure", async () => {
    const result = await hillClimb({
      current: "x".repeat(200),
      rounds: 1,
      stateDir: TMP_DIR,
      evaluate: async () => 0.5,
      propose: async (text) => text,
    });

    expect(result.rounds[0].outcome).toBe("proposal_failed");
  });
});
