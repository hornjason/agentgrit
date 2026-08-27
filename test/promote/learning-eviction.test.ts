import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import {
  recordArtifactFiring,
  shouldEvictLearning,
  shouldPromoteLearning,
  loadArtifactStats,
  type LearningEvictionConfig,
} from "../../src/promote/auto-eviction";
import type { LearningArtifactStats } from "../../src/adapters/types";

const TEMP_DIR = join(import.meta.dir, ".tmp-learning-eviction");

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function makeStats(overrides: Partial<LearningArtifactStats> = {}): LearningArtifactStats {
  return {
    artifactId: "test-artifact",
    firingCount: 0,
    lastFired: new Date().toISOString(),
    createdAt: daysAgo(30),
    destination: "template",
    ...overrides,
  };
}

const DEFAULT_CONFIG: LearningEvictionConfig = {
  evictionDays: 90,
  promotionFiringThreshold: 10,
  promotionWindowDays: 30,
  loggingOnly: true,
};

beforeEach(() => {
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true });
  mkdirSync(TEMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true });
});

// ── AC-1: LearningArtifactStats interface ──

describe("LearningArtifactStats — interface shape", () => {
  test("has all required fields", () => {
    const stats: LearningArtifactStats = {
      artifactId: "art-1",
      firingCount: 5,
      lastFired: "2026-08-01T00:00:00Z",
      createdAt: "2026-07-01T00:00:00Z",
      destination: "template",
    };
    expect(stats.firingCount).toBe(5);
    expect(stats.lastFired).toBe("2026-08-01T00:00:00Z");
    expect(stats.createdAt).toBe("2026-07-01T00:00:00Z");
    expect(stats.destination).toBe("template");
    expect(stats.artifactId).toBe("art-1");
  });
});

// ── AC-2: recordArtifactFiring ──

describe("recordArtifactFiring", () => {
  test("creates stats file on first firing", () => {
    recordArtifactFiring("art-1", TEMP_DIR, "template");
    const stats = loadArtifactStats(TEMP_DIR);
    expect(stats.length).toBe(1);
    expect(stats[0].artifactId).toBe("art-1");
    expect(stats[0].firingCount).toBe(1);
    expect(stats[0].destination).toBe("template");
  });

  test("increments count on subsequent firings", () => {
    recordArtifactFiring("art-1", TEMP_DIR, "template");
    recordArtifactFiring("art-1", TEMP_DIR, "template");
    recordArtifactFiring("art-1", TEMP_DIR, "template");
    const stats = loadArtifactStats(TEMP_DIR);
    const art1 = stats.find((s) => s.artifactId === "art-1");
    expect(art1).toBeDefined();
    expect(art1!.firingCount).toBe(3);
  });

  test("updates lastFired timestamp on each firing", () => {
    recordArtifactFiring("art-1", TEMP_DIR, "template");
    const stats1 = loadArtifactStats(TEMP_DIR);
    const first = stats1[0].lastFired;

    // Small delay to ensure different timestamp
    recordArtifactFiring("art-1", TEMP_DIR, "template");
    const stats2 = loadArtifactStats(TEMP_DIR);
    const art1 = stats2.find((s) => s.artifactId === "art-1");
    expect(art1!.lastFired).toBeDefined();
    // lastFired should be >= first (ISO strings sort correctly)
    expect(art1!.lastFired >= first).toBe(true);
  });

  test("tracks multiple artifacts independently", () => {
    recordArtifactFiring("art-1", TEMP_DIR, "template");
    recordArtifactFiring("art-2", TEMP_DIR, "gate");
    recordArtifactFiring("art-1", TEMP_DIR, "template");

    const stats = loadArtifactStats(TEMP_DIR);
    const art1 = stats.find((s) => s.artifactId === "art-1");
    const art2 = stats.find((s) => s.artifactId === "art-2");
    expect(art1!.firingCount).toBe(2);
    expect(art2!.firingCount).toBe(1);
  });

  test("preserves createdAt across firings", () => {
    recordArtifactFiring("art-1", TEMP_DIR, "template");
    const stats1 = loadArtifactStats(TEMP_DIR);
    const createdAt = stats1[0].createdAt;

    recordArtifactFiring("art-1", TEMP_DIR, "template");
    const stats2 = loadArtifactStats(TEMP_DIR);
    const art1 = stats2.find((s) => s.artifactId === "art-1");
    expect(art1!.createdAt).toBe(createdAt);
  });
});

