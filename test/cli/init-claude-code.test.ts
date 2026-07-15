import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const SANDBOX = "/tmp/agentgrit-init-claude-code-test";

beforeEach(() => {
  if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true });
  mkdirSync(SANDBOX, { recursive: true });
  process.env.AGENTGRIT_DIR = SANDBOX;
});

afterEach(() => {
  if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

describe("init --claude-code", () => {
  test("generates >= 2 hook entries with correct structure, preserving existing config", async () => {
    const settingsPath = join(SANDBOX, "settings.json");
    const existing = {
      model: "claude-sonnet-4-20250514",
      permissions: { allow: ["Read", "Bash"] },
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "my-security-hook.sh" }],
          },
        ],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2), "utf-8");

    const { installClaudeCodeHooks } = await import("../../src/adapters/discovery");
    const result = installClaudeCodeHooks(settingsPath);

    // AC-1: >= 2 hook entries generated
    expect(result.installed).toBeGreaterThanOrEqual(2);

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));

    // SessionStart hook present with context injection command
    expect(settings.hooks.SessionStart).toBeDefined();
    const sessionStartHooks = settings.hooks.SessionStart.flatMap(
      (e: any) => e.hooks ?? [],
    );
    const hasContextInject = sessionStartHooks.some(
      (h: any) => h.type === "command" && h.command.includes("agentgrit"),
    );
    expect(hasContextInject).toBe(true);

    // SessionEnd hook present with scoring command
    expect(settings.hooks.SessionEnd).toBeDefined();
    const sessionEndHooks = settings.hooks.SessionEnd.flatMap(
      (e: any) => e.hooks ?? [],
    );
    const hasScoring = sessionEndHooks.some(
      (h: any) => h.type === "command" && h.command.includes("agentgrit"),
    );
    expect(hasScoring).toBe(true);

    // PostToolUse hook present with tool audit command
    expect(settings.hooks.PostToolUse).toBeDefined();
    const postToolHooks = settings.hooks.PostToolUse.flatMap(
      (e: any) => e.hooks ?? [],
    );
    const hasToolAudit = postToolHooks.some(
      (h: any) => h.type === "command" && h.command.includes("agentgrit"),
    );
    expect(hasToolAudit).toBe(true);

    // Every hook entry has correct structure (type + command)
    for (const event of ["SessionStart", "SessionEnd", "PostToolUse"]) {
      for (const entry of settings.hooks[event]) {
        expect(entry).toHaveProperty("hooks");
        for (const h of entry.hooks) {
          expect(h).toHaveProperty("type", "command");
          expect(h).toHaveProperty("command");
          expect(typeof h.command).toBe("string");
        }
      }
    }

    // Existing config preserved
    expect(settings.model).toBe("claude-sonnet-4-20250514");
    expect(settings.permissions.allow).toEqual(["Read", "Bash"]);

    // Existing PreToolUse hook preserved
    const preToolHooks = settings.hooks.PreToolUse;
    expect(preToolHooks).toBeDefined();
    const existingHook = preToolHooks.find((e: any) =>
      e.hooks?.some((h: any) => h.command === "my-security-hook.sh"),
    );
    expect(existingHook).toBeDefined();
  });

  test("is idempotent — re-install skips existing hooks", async () => {
    const settingsPath = join(SANDBOX, "settings-idem.json");
    writeFileSync(settingsPath, "{}", "utf-8");

    const { installClaudeCodeHooks } = await import("../../src/adapters/discovery");

    const first = installClaudeCodeHooks(settingsPath);
    expect(first.installed).toBeGreaterThanOrEqual(2);

    const second = installClaudeCodeHooks(settingsPath);
    expect(second.installed).toBe(0);
    expect(second.existing).toBe(first.installed);
  });

  test("creates hooks in empty settings file", async () => {
    const settingsPath = join(SANDBOX, "empty-settings.json");
    writeFileSync(settingsPath, "{}", "utf-8");

    const { installClaudeCodeHooks } = await import("../../src/adapters/discovery");
    const result = installClaudeCodeHooks(settingsPath);

    expect(result.installed).toBeGreaterThanOrEqual(2);
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(settings.hooks).toBeDefined();
    expect(Object.keys(settings.hooks).length).toBeGreaterThanOrEqual(2);
  });
});
