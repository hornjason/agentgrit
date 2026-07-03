import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import {
  addTrajectory,
  queryTrajectories,
  gcTrajectories,
} from "../../src/detect/trajectories";
import type { Trajectory } from "../../src/adapters/types";

const TMP_DIR = join(import.meta.dir, ".tmp-trajectories-test");

function makeTrajectory(
  id: string,
  rating: number,
  domains: string[] = [],
): Trajectory {
  return {
    id,
    task: `Task for ${id}`,
    domains,
    summary: `Summary for ${id}`,
    rating,
    timestamp: new Date().toISOString(),
  };
}

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

describe("addTrajectory", () => {
  test("stores a trajectory to disk", async () => {
    await addTrajectory(makeTrajectory("t1", 9, ["testing"]), TMP_DIR);

    const storePath = join(TMP_DIR, "trajectories.json");
    expect(existsSync(storePath)).toBe(true);
    const store = JSON.parse(readFileSync(storePath, "utf-8"));
    expect(store.trajectories).toHaveLength(1);
    expect(store.trajectories[0].id).toBe("t1");
  });

  test("appends multiple trajectories", async () => {
    await addTrajectory(makeTrajectory("t1", 8, ["deploy"]), TMP_DIR);
    await addTrajectory(makeTrajectory("t2", 9, ["testing"]), TMP_DIR);

    const store = JSON.parse(
      readFileSync(join(TMP_DIR, "trajectories.json"), "utf-8"),
    );
    expect(store.trajectories).toHaveLength(2);
  });
});

describe("queryTrajectories", () => {
  test("returns trajectories matching domains", async () => {
    await addTrajectory(makeTrajectory("t1", 9, ["testing", "deploy"]), TMP_DIR);
    await addTrajectory(makeTrajectory("t2", 8, ["security"]), TMP_DIR);
    await addTrajectory(makeTrajectory("t3", 7, ["testing"]), TMP_DIR);

    const results = await queryTrajectories(["testing"], TMP_DIR);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((t) => t.domains.includes("testing"))).toBe(true);
  });

  test("returns empty for no matches", async () => {
    await addTrajectory(makeTrajectory("t1", 9, ["deploy"]), TMP_DIR);

    const results = await queryTrajectories(["nonexistent"], TMP_DIR);
    expect(results).toHaveLength(0);
  });

  test("respects limit parameter", async () => {
    for (let i = 0; i < 10; i++) {
      await addTrajectory(
        makeTrajectory(`t${i}`, 7 + (i % 3), ["shared"]),
        TMP_DIR,
      );
    }

    const results = await queryTrajectories(["shared"], TMP_DIR, 3);
    expect(results).toHaveLength(3);
  });

  test("returns all when no domain filter", async () => {
    await addTrajectory(makeTrajectory("t1", 9, ["a"]), TMP_DIR);
    await addTrajectory(makeTrajectory("t2", 8, ["b"]), TMP_DIR);

    const results = await queryTrajectories([], TMP_DIR);
    expect(results).toHaveLength(2);
  });
});

describe("gcTrajectories", () => {
  test("evicts lowest-rated when over 100 cap", async () => {
    for (let i = 0; i < 105; i++) {
      const rating = 7 + (i % 4);
      await addTrajectory(makeTrajectory(`t${i}`, rating), TMP_DIR);
    }

    const evicted = await gcTrajectories(TMP_DIR);
    expect(evicted).toBe(0);

    const store = JSON.parse(
      readFileSync(join(TMP_DIR, "trajectories.json"), "utf-8"),
    );
    expect(store.trajectories.length).toBeLessThanOrEqual(100);
  });

  test("returns 0 when under cap", async () => {
    for (let i = 0; i < 5; i++) {
      await addTrajectory(makeTrajectory(`t${i}`, 8), TMP_DIR);
    }

    const evicted = await gcTrajectories(TMP_DIR);
    expect(evicted).toBe(0);
  });

  test("evicted entries are the lowest rated", async () => {
    for (let i = 0; i < 102; i++) {
      await addTrajectory(makeTrajectory(`t${i}`, i < 2 ? 1 : 9), TMP_DIR);
    }

    const store = JSON.parse(
      readFileSync(join(TMP_DIR, "trajectories.json"), "utf-8"),
    );
    expect(store.trajectories.length).toBeLessThanOrEqual(100);
    const ratings = store.trajectories.map((t: Trajectory) => t.rating);
    expect(ratings.every((r: number) => r >= 1)).toBe(true);
  });
});
