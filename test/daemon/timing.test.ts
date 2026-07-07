import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  recordSessionStart,
  getSessionDurationMinutes,
  getSessionStartTime,
} from "../../src/daemon/timing";

const TEST_FILE = "/tmp/agentgrit-timing-test-" + process.pid + ".txt";

beforeEach(() => {
  if (existsSync(TEST_FILE)) rmSync(TEST_FILE);
});

afterAll(() => {
  if (existsSync(TEST_FILE)) rmSync(TEST_FILE);
});

describe("recordSessionStart", () => {
  test("writes timestamp to file", () => {
    recordSessionStart(TEST_FILE);
    expect(existsSync(TEST_FILE)).toBe(true);

    const content = readFileSync(TEST_FILE, "utf-8");
    const ts = parseInt(content);
    expect(ts).toBeGreaterThan(0);
    expect(Math.abs(ts - Date.now())).toBeLessThan(1000);
  });
});

describe("getSessionDurationMinutes", () => {
  test("returns 0 when no session file exists", () => {
    const duration = getSessionDurationMinutes("/tmp/nonexistent-" + Date.now());
    expect(duration).toBe(0);
  });

  test("returns positive duration after recording start", () => {
    recordSessionStart(TEST_FILE);
    const duration = getSessionDurationMinutes(TEST_FILE);
    expect(duration).toBeGreaterThanOrEqual(0);
    expect(duration).toBeLessThan(1);
  });

  test("computes minutes correctly for known start time", () => {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    require("fs").writeFileSync(TEST_FILE, fiveMinAgo.toString());

    const duration = getSessionDurationMinutes(TEST_FILE);
    expect(duration).toBeGreaterThanOrEqual(4.9);
    expect(duration).toBeLessThan(5.5);
  });
});

describe("getSessionStartTime", () => {
  test("returns null when no session file exists", () => {
    const ts = getSessionStartTime("/tmp/nonexistent-" + Date.now());
    expect(ts).toBeNull();
  });

  test("returns timestamp after recording start", () => {
    recordSessionStart(TEST_FILE);
    const ts = getSessionStartTime(TEST_FILE);
    expect(ts).not.toBeNull();
    expect(typeof ts).toBe("number");
    expect(Math.abs(ts! - Date.now())).toBeLessThan(1000);
  });
});
