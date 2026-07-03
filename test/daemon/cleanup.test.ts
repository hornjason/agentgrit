import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { cleanupSession, rotateSignals } from "../../src/daemon/cleanup";

const TEST_DIR = "/tmp/agentgrit-cleanup-test-" + process.pid;
const SIGNAL_DIR = join(TEST_DIR, "signals");
const STATE_DIR = join(TEST_DIR, "state");

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(SIGNAL_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
});

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("cleanupSession", () => {
  test("returns result with all fields", async () => {
    const result = await cleanupSession(SIGNAL_DIR, STATE_DIR);

    expect(result).toHaveProperty("staleFilesRemoved");
    expect(result).toHaveProperty("sessionStatesCleared");
    expect(result).toHaveProperty("errors");
    expect(Array.isArray(result.errors)).toBe(true);
  });

  test("handles empty state directory", async () => {
    const result = await cleanupSession(SIGNAL_DIR, STATE_DIR);

    expect(result.staleFilesRemoved).toBe(0);
    expect(result.sessionStatesCleared).toBe(0);
    expect(result.errors).toEqual([]);
  });

  test("cleans old tmp files from state", async () => {
    const tmpFile = join(STATE_DIR, "old.tmp");
    writeFileSync(tmpFile, "stale");

    const oldTime = Date.now() - 8 * 86_400_000;
    const { utimesSync } = require("fs");
    utimesSync(tmpFile, new Date(oldTime), new Date(oldTime));

    const result = await cleanupSession(SIGNAL_DIR, STATE_DIR);
    expect(result.sessionStatesCleared).toBe(1);
    expect(existsSync(tmpFile)).toBe(false);
  });

  test("preserves recent tmp files", async () => {
    const tmpFile = join(STATE_DIR, "recent.tmp");
    writeFileSync(tmpFile, "recent");

    const result = await cleanupSession(SIGNAL_DIR, STATE_DIR);
    expect(result.sessionStatesCleared).toBe(0);
    expect(existsSync(tmpFile)).toBe(true);
  });

  test("handles missing state directory", async () => {
    const result = await cleanupSession(SIGNAL_DIR, "/tmp/nonexistent-" + Date.now());

    expect(result.staleFilesRemoved).toBe(0);
    expect(result.errors).toEqual([]);
  });
});

describe("rotateSignals", () => {
  test("returns 0 when no files exceed threshold", async () => {
    writeFileSync(join(SIGNAL_DIR, "small.jsonl"), "small data\n");

    const rotated = await rotateSignals(SIGNAL_DIR, 1);
    expect(rotated).toBe(0);
  });

  test("rotates files that exceed threshold", async () => {
    const largePath = join(SIGNAL_DIR, "large.jsonl");
    const largeData = "x".repeat(1024) + "\n";
    writeFileSync(largePath, largeData);

    const rotated = await rotateSignals(SIGNAL_DIR, 0.0001);
    expect(rotated).toBe(1);

    expect(existsSync(largePath)).toBe(true);
    const content = readFileSync(largePath, "utf-8");
    expect(content).toBe("");
  });

  test("returns 0 for missing directory", async () => {
    const rotated = await rotateSignals("/tmp/nonexistent-" + Date.now());
    expect(rotated).toBe(0);
  });

  test("only rotates .jsonl files", async () => {
    writeFileSync(join(SIGNAL_DIR, "data.json"), "x".repeat(2048));
    writeFileSync(join(SIGNAL_DIR, "data.jsonl"), "x".repeat(2048));

    const rotated = await rotateSignals(SIGNAL_DIR, 0.0001);
    expect(rotated).toBe(1);
  });
});