// ── AC-3: shouldEvictLearning ──

describe("shouldEvictLearning", () => {
  test("returns candidate when firingCount=0 for 90+ days", () => {
    const stats = makeStats({
      artifactId: "stale-1",
      firingCount: 0,
      createdAt: daysAgo(100),
      lastFired: daysAgo(100),
    });
    const result = shouldEvictLearning([stats], DEFAULT_CONFIG);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].artifactId).toBe("stale-1");
    expect(result.loggingOnly).toBe(true);
  });

  test("does NOT return candidate when firingCount=0 but under threshold", () => {
    const stats = makeStats({
      artifactId: "young-1",
      firingCount: 0,
      createdAt: daysAgo(30),
      lastFired: daysAgo(30),
    });
    const result = shouldEvictLearning([stats], DEFAULT_CONFIG);
    expect(result.candidates.length).toBe(0);
  });

  test("does NOT return candidate when firingCount > 0", () => {
    const stats = makeStats({
      artifactId: "active-1",
      firingCount: 5,
      createdAt: daysAgo(100),
      lastFired: daysAgo(5),
    });
    const result = shouldEvictLearning([stats], DEFAULT_CONFIG);
    expect(result.candidates.length).toBe(0);
  });

  test("respects configurable evictionDays threshold", () => {
    const stats = makeStats({
      artifactId: "custom-1",
      firingCount: 0,
      createdAt: daysAgo(31),
      lastFired: daysAgo(31),
    });
    const config: LearningEvictionConfig = {
      ...DEFAULT_CONFIG,
      evictionDays: 30,
    };
    const result = shouldEvictLearning([stats], config);
    expect(result.candidates.length).toBe(1);
  });

  test("returns multiple candidates", () => {
    const stats = [
      makeStats({ artifactId: "stale-a", firingCount: 0, createdAt: daysAgo(100), lastFired: daysAgo(100) }),
      makeStats({ artifactId: "stale-b", firingCount: 0, createdAt: daysAgo(95), lastFired: daysAgo(95) }),
      makeStats({ artifactId: "active-c", firingCount: 3, createdAt: daysAgo(100), lastFired: daysAgo(2) }),
    ];
    const result = shouldEvictLearning(stats, DEFAULT_CONFIG);
    expect(result.candidates.length).toBe(2);
  });

  test("loggingOnly flag matches config", () => {
    const stats = makeStats({
      artifactId: "stale-1",
      firingCount: 0,
      createdAt: daysAgo(100),
      lastFired: daysAgo(100),
    });
    const activeConfig: LearningEvictionConfig = {
      ...DEFAULT_CONFIG,
      loggingOnly: false,
    };
    const result = shouldEvictLearning([stats], activeConfig);
    expect(result.loggingOnly).toBe(false);
  });

  test("uses createdAt as fallback when lastFired equals createdAt (never fired)", () => {
    const created = daysAgo(91);
    const stats = makeStats({
      artifactId: "never-fired",
      firingCount: 0,
      createdAt: created,
      lastFired: created,
    });
    const result = shouldEvictLearning([stats], DEFAULT_CONFIG);
    expect(result.candidates.length).toBe(1);
  });
});

// ── AC-4: shouldPromoteLearning ──

