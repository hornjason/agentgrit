import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { captureToolUse } from "../../src/capture/tool-audit";

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

describe("captureToolUse", () => {
  test("writes audit entry to tool-audit.jsonl", async () => {
    await captureToolUse("Bash", { command: "ls -la" }, "test-session");

    const filePath = join(TMP_DIR, "signals", "tool-audit.jsonl");
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.toolName).toBe("Bash");
    expect(parsed.argsSummary).toContain("command");
    expect(parsed.sessionId).toBe("test-session");
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
});
