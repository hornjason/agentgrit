import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { RatingSignal } from "../../src/adapters/types";
import {
  generateAutoReflection,
  appendReflections,
} from "../../src/daemon/auto-reflection";
import { loadReflections } from "../../src/optimize/skill-synthesizer";

const TEST_DIR = "/tmp/agentgrit-auto-reflection-test-" + process.pid;

const savedKeys: Record<string, string | undefined> = {};
const API_KEY_VARS = ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

beforeAll(() => {
  // AC: the whole file passes with no API key in the environment.
  for (const v of API_KEY_VARS) {
    savedKeys[v] = process.env[v];
    delete process.env[v];
  }
});

afterAll(() => {
  for (const v of API_KEY_VARS) {
    if (savedKeys[v] === undefined) delete process.env[v];
    else process.env[v] = savedKeys[v];
  }
});

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function makeRating(overrides: Partial<RatingSignal> = {}): RatingSignal {
  return {
    type: "rating",
    timestamp: "2026-10-20T10:00:00.000Z",
    session_id: "sess-a",
    rating: 5,
    source: "explicit",
    ...overrides,
  } as RatingSignal;
}

describe("generateAutoReflection", () => {
  test("produces exactly one entry per distinct session_id", () => {
    const reflections = generateAutoReflection([
      makeRating({ session_id: "sess-a", rating: 4 }),
      makeRating({ session_id: "sess-b", rating: 7 }),
      makeRating({ session_id: "sess-a", rating: 6 }),
      makeRating({ session_id: "sess-c", rating: 9 }),
      makeRating({ session_id: "sess-b", rating: 3 }),
    ]);

    expect(reflections).toHaveLength(3);
    expect(reflections.map((r) => r.session_id)).toEqual(["sess-a", "sess-b", "sess-c"]);
  });

  test("implied_sentiment is the arithmetic mean of the session's ratings", () => {
    const reflections = generateAutoReflection([
      makeRating({ session_id: "mixed", rating: 2 }),
      makeRating({ session_id: "mixed", rating: 4 }),
      makeRating({ session_id: "mixed", rating: 9 }),
    ]);

    expect(reflections).toHaveLength(1);
    expect(reflections[0]!.implied_sentiment).toBe(5);
  });

  test("mean is not rounded to an integer", () => {
    const reflections = generateAutoReflection([
      makeRating({ session_id: "s", rating: 4 }),
      makeRating({ session_id: "s", rating: 5 }),
    ]);

    expect(reflections[0]!.implied_sentiment).toBe(4.5);
  });

  test("entries carry a non-empty task_description and a timestamp", () => {
    const reflections = generateAutoReflection([
      makeRating({ session_id: "sess-a", timestamp: "2026-10-19T08:00:00.000Z" }),
      makeRating({ session_id: "sess-a", timestamp: "2026-10-19T09:30:00.000Z" }),
    ]);

    const entry = reflections[0]!;
    expect(typeof entry.task_description).toBe("string");
    expect(entry.task_description.trim().length).toBeGreaterThan(0);
    expect(entry.timestamp).toBe("2026-10-19T09:30:00.000Z");
    expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false);
  });

  test("uses rating comment text in the task_description when present", () => {
    const reflections = generateAutoReflection([
      makeRating({ session_id: "sess-a", comment: "fix the container startup race" }),
    ]);

    expect(reflections[0]!.task_description).toContain("fix the container startup race");
  });

  test("ignores ratings with a non-numeric rating value", () => {
    const reflections = generateAutoReflection([
      makeRating({ session_id: "sess-a", rating: 6 }),
      makeRating({ session_id: "sess-a", rating: Number.NaN }),
      { ...makeRating({ session_id: "sess-a" }), rating: undefined as unknown as number },
    ]);

    expect(reflections).toHaveLength(1);
    expect(reflections[0]!.implied_sentiment).toBe(6);
  });

  test("returns an empty list for no input", () => {
    expect(generateAutoReflection([])).toEqual([]);
  });

  test("loadReflections() accepts the generated entries", () => {
    const path = join(TEST_DIR, "memory", "algorithm-reflections.jsonl");
    const generated = generateAutoReflection([
      makeRating({ session_id: "sess-a", rating: 8 }),
      makeRating({ session_id: "sess-b", rating: 3 }),
    ]);

    appendReflections(path, generated);

    const loaded = loadReflections(path);
    expect(loaded).toHaveLength(2);
    expect(loaded.map((r) => r.implied_sentiment)).toEqual([8, 3]);
    expect(loaded.every((r) => typeof r.task_description === "string" && r.task_description.trim())).toBe(true);
  });

  test("the module imports nothing from the inference adapter", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "..", "src", "daemon", "auto-reflection.ts"),
      "utf-8",
    );
    expect(source).not.toContain("adapters/inference");
    expect(source).not.toMatch(/\binference\s*\(/);
  });
});

describe("appendReflections", () => {
  test("creates the file and its parent directory when absent", () => {
    const path = join(TEST_DIR, "nested", "deeper", "algorithm-reflections.jsonl");
    expect(existsSync(path)).toBe(false);

    appendReflections(path, generateAutoReflection([makeRating({ session_id: "s1" })]));

    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8").trim().split("\n")).toHaveLength(1);
  });

  test("writes one JSON object per line", () => {
    const path = join(TEST_DIR, "reflections.jsonl");
    appendReflections(
      path,
      generateAutoReflection([
        makeRating({ session_id: "s1", rating: 2 }),
        makeRating({ session_id: "s2", rating: 4 }),
        makeRating({ session_id: "s3", rating: 6 }),
      ]),
    );

    const lines = readFileSync(path, "utf-8").split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(typeof parsed.session_id).toBe("string");
    }
  });

  test("appends to an existing file rather than overwriting it", () => {
    const path = join(TEST_DIR, "reflections.jsonl");
    writeFileSync(
      path,
      JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", task_description: "pre-existing" }) + "\n",
    );

    appendReflections(path, generateAutoReflection([makeRating({ session_id: "s1", rating: 7 })]));
    appendReflections(path, generateAutoReflection([makeRating({ session_id: "s2", rating: 1 })]));

    const loaded = loadReflections(path);
    expect(loaded).toHaveLength(3);
    expect(loaded[0]!.task_description).toBe("pre-existing");
    expect(loaded[1]!.implied_sentiment).toBe(7);
    expect(loaded[2]!.implied_sentiment).toBe(1);
  });

  test("a file whose last line lacks a trailing newline stays one object per line", () => {
    const path = join(TEST_DIR, "reflections.jsonl");
    writeFileSync(path, JSON.stringify({ task_description: "no trailing newline" }));

    appendReflections(path, generateAutoReflection([makeRating({ session_id: "s1" })]));

    const lines = readFileSync(path, "utf-8").split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(2);
    expect(() => lines.map((l) => JSON.parse(l))).not.toThrow();
  });

  test("writing an empty list leaves no file behind", () => {
    const path = join(TEST_DIR, "empty", "reflections.jsonl");
    appendReflections(path, []);
    expect(existsSync(path)).toBe(false);
  });
});
