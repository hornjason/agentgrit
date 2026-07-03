import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { initCommand } from "../../bin/commands/init";
import type { AgentGritConfig } from "../../src/adapters/types";

const SANDBOX = "/tmp/agentgrit-sandbox-test";

describe("init command bug fixes", () => {
  beforeEach(() => {
    if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true });
    process.env.AGENTGRIT_DIR = SANDBOX;
  });

  afterEach(() => {
    if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true });
    delete process.env.AGENTGRIT_DIR;
  });

  test("Bug 1: starter.json is copied to correct location", async () => {
    await initCommand(["--quick"]);

    const expectedPath = join(SANDBOX, "rubrics", "starter.json");
    expect(existsSync(expectedPath)).toBe(true);

    const content = JSON.parse(readFileSync(expectedPath, "utf-8"));
    expect(content.version).toBe("1.0");
    expect(content.dimensions).toHaveLength(4);
  });

  test("Bug 2: signalDir reflects AGENTGRIT_DIR not hardcoded ~/.agentgrit", async () => {
    await initCommand(["--quick"]);

    const configPath = join(SANDBOX, "config.json");
    const config: AgentGritConfig = JSON.parse(readFileSync(configPath, "utf-8"));

    // Should be SANDBOX/signals, not ~/.agentgrit/signals
    expect(config.signalDir).toBe(join(SANDBOX, "signals"));
    expect(config.signalDir).not.toContain("~/.agentgrit");
  });

  test("Bug 2: signalDir reflects AGENTGRIT_DIR in standard mode", async () => {
    await initCommand(["--standard"]);

    const configPath = join(SANDBOX, "config.json");
    const config: AgentGritConfig = JSON.parse(readFileSync(configPath, "utf-8"));

    expect(config.signalDir).toBe(join(SANDBOX, "signals"));
  });

  test("Bug 2: signalDir reflects AGENTGRIT_DIR in full mode", async () => {
    await initCommand(["--full"]);

    const configPath = join(SANDBOX, "config.json");
    const config: AgentGritConfig = JSON.parse(readFileSync(configPath, "utf-8"));

    expect(config.signalDir).toBe(join(SANDBOX, "signals"));
  });
});
