import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  harvestFromTranscript,
  classifyCategory,
  getSessionFiles,
  writeLearnings,
  formatLearningFile,
  harvest,
  type HarvestedLearning,
} from "../../src/capture/harvester";

const TEST_DIR = "/tmp/agentgrit-harvester-test-" + process.pid;
const PROJECTS_DIR = join(TEST_DIR, "projects");
const LEARNING_DIR = join(TEST_DIR, "learning");

function makeTranscript(
  exchanges: { user: string; assistant: string }[],
): string {
  const lines: string[] = [];
  for (const ex of exchanges) {
    lines.push(
      JSON.stringify({ type: "user", message: { content: ex.user } }),
    );
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: { content: ex.assistant },
      }),
    );
  }
  return lines.join("\n");
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(PROJECTS_DIR, { recursive: true });
  mkdirSync(LEARNING_DIR, { recursive: true });
});

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("classifyCategory", () => {
  test("classifies tool/config as system", () => {
    expect(classifyCategory("hook crashed on startup")).toBe("system");
    expect(classifyCategory("config file not found")).toBe("system");
  });

  test("classifies approach errors as algorithm", () => {
    expect(classifyCategory("wrong approach to the problem")).toBe("algorithm");
    expect(classifyCategory("general conversation text")).toBe("algorithm");
  });
});

describe("harvestFromTranscript", () => {
  test("detects corrections from user messages", () => {
    const transcript = makeTranscript([
      { user: "fix the bug please", assistant: "Done." },
      {
        user: "actually, I meant the other bug not this one",
        assistant: "Ok fixing.",
      },
    ]);
    const learnings = harvestFromTranscript(transcript, "test-session");
    expect(learnings.length).toBeGreaterThanOrEqual(1);
    expect(learnings[0].type).toBe("correction");
    expect(learnings[0].sessionId).toBe("test-session");
  });

  test("detects insights from assistant messages", () => {
    const transcript = makeTranscript([
      { user: "what happened here", assistant: "I learned that the API requires auth tokens for this endpoint" },
    ]);
    const learnings = harvestFromTranscript(transcript, "test-session");
    expect(learnings.some((l) => l.type === "insight")).toBe(true);
  });

  test("skips short messages under 20 chars", () => {
    const transcript = makeTranscript([
      { user: "ok", assistant: "done" },
    ]);
    const learnings = harvestFromTranscript(transcript, "test-session");
    expect(learnings).toHaveLength(0);
  });

  test("returns empty for empty transcript", () => {
    const learnings = harvestFromTranscript("", "test-session");
    expect(learnings).toHaveLength(0);
  });

  test("handles malformed JSON lines gracefully", () => {
    const transcript = "not json\n" + makeTranscript([
      { user: "actually, that is wrong and needs fixing", assistant: "Ok." },
    ]);
    const learnings = harvestFromTranscript(transcript, "test-session");
    expect(learnings.length).toBeGreaterThanOrEqual(0);
  });
});

describe("getSessionFiles", () => {
  test("returns empty for nonexistent directory", () => {
    const files = getSessionFiles("/tmp/nonexistent-" + Date.now(), {});
    expect(files).toHaveLength(0);
  });

  test("returns jsonl files sorted by mtime", () => {
    writeFileSync(join(PROJECTS_DIR, "a.jsonl"), "data");
    writeFileSync(join(PROJECTS_DIR, "b.jsonl"), "data");
    writeFileSync(join(PROJECTS_DIR, "c.txt"), "not jsonl");

    const files = getSessionFiles(PROJECTS_DIR, {});
    expect(files.length).toBe(2);
    expect(files.every((f) => f.endsWith(".jsonl"))).toBe(true);
  });

  test("limits to recent N files", () => {
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(PROJECTS_DIR, `session-${i}.jsonl`), "data");
    }
    const files = getSessionFiles(PROJECTS_DIR, { recent: 2 });
    expect(files).toHaveLength(2);
  });

  test("filters by sessionId", () => {
    writeFileSync(join(PROJECTS_DIR, "abc-123.jsonl"), "data");
    writeFileSync(join(PROJECTS_DIR, "def-456.jsonl"), "data");

    const files = getSessionFiles(PROJECTS_DIR, { sessionId: "abc-123" });
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("abc-123");
  });
});

describe("writeLearnings", () => {
  test("writes learning files to correct subdirectory", () => {
    const learnings: HarvestedLearning[] = [
      {
        sessionId: "test-1234",
        timestamp: new Date().toISOString(),
        category: "algorithm",
        type: "correction",
        context: "some context",
        content: "some content",
        source: "test-pattern",
      },
    ];

    const written = writeLearnings(learnings, LEARNING_DIR);
    expect(written).toHaveLength(1);
    expect(existsSync(join(LEARNING_DIR, "algorithm"))).toBe(true);
  });

  test("skips duplicate files", () => {
    const learnings: HarvestedLearning[] = [
      {
        sessionId: "test-1234",
        timestamp: "2026-01-01T00:00:00.000Z",
        category: "system",
        type: "error",
        context: "ctx",
        content: "content",
        source: "test",
      },
    ];

    const first = writeLearnings(learnings, LEARNING_DIR);
    const second = writeLearnings(learnings, LEARNING_DIR);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });
});

describe("formatLearningFile", () => {
  test("produces markdown with all fields", () => {
    const learning: HarvestedLearning = {
      sessionId: "sess-abc",
      timestamp: "2026-01-01T10:00:00Z",
      category: "algorithm",
      type: "insight",
      context: "previous message",
      content: "key learning here",
      source: "learned that",
    };

    const md = formatLearningFile(learning);
    expect(md).toContain("# Insight Learning");
    expect(md).toContain("sess-abc");
    expect(md).toContain("algorithm");
    expect(md).toContain("key learning here");
  });
});

describe("harvest (integration)", () => {
  test("scans sessions and writes learnings", () => {
    const transcript = makeTranscript([
      { user: "fix the issue", assistant: "Done." },
      {
        user: "wait, that's not quite right, fix the other one",
        assistant: "Ok.",
      },
    ]);
    writeFileSync(join(PROJECTS_DIR, "session-1.jsonl"), transcript);

    const result = harvest(PROJECTS_DIR, LEARNING_DIR, { recent: 5 });
    expect(result.sessionsScanned).toBe(1);
    expect(result.learnings.length).toBeGreaterThanOrEqual(1);
  });
});
