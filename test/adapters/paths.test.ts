import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { homedir } from "os";
import { join } from "path";

describe("paths", () => {
  const originalEnv = process.env.AGENTGRIT_DIR;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENTGRIT_DIR;
    } else {
      process.env.AGENTGRIT_DIR = originalEnv;
    }
  });

  test("default base dir is ~/.agentgrit", async () => {
    delete process.env.AGENTGRIT_DIR;
    // Dynamic import to pick up env changes
    const mod = await import("../../src/adapters/paths");
    expect(mod.getBaseDir()).toBe(join(homedir(), ".agentgrit"));
  });

  test("env override changes base dir", async () => {
    process.env.AGENTGRIT_DIR = "/custom/path";
    const mod = await import("../../src/adapters/paths");
    expect(mod.getBaseDir()).toBe("/custom/path");
  });

  test("tilde expansion in env var", async () => {
    process.env.AGENTGRIT_DIR = "~/my-grit";
    const mod = await import("../../src/adapters/paths");
    expect(mod.getBaseDir()).toBe(join(homedir(), "my-grit"));
  });

  test("signals dir is under base", async () => {
    delete process.env.AGENTGRIT_DIR;
    const mod = await import("../../src/adapters/paths");
    expect(mod.signalsDir()).toBe(join(homedir(), ".agentgrit", "signals"));
  });

  test("state dir is under base", async () => {
    delete process.env.AGENTGRIT_DIR;
    const mod = await import("../../src/adapters/paths");
    expect(mod.stateDir()).toBe(join(homedir(), ".agentgrit", "state"));
  });

  test("rubrics dir is under base", async () => {
    delete process.env.AGENTGRIT_DIR;
    const mod = await import("../../src/adapters/paths");
    expect(mod.rubricsDir()).toBe(join(homedir(), ".agentgrit", "rubrics"));
  });

  test("signalPath joins filename to signals dir", async () => {
    delete process.env.AGENTGRIT_DIR;
    const mod = await import("../../src/adapters/paths");
    expect(mod.signalPath("ratings.jsonl")).toBe(
      join(homedir(), ".agentgrit", "signals", "ratings.jsonl"),
    );
  });

  test("projectDir creates slug from cwd", async () => {
    delete process.env.AGENTGRIT_DIR;
    const mod = await import("../../src/adapters/paths");
    const result = mod.projectDir("/Users/test/my-project");
    expect(result).toContain("projects");
    expect(result).toContain("my-project");
  });

  test("expandPath handles $HOME", async () => {
    const mod = await import("../../src/adapters/paths");
    expect(mod.expandPath("$HOME/test")).toBe(join(homedir(), "test"));
  });

  test("expandPath handles ${HOME}", async () => {
    const mod = await import("../../src/adapters/paths");
    expect(mod.expandPath("${HOME}/test")).toBe(join(homedir(), "test"));
  });
});
