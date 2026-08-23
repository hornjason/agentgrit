import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";

const TEMP_DIR = join(import.meta.dir, ".tmp-session-guard");

beforeEach(() => {
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true });
  mkdirSync(TEMP_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TEMP_DIR;
});

afterEach(() => {
  delete process.env.AGENTGRIT_DIR;
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true });
});

describe("writeSessionContext test-env guard", () => {
  test("skips write when NODE_ENV=test and AGENTGRIT_DIR is unset", async () => {
    const { writeSessionContext } = await import("../../src/graph/context");

    delete process.env.AGENTGRIT_DIR;
    const origNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";

    const rules = [{ id: "test-rule", text: "test", tags: ["test"], correlationScore: 0.5, domains: ["test"] }];
    writeSessionContext(rules as any, ["test"]);

    const stateDirPath = join(TEMP_DIR, "state");
    const sessionFile = join(stateDirPath, "session-context.json");
    expect(existsSync(sessionFile)).toBe(false);

    process.env.NODE_ENV = origNodeEnv;
  });

  test("writes normally when AGENTGRIT_DIR is set in test env", async () => {
    const { writeSessionContext, readSessionContext } = await import("../../src/graph/context");

    process.env.NODE_ENV = "test";
    process.env.AGENTGRIT_DIR = TEMP_DIR;

    const rules = [{ id: "test-rule", text: "test", tags: ["test"], correlationScore: 0.5, domains: ["test"] }];
    writeSessionContext(rules as any, ["test"]);

    const ctx = readSessionContext();
    expect(ctx).not.toBeNull();
    expect(ctx!.ruleIds).toContain("test-rule");
  });

  test("writes normally when NODE_ENV is not test", async () => {
    const { writeSessionContext, readSessionContext } = await import("../../src/graph/context");

    delete process.env.AGENTGRIT_DIR;
    process.env.AGENTGRIT_DIR = TEMP_DIR;
    const origNodeEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;

    const rules = [{ id: "test-rule", text: "test", tags: ["test"], correlationScore: 0.5, domains: ["test"] }];
    writeSessionContext(rules as any, ["test"]);

    const ctx = readSessionContext();
    expect(ctx).not.toBeNull();

    process.env.NODE_ENV = origNodeEnv;
  });
});

describe("purgeSessionHistoryNoise", () => {
  test("removes noise entries matching fingerprint", async () => {
    const { purgeSessionHistoryNoise } = await import("../../src/graph/context");

    const historyDir = join(TEMP_DIR, "state");
    mkdirSync(historyDir, { recursive: true });
    const historyPath = join(historyDir, "session-context-history.jsonl");

    const noiseEntry = JSON.stringify({
      ruleIds: ["some-rule"],
      domains: ["process", "scope"],
      rulesInjectedCount: 1,
      timestamp: "2026-08-20T00:00:00Z",
    });
    const goodEntry = JSON.stringify({
      ruleIds: ["real-rule-1", "real-rule-2"],
      domains: ["testing", "delivery"],
      rulesInjectedCount: 5,
      timestamp: "2026-08-20T01:00:00Z",
    });
    const anotherNoise = JSON.stringify({
      ruleIds: ["another-noise"],
      domains: ["process", "scope"],
      rulesInjectedCount: 1,
      timestamp: "2026-08-20T02:00:00Z",
    });

    const { writeFileSync } = await import("fs");
    writeFileSync(historyPath, [noiseEntry, goodEntry, anotherNoise].join("\n") + "\n", "utf-8");

    const purged = purgeSessionHistoryNoise(TEMP_DIR);
    expect(purged).toBe(2);

    const remaining = readFileSync(historyPath, "utf-8").trim().split("\n");
    expect(remaining).toHaveLength(1);
    const parsed = JSON.parse(remaining[0]);
    expect(parsed.rulesInjectedCount).toBe(5);
  });

  test("returns 0 when no noise entries exist", async () => {
    const { purgeSessionHistoryNoise } = await import("../../src/graph/context");

    const historyDir = join(TEMP_DIR, "state");
    mkdirSync(historyDir, { recursive: true });
    const historyPath = join(historyDir, "session-context-history.jsonl");

    const goodEntry = JSON.stringify({
      ruleIds: ["real-rule"],
      domains: ["testing"],
      rulesInjectedCount: 5,
      timestamp: "2026-08-20T00:00:00Z",
    });
    const { writeFileSync } = await import("fs");
    writeFileSync(historyPath, goodEntry + "\n", "utf-8");

    const purged = purgeSessionHistoryNoise(TEMP_DIR);
    expect(purged).toBe(0);
  });

  test("handles missing history file gracefully", async () => {
    const { purgeSessionHistoryNoise } = await import("../../src/graph/context");
    const purged = purgeSessionHistoryNoise(TEMP_DIR);
    expect(purged).toBe(0);
  });
});
