import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
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

  describe("resolveMemoryDir", () => {
    test("defaults to <baseDir>/memory when no config memoryDir", async () => {
      process.env.AGENTGRIT_DIR = "/tmp/agentgrit-test-no-config-" + Date.now();
      const mod = await import("../../src/adapters/paths");
      const expected = join(process.env.AGENTGRIT_DIR, "memory");
      expect(mod.resolveMemoryDir()).toBe(expected);
    });
  });

  describe("resolveSignalFile", () => {
    const tmpDir = join(homedir(), ".agentgrit-test-signals-" + Date.now());

    beforeEach(() => {
      mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
    });

    test("returns primary path when file exists", async () => {
      writeFileSync(join(tmpDir, "corrections.jsonl"), "");
      const mod = await import("../../src/adapters/paths");
      expect(mod.resolveSignalFile(tmpDir, "corrections.jsonl")).toBe(
        join(tmpDir, "corrections.jsonl"),
      );
    });

    test("falls back to alias when primary missing", async () => {
      writeFileSync(join(tmpDir, "correction-captures.jsonl"), "");
      const mod = await import("../../src/adapters/paths");
      expect(mod.resolveSignalFile(tmpDir, "corrections.jsonl")).toBe(
        join(tmpDir, "correction-captures.jsonl"),
      );
    });

    test("falls back to alias for skills.jsonl", async () => {
      writeFileSync(join(tmpDir, "skill-invocations.jsonl"), "");
      const mod = await import("../../src/adapters/paths");
      expect(mod.resolveSignalFile(tmpDir, "skills.jsonl")).toBe(
        join(tmpDir, "skill-invocations.jsonl"),
      );
    });

    test("falls back to alias for scores.jsonl", async () => {
      writeFileSync(join(tmpDir, "quality-scores.jsonl"), "");
      const mod = await import("../../src/adapters/paths");
      expect(mod.resolveSignalFile(tmpDir, "scores.jsonl")).toBe(
        join(tmpDir, "quality-scores.jsonl"),
      );
    });

    test("returns primary path when neither exists (for new file creation)", async () => {
      const mod = await import("../../src/adapters/paths");
      expect(mod.resolveSignalFile(tmpDir, "corrections.jsonl")).toBe(
        join(tmpDir, "corrections.jsonl"),
      );
    });

    test("prefers primary over alias when both exist", async () => {
      writeFileSync(join(tmpDir, "corrections.jsonl"), "primary");
      writeFileSync(join(tmpDir, "correction-captures.jsonl"), "alias");
      const mod = await import("../../src/adapters/paths");
      expect(mod.resolveSignalFile(tmpDir, "corrections.jsonl")).toBe(
        join(tmpDir, "corrections.jsonl"),
      );
    });

    test("no alias for unknown files", async () => {
      const mod = await import("../../src/adapters/paths");
      expect(mod.resolveSignalFile(tmpDir, "unknown.jsonl")).toBe(
        join(tmpDir, "unknown.jsonl"),
      );
    });
  });
});
