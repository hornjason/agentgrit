import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, ".tmp-init-test");

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TEST_DIR;
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

describe("init command", () => {
  test("creates directory structure", async () => {
    const { initCommand } = await import("../../bin/commands/init");
    await initCommand(["--quick"]);

    expect(existsSync(join(TEST_DIR, "signals"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "state"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "rubrics"))).toBe(true);
  });

  test("writes config.json for quick mode", async () => {
    const { initCommand } = await import("../../bin/commands/init");
    await initCommand(["--quick"]);

    const configPath = join(TEST_DIR, "config.json");
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.adapter).toBe("local");
    expect(config.rules.autoPromote).toBe(false);
    expect(config.daemon.interval).toBe("0");
  });

  test("writes config.json for standard mode", async () => {
    const { initCommand } = await import("../../bin/commands/init");
    await initCommand(["--standard"]);

    const configPath = join(TEST_DIR, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.judge?.provider).toBe("gemini");
    expect(config.daemon.interval).toBe("30m");
  });

  test("writes config.json for full mode", async () => {
    const { initCommand } = await import("../../bin/commands/init");
    await initCommand(["--full"]);

    const configPath = join(TEST_DIR, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.adapter).toBe("both");
    expect(config.rules.autoPromote).toBe(true);
  });

  test("re-init succeeds on existing directory", async () => {
    const { initCommand } = await import("../../bin/commands/init");
    await initCommand(["--quick"]);
    await initCommand(["--quick"]);

    expect(existsSync(join(TEST_DIR, "config.json"))).toBe(true);
  });
});
