import { describe, expect, test, afterAll } from "bun:test";
import { extractTaskFromTranscript, scoreMessage, type ExtractedTask } from "../../src/evaluate/task-extractor";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const testDirs: string[] = [];

function makeTmpDir(): string {
  const dir = join(tmpdir(), `task-extractor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  testDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of testDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeTranscript(dir: string, entries: Array<{ type: string; message?: { content: string | Array<{ type: string; text: string }> } }>): string {
  const filePath = join(dir, "test-session.jsonl");
  const lines = entries.map((e) => JSON.stringify(e));
  writeFileSync(filePath, lines.join("\n"));
  return filePath;
}

describe("scoreMessage", () => {
  test("low score for short ack messages", () => {
    expect(scoreMessage("yes")).toBeLessThan(0.3);
    expect(scoreMessage("sure go for it")).toBeLessThan(0.3);
    expect(scoreMessage("ok")).toBeLessThan(0.3);
    expect(scoreMessage("right")).toBeLessThan(0.3);
    expect(scoreMessage("yeah")).toBeLessThan(0.3);
  });

  test("low score for CONTEXT: prefixed messages", () => {
    expect(scoreMessage("CONTEXT: Assistant: Issue #201 closed. Now let me post the child closure")).toBeLessThan(0.3);
  });

  test("low score for local-command-caveat messages", () => {
    expect(scoreMessage("<local-command-caveat>Caveat: The messages below were generated</local-command-caveat>")).toBeLessThan(0.3);
  });

  test("high score for substantive task descriptions", () => {
    const score = scoreMessage("Fix the broken deploy pipeline by updating the Dockerfile and running integration tests");
    expect(score).toBeGreaterThan(0.6);
  });

  test("high score for messages with action verbs", () => {
    const score = scoreMessage("implement the new authentication middleware for the API gateway service");
    expect(score).toBeGreaterThan(0.6);
  });

  test("medium-high score for moderately long messages without verbs", () => {
    const score = scoreMessage("the dashboard is showing stale data and customers are complaining about it");
    expect(score).toBeGreaterThanOrEqual(0.3);
  });

  test("low score for 'another claude session' prefix", () => {
    expect(scoreMessage("another claude session starting up")).toBeLessThan(0.3);
  });

  test("low score for automated review messages", () => {
    expect(scoreMessage("Analyze these source file changes and documentation sections for factual inaccuracies")).toBeLessThan(0.3);
  });
});

describe("extractTaskFromTranscript", () => {
  test("returns first-message fallback for single user message", async () => {
    const dir = makeTmpDir();
    const filePath = writeTranscript(dir, [
      { type: "user", message: { content: "hello" } },
      { type: "assistant", message: { content: "hi there" } },
    ]);
    const result = await extractTaskFromTranscript(filePath);
    expect(result).not.toBeNull();
    expect(result.text).toBe("hello");
    expect(result.source).toBe("first-message");
    expect(result.confidence).toBeLessThanOrEqual(0.3);
  });

  test("skips garbage first message and finds substantive message", async () => {
    const dir = makeTmpDir();
    const filePath = writeTranscript(dir, [
      { type: "user", message: { content: "sure go for it" } },
      { type: "assistant", message: { content: "Starting work now..." } },
      { type: "user", message: { content: "fix the broken deploy pipeline by updating the Dockerfile and running integration tests" } },
      { type: "assistant", message: { content: "I'll work on that." } },
    ]);
    const result = await extractTaskFromTranscript(filePath);
    expect(result).not.toBeNull();
    expect(result.text).toContain("deploy pipeline");
    expect(result.source).toBe("substantive-message");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  test("detects issue reference in transcript", async () => {
    const dir = makeTmpDir();
    const filePath = writeTranscript(dir, [
      { type: "user", message: { content: "CONTEXT: previous agent output" } },
      { type: "assistant", message: { content: "Loading..." } },
      { type: "user", message: { content: "ship issue #214 on the agentgrit repo" } },
      { type: "assistant", message: { content: "Working on it" } },
    ]);
    const result = await extractTaskFromTranscript(filePath);
    expect(result).not.toBeNull();
    expect(result.source).toBe("issue-ref");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.text).toContain("#214");
  });

  test("detects git branch context", async () => {
    const dir = makeTmpDir();
    const filePath = writeTranscript(dir, [
      { type: "user", message: { content: "yes" } },
      { type: "assistant", message: { content: "Checking out branch 214-smart-task-extraction..." } },
      { type: "user", message: { content: "ok" } },
    ]);
    const result = await extractTaskFromTranscript(filePath);
    expect(result).not.toBeNull();
    expect(result.source).toBe("git-context");
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.text).toContain("214-smart-task-extraction");
  });

  test("handles content as array of blocks", async () => {
    const dir = makeTmpDir();
    const filePath = writeTranscript(dir, [
      { type: "user", message: { content: [{ type: "text", text: "implement the new caching layer for the API" }] } },
      { type: "assistant", message: { content: "On it." } },
    ]);
    const result = await extractTaskFromTranscript(filePath);
    expect(result).not.toBeNull();
    expect(result.text).toContain("caching layer");
    expect(result.source).toBe("substantive-message");
  });

  test("returns fallback for empty file", async () => {
    const dir = makeTmpDir();
    const filePath = join(dir, "empty.jsonl");
    writeFileSync(filePath, "");
    const result = await extractTaskFromTranscript(filePath);
    expect(result).not.toBeNull();
    expect(result.source).toBe("first-message");
  });

  test("prefers issue reference over substantive message", async () => {
    const dir = makeTmpDir();
    const filePath = writeTranscript(dir, [
      { type: "user", message: { content: "fix the authentication bug in the middleware" } },
      { type: "assistant", message: { content: "OK" } },
      { type: "user", message: { content: "this is issue #42 on the repo" } },
    ]);
    const result = await extractTaskFromTranscript(filePath);
    expect(result).not.toBeNull();
    expect(result.source).toBe("issue-ref");
    expect(result.text).toContain("#42");
  });

  test("handles CONTEXT: prefix messages by finding later substantive messages", async () => {
    const dir = makeTmpDir();
    const filePath = writeTranscript(dir, [
      { type: "user", message: { content: "CONTEXT: Assistant: Issue #201 closed. Now let me post the child closure to the umbrella #200." } },
      { type: "assistant", message: { content: "Continuing..." } },
      { type: "user", message: { content: "refactor the scoring algorithm to use weighted averages instead of simple means" } },
    ]);
    const result = await extractTaskFromTranscript(filePath);
    expect(result).not.toBeNull();
    expect(result.text).toContain("scoring algorithm");
    expect(result.source).toBe("substantive-message");
  });

  test("truncates very long task text", async () => {
    const dir = makeTmpDir();
    const longText = "implement " + "x".repeat(3000);
    const filePath = writeTranscript(dir, [
      { type: "user", message: { content: longText } },
    ]);
    const result = await extractTaskFromTranscript(filePath);
    expect(result).not.toBeNull();
    expect(result.text.length).toBeLessThanOrEqual(2000);
  });

  test("detects gh issue view command", async () => {
    const dir = makeTmpDir();
    const filePath = writeTranscript(dir, [
      { type: "user", message: { content: "ok" } },
      { type: "assistant", message: { content: "Let me check the issue: gh issue view 156 --repo hornjason/agentgrit" } },
      { type: "user", message: { content: "yes ship it" } },
    ]);
    const result = await extractTaskFromTranscript(filePath);
    expect(result).not.toBeNull();
    expect(result.source).toBe("issue-ref");
    expect(result.text).toContain("#156");
  });

  test("detects git checkout branch pattern", async () => {
    const dir = makeTmpDir();
    const filePath = writeTranscript(dir, [
      { type: "user", message: { content: "sure" } },
      { type: "assistant", message: { content: "git checkout -b 178-ag-test-runner" } },
      { type: "user", message: { content: "ok" } },
    ]);
    const result = await extractTaskFromTranscript(filePath);
    expect(result).not.toBeNull();
    expect(result.source).toBe("git-context");
    expect(result.text).toContain("178-ag-test-runner");
  });
});
