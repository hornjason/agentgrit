import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { detectCorrection } from "../../src/capture/corrections";

const TMP_DIR = join(import.meta.dir, ".tmp-corrections-test");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

describe("detectCorrection", () => {
  test("detects 'no not like that'", async () => {
    const signal = await detectCorrection(
      "no not like that, use the other approach",
      "I refactored the function.",
      "test-session",
    );
    expect(signal).not.toBeNull();
    expect(signal!.type).toBe("correction");
    expect(signal!.correction_phrase).toBeTruthy();
  });

  test("detects 'stop doing'", async () => {
    const signal = await detectCorrection(
      "stop doing that, it breaks the build",
      "I added the configuration.",
      "test-session",
    );
    expect(signal).not.toBeNull();
    expect(signal!.type).toBe("correction");
  });

  test("detects 'wrong'", async () => {
    const signal = await detectCorrection(
      "wrong, the API is at /v2 not /v1",
      "I called the /v1 endpoint.",
      "test-session",
    );
    expect(signal).not.toBeNull();
  });

  test("detects 'I didn't ask for'", async () => {
    const signal = await detectCorrection(
      "I didn't ask for a refactor, just fix the bug",
      "I refactored the module.",
      "test-session",
    );
    expect(signal).not.toBeNull();
    expect(signal!.correction_phrase).toBeTruthy();
  });

  test("returns null for 'no problem'", async () => {
    const signal = await detectCorrection(
      "no problem, that works",
      "Done.",
      "test-session",
    );
    expect(signal).toBeNull();
  });

  test("returns null for 'no worries'", async () => {
    const signal = await detectCorrection(
      "no worries, keep going",
      "Working on it.",
      "test-session",
    );
    expect(signal).toBeNull();
  });

  test("returns null for 'don't worry'", async () => {
    const signal = await detectCorrection(
      "don't worry about that edge case",
      "I'll handle it.",
      "test-session",
    );
    expect(signal).toBeNull();
  });

  test("returns null for 'don't forget'", async () => {
    const signal = await detectCorrection(
      "don't forget to update the docs",
      "Will do.",
      "test-session",
    );
    expect(signal).toBeNull();
  });

  test("returns null for neutral messages", async () => {
    const signal = await detectCorrection(
      "can you check the logs?",
      "Sure.",
      "test-session",
    );
    expect(signal).toBeNull();
  });

  test("writes to corrections.jsonl", async () => {
    await detectCorrection(
      "that's wrong, the endpoint is different",
      "I used /api/v1.",
      "test-session",
    );

    const filePath = join(TMP_DIR, "signals", "corrections.jsonl");
    expect(existsSync(filePath)).toBe(true);
    const line = readFileSync(filePath, "utf-8").trim();
    const parsed = JSON.parse(line);
    expect(parsed.type).toBe("correction");
    expect(parsed.session_id).toBe("test-session");
  });
});
