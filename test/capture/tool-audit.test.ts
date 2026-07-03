import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  captureToolUse,
  categorizeToolName,
  buildMinimalAudit,
} from "../../src/capture/tool-audit";

const TMP_DIR = join(import.meta.dir, ".tmp-tool-audit-test");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

describe("categorizeToolName", () => {
  test("categorizes Read as file-read", () => {
    expect(categorizeToolName("Read")).toBe("file-read");
  });

  test("categorizes Write as file-write", () => {
    expect(categorizeToolName("Write")).toBe("file-write");
  });

  test("categorizes Edit as file-write", () => {
    expect(categorizeToolName("Edit")).toBe("file-write");
  });

  test("categorizes Bash as shell", () => {
    expect(categorizeToolName("Bash")).toBe("shell");
  });

  test("categorizes WebSearch as search", () => {
    expect(categorizeToolName("WebSearch")).toBe("search");
  });

  test("categorizes Skill as skill", () => {
    expect(categorizeToolName("Skill")).toBe("skill");
  });

  test("categorizes Agent as agent", () => {
    expect(categorizeToolName("Agent")).toBe("agent");
  });

  test("categorizes mcp__ prefixed tools as mcp", () => {
    expect(categorizeToolName("mcp__basic_memory__search")).toBe("mcp");
  });

  test("categorizes unknown tools as other", () => {
    expect(categorizeToolName("CustomTool")).toBe("other");
  });
});

describe("buildMinimalAudit", () => {
  test("builds ok audit for successful tool", () => {
    const audit = buildMinimalAudit("Bash", false);
    expect(audit.tool).toBe("Bash");
    expect(audit.ok).toBe(true);
    expect(audit.category).toBe("shell");
    expect(audit.ts).toBeTruthy();
  });

  test("builds error audit for failed tool", () => {
    const audit = buildMinimalAudit("Edit", true);
    expect(audit.tool).toBe("Edit");
    expect(audit.ok).toBe(false);
    expect(audit.category).toBe("file-write");
  });
});

describe("captureToolUse", () => {
  test("writes audit entry to tool-audit.jsonl", async () => {
    await captureToolUse("Bash", { command: "ls -la" }, "test-session");

    const filePath = join(TMP_DIR, "signals", "tool-audit.jsonl");
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.toolName).toBe("Bash");
    expect(parsed.argsSummary).toContain("command");
    expect(parsed.session_id).toBe("test-session");
    expect(parsed.category).toBe("shell");
    expect(parsed.ok).toBe(true);
  });

  test("summarizes args with truncation", async () => {
    const longValue = "x".repeat(200);
    await captureToolUse("Read", { file_path: longValue }, "test-session");

    const filePath = join(TMP_DIR, "signals", "tool-audit.jsonl");
    const content = readFileSync(filePath, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.argsSummary.length).toBeLessThan(200);
    expect(parsed.argsSummary).toContain("...");
  });

  test("handles empty args", async () => {
    await captureToolUse("WebSearch", {}, "test-session");

    const filePath = join(TMP_DIR, "signals", "tool-audit.jsonl");
    const content = readFileSync(filePath, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.argsSummary).toBe("{}");
  });

  test("limits arg keys to 5", async () => {
    const manyArgs: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) {
      manyArgs[`key${i}`] = `value${i}`;
    }

    await captureToolUse("Edit", manyArgs, "test-session");

    const filePath = join(TMP_DIR, "signals", "tool-audit.jsonl");
    const content = readFileSync(filePath, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.argsSummary).toContain("+5 more");
  });

  test("records error state when isError is true", async () => {
    await captureToolUse("Bash", { command: "false" }, "test-session", {
      isError: true,
    });

    const filePath = join(TMP_DIR, "signals", "tool-audit.jsonl");
    const content = readFileSync(filePath, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.ok).toBe(false);
  });
});