describe("shouldPromoteLearning", () => {
  test("returns candidate when firingCount exceeds threshold within window", () => {
    const stats = makeStats({
      artifactId: "hot-1",
      firingCount: 15,
      createdAt: daysAgo(20),
      lastFired: daysAgo(1),
    });
    const result = shouldPromoteLearning([stats], DEFAULT_CONFIG);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].artifactId).toBe("hot-1");
    expect(result.loggingOnly).toBe(true);
  });

  test("does NOT return candidate when firingCount below threshold", () => {
    const stats = makeStats({
      artifactId: "warm-1",
      firingCount: 5,
      createdAt: daysAgo(20),
      lastFired: daysAgo(1),
    });
    const result = shouldPromoteLearning([stats], DEFAULT_CONFIG);
    expect(result.candidates.length).toBe(0);
  });

  test("does NOT return candidate when artifact is too old (outside window)", () => {
    const stats = makeStats({
      artifactId: "old-hot-1",
      firingCount: 15,
      createdAt: daysAgo(60),
      lastFired: daysAgo(45),
    });
    const result = shouldPromoteLearning([stats], DEFAULT_CONFIG);
    expect(result.candidates.length).toBe(0);
  });

  test("respects configurable promotionFiringThreshold", () => {
    const stats = makeStats({
      artifactId: "custom-1",
      firingCount: 6,
      createdAt: daysAgo(10),
      lastFired: daysAgo(1),
    });
    const config: LearningEvictionConfig = {
      ...DEFAULT_CONFIG,
      promotionFiringThreshold: 5,
    };
    const result = shouldPromoteLearning([stats], config);
    expect(result.candidates.length).toBe(1);
  });

  test("respects configurable promotionWindowDays", () => {
    const stats = makeStats({
      artifactId: "window-1",
      firingCount: 15,
      createdAt: daysAgo(10),
      lastFired: daysAgo(1),
    });
    const config: LearningEvictionConfig = {
      ...DEFAULT_CONFIG,
      promotionWindowDays: 7,
    };
    // lastFired is within 7 days, so should promote
    const result = shouldPromoteLearning([stats], config);
    expect(result.candidates.length).toBe(1);
  });

  test("returns multiple promotion candidates", () => {
    const stats = [
      makeStats({ artifactId: "hot-a", firingCount: 12, createdAt: daysAgo(15), lastFired: daysAgo(1) }),
      makeStats({ artifactId: "hot-b", firingCount: 20, createdAt: daysAgo(10), lastFired: daysAgo(2) }),
      makeStats({ artifactId: "cold-c", firingCount: 2, createdAt: daysAgo(5), lastFired: daysAgo(3) }),
    ];
    const result = shouldPromoteLearning(stats, DEFAULT_CONFIG);
    expect(result.candidates.length).toBe(2);
  });

  test("loggingOnly flag matches config", () => {
    const stats = makeStats({
      artifactId: "hot-1",
      firingCount: 15,
      createdAt: daysAgo(10),
      lastFired: daysAgo(1),
    });
    const activeConfig: LearningEvictionConfig = {
      ...DEFAULT_CONFIG,
      loggingOnly: false,
    };
    const result = shouldPromoteLearning([stats], activeConfig);
    expect(result.loggingOnly).toBe(false);
  });

  test("exact threshold boundary — firingCount equals threshold", () => {
    const stats = makeStats({
      artifactId: "boundary-1",
      firingCount: 10,
      createdAt: daysAgo(15),
      lastFired: daysAgo(1),
    });
    const result = shouldPromoteLearning([stats], DEFAULT_CONFIG);
    // At exactly threshold: should promote (>=)
    expect(result.candidates.length).toBe(1);
  });
});

// ── loadArtifactStats ──

describe("loadArtifactStats", () => {
  test("returns empty array when file does not exist", () => {
    const stats = loadArtifactStats(TEMP_DIR);
    expect(stats).toEqual([]);
  });

  test("returns parsed stats from jsonl file", () => {
    recordArtifactFiring("art-1", TEMP_DIR, "template");
    recordArtifactFiring("art-2", TEMP_DIR, "gate");
    const stats = loadArtifactStats(TEMP_DIR);
    expect(stats.length).toBe(2);
  });
});
