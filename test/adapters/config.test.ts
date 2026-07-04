import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("loadConfig and resolveSignalDir", () => {
  const testDir = join(tmpdir(), `agentgrit-test-${Date.now()}`);
  const originalEnv = process.env.AGENTGRIT_DIR;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    process.env.AGENTGRIT_DIR = testDir;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENTGRIT_DIR;
    } else {
      process.env.AGENTGRIT_DIR = originalEnv;
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("loadConfig returns default when no config.json", async () => {
    const mod = await import("../../src/adapters/paths");
    const config = mod.loadConfig();
    expect(config.signalDir).toBe(join(testDir, "signals"));
  });

  test("loadConfig reads signalDir from config.json", async () => {
    writeFileSync(
      join(testDir, "config.json"),
      JSON.stringify({ signalDir: "/custom/signals/path" }),
    );
    const mod = await import("../../src/adapters/paths");
    const config = mod.loadConfig();
    expect(config.signalDir).toBe("/custom/signals/path");
  });

  test("resolveSignalDir returns default when no config", async () => {
    const mod = await import("../../src/adapters/paths");
    const result = mod.resolveSignalDir();
    expect(result).toBe(join(testDir, "signals"));
  });

  test("resolveSignalDir returns configured path", async () => {
    writeFileSync(
      join(testDir, "config.json"),
      JSON.stringify({ signalDir: "/my/custom/signals" }),
    );
    const mod = await import("../../src/adapters/paths");
    const result = mod.resolveSignalDir();
    expect(result).toBe("/my/custom/signals");
  });

  test("resolveSignalDir expands tilde in signalDir", async () => {
    writeFileSync(
      join(testDir, "config.json"),
      JSON.stringify({ signalDir: "~/my-signals" }),
    );
    const mod = await import("../../src/adapters/paths");
    const result = mod.resolveSignalDir();
    const { homedir } = await import("os");
    expect(result).toBe(join(homedir(), "my-signals"));
  });
});
