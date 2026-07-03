import { describe, test, expect } from "bun:test";
import { generateHookConfig } from "../../src/capture/index";

describe("generateHookConfig", () => {
  test("returns valid hook config with 5 hooks", () => {
    const config = generateHookConfig();

    expect(config).toBeDefined();
    expect(config.hooks).toBeDefined();

    const allHooks: { matcher: string; command: string }[] = [];
    for (const entries of Object.values(config.hooks)) {
      for (const entry of entries) {
        allHooks.push(entry);
      }
    }

    expect(allHooks).toHaveLength(5);
  });

  test("has UserPromptSubmit hooks", () => {
    const config = generateHookConfig();
    expect(config.hooks.UserPromptSubmit).toBeDefined();
    expect(config.hooks.UserPromptSubmit).toHaveLength(2);
  });

  test("has PostToolUse hooks", () => {
    const config = generateHookConfig();
    expect(config.hooks.PostToolUse).toBeDefined();
    expect(config.hooks.PostToolUse).toHaveLength(2);

    const skillHook = config.hooks.PostToolUse.find(
      (h) => h.matcher === "Skill",
    );
    expect(skillHook).toBeDefined();

    const auditHook = config.hooks.PostToolUse.find(
      (h) => h.matcher === ".*",
    );
    expect(auditHook).toBeDefined();
  });

  test("has SessionEnd hook", () => {
    const config = generateHookConfig();
    expect(config.hooks.SessionEnd).toBeDefined();
    expect(config.hooks.SessionEnd).toHaveLength(1);
  });

  test("all hooks have command strings", () => {
    const config = generateHookConfig();

    for (const [_event, entries] of Object.entries(config.hooks)) {
      for (const entry of entries) {
        expect(typeof entry.command).toBe("string");
        expect(entry.command.length).toBeGreaterThan(0);
        expect(typeof entry.matcher).toBe("string");
      }
    }
  });

  test("hook config is valid JSON-serializable", () => {
    const config = generateHookConfig();
    const json = JSON.stringify(config);
    const reparsed = JSON.parse(json);

    expect(reparsed.hooks).toBeDefined();
    expect(Object.keys(reparsed.hooks)).toHaveLength(3);
  });
});
