import { describe, test, expect } from "bun:test";
import {
  generateHookConfig,
  categorizeChange,
  parseToolUseBlocks,
  isSignificantChange,
  classifyLearning,
  isLearningCapture,
} from "../../src/capture/index";
import type { FileChange } from "../../src/capture/index";

describe("generateHookConfig", () => {
  test("returns valid hook config with 6 hooks", () => {
    const config = generateHookConfig();

    expect(config).toBeDefined();
    expect(config.hooks).toBeDefined();

    const allHooks: { matcher: string; command: string }[] = [];
    for (const entries of Object.values(config.hooks)) {
      for (const entry of entries) {
        allHooks.push(entry);
      }
    }

    expect(allHooks).toHaveLength(6);
  });

  test("has UserPromptSubmit hooks", () => {
    const config = generateHookConfig();
    expect(config.hooks.UserPromptSubmit).toBeDefined();
    expect(config.hooks.UserPromptSubmit).toHaveLength(3);
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

describe("categorizeChange", () => {
  test("categorizes skill files", () => {
    expect(categorizeChange("skills/Research/SKILL.md")).toBe("skill");
  });

  test("categorizes workflow files", () => {
    expect(categorizeChange("skills/Research/Workflows/deep.md")).toBe("workflow");
  });

  test("categorizes hook files", () => {
    expect(categorizeChange("hooks/RatingCapture.hook.ts")).toBe("hook");
  });

  test("categorizes config files", () => {
    expect(categorizeChange("settings.json")).toBe("config");
  });

  test("categorizes documentation", () => {
    expect(categorizeChange("docs/ARCHITECTURE.md")).toBe("documentation");
  });

  test("excludes MEMORY/WORK paths", () => {
    expect(categorizeChange("MEMORY/WORK/session/PRD.md")).toBeNull();
  });

  test("excludes MEMORY/LEARNING paths", () => {
    expect(categorizeChange("MEMORY/LEARNING/SIGNALS/ratings.jsonl")).toBeNull();
  });

  test("excludes node_modules", () => {
    expect(categorizeChange("node_modules/bun/index.ts")).toBeNull();
  });
});

describe("parseToolUseBlocks", () => {
  test("extracts Write and Edit tool calls from transcript", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Write", input: { file_path: "/home/user/.claude/hooks/test.ts" } },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Edit", input: { file_path: "/home/user/.claude/skills/ship/SKILL.md" } },
          ],
        },
      }),
    ];

    const changes = parseToolUseBlocks(lines);
    expect(changes).toHaveLength(2);
    expect(changes[0].tool).toBe("Write");
    expect(changes[1].tool).toBe("Edit");
  });

  test("deduplicates paths", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Edit", input: { file_path: "src/main.ts" } },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Edit", input: { file_path: "src/main.ts" } },
          ],
        },
      }),
    ];

    const changes = parseToolUseBlocks(lines);
    expect(changes).toHaveLength(1);
  });

  test("normalizes paths relative to baseDir", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Write", input: { file_path: "/home/user/project/src/file.ts" } },
          ],
        },
      }),
    ];

    const changes = parseToolUseBlocks(lines, "/home/user/project");
    expect(changes[0].path).toBe("src/file.ts");
  });

  test("skips non-file tools", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
          ],
        },
      }),
    ];

    const changes = parseToolUseBlocks(lines);
    expect(changes).toHaveLength(0);
  });

  test("skips malformed lines", () => {
    const lines = ["not json", '{"type": "user"}'];
    const changes = parseToolUseBlocks(lines);
    expect(changes).toHaveLength(0);
  });
});

describe("isSignificantChange", () => {
  test("returns false for no changes", () => {
    expect(isSignificantChange([])).toBe(false);
  });

  test("returns false for only excluded paths", () => {
    const changes: FileChange[] = [
      { tool: "Write", path: "MEMORY/WORK/session/file.md", category: null },
    ];
    expect(isSignificantChange(changes)).toBe(false);
  });

  test("returns true for skill changes", () => {
    const changes: FileChange[] = [
      { tool: "Edit", path: "skills/ship/SKILL.md", category: "skill" },
    ];
    expect(isSignificantChange(changes)).toBe(true);
  });

  test("returns true for hook changes", () => {
    const changes: FileChange[] = [
      { tool: "Write", path: "hooks/new-hook.ts", category: "hook" },
    ];
    expect(isSignificantChange(changes)).toBe(true);
  });

  test("returns true for 2+ system changes", () => {
    const changes: FileChange[] = [
      { tool: "Edit", path: "docs/README.md", category: "documentation" },
      { tool: "Edit", path: "docs/GUIDE.md", category: "documentation" },
    ];
    expect(isSignificantChange(changes)).toBe(true);
  });
});

describe("classifyLearning", () => {
  test("classifies approach errors", () => {
    expect(classifyLearning("wrong approach to the database migration")).toBe("approach");
    expect(classifyLearning("over-engineered the solution")).toBe("approach");
    expect(classifyLearning("missed the point of the request")).toBe("approach");
  });

  test("classifies tooling issues", () => {
    expect(classifyLearning("hook crash on session end")).toBe("tooling");
    expect(classifyLearning("broken config deployment")).toBe("tooling");
    expect(classifyLearning("bun import module not found")).toBe("tooling");
  });

  test("defaults to approach for ambiguous text", () => {
    expect(classifyLearning("some generic learning note")).toBe("approach");
  });

  test("uses comment for classification", () => {
    expect(classifyLearning("session note", "wrong approach")).toBe("approach");
  });
});

describe("isLearningCapture", () => {
  test("returns true for text with 2+ learning indicators", () => {
    expect(isLearningCapture("found the bug and fixed the error")).toBe(true);
    expect(isLearningCapture("investigated root cause, discovered the issue")).toBe(true);
  });

  test("returns false for text with < 2 indicators", () => {
    expect(isLearningCapture("updated the readme")).toBe(false);
    expect(isLearningCapture("deployed to production")).toBe(false);
  });

  test("includes summary in analysis", () => {
    expect(isLearningCapture("some text", "problem fixed and resolved")).toBe(true);
  });
});
