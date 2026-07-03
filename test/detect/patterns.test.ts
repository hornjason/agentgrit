import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { appendSignal } from "../../src/adapters/jsonl";
import { minePatterns } from "../../src/detect/patterns";
import type {
  RatingSignal,
  CorrectionSignal,
  SkillInvocationSignal,
} from "../../src/adapters/types";
import { SCHEMA_VERSION } from "../../src/adapters/types";

const TMP_DIR = join(import.meta.dir, ".tmp-patterns-test");

function makeRating(id: string, sessionId: string, rating: number): RatingSignal {
  return {
    id,
    type: "rating",
    timestamp: new Date().toISOString(),
    sessionId,
    schemaVersion: SCHEMA_VERSION,
    rating,
    source: "explicit",
  };
}

function makeCorrection(
  id: string,
  sessionId: string,
  trigger: string,
  severity = 5,
): CorrectionSignal {
  return {
    id,
    type: "correction",
    timestamp: new Date().toISOString(),
    sessionId,
    schemaVersion: SCHEMA_VERSION,
    trigger,
    context: `Context for ${trigger}`,
    severity,
  };
}

function makeSkillInvocation(
  id: string,
  sessionId: string,
  skillName: string,
  success: boolean,
): SkillInvocationSignal {
  return {
    id,
    type: "skill-invocation",
    timestamp: new Date().toISOString(),
    sessionId,
    schemaVersion: SCHEMA_VERSION,
    skillName,
    trigger: "test trigger",
    success,
  };
}

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

describe("minePatterns", () => {
  test("cross-signal correlation: low ratings + corrections produce patterns", async () => {
    const ratingsFile = join(TMP_DIR, "ratings.jsonl");
    const correctionsFile = join(TMP_DIR, "corrections.jsonl");

    for (let i = 0; i < 3; i++) {
      await appendSignal(ratingsFile, makeRating(`r${i}`, `sess-${i}`, 3));
      await appendSignal(
        correctionsFile,
        makeCorrection(`c${i}`, `sess-${i}`, "wrong approach taken"),
      );
    }

    const patterns = await minePatterns(TMP_DIR);
    const lowRatingPattern = patterns.find(
      (p) => p.type === "low-rating-with-corrections",
    );
    expect(lowRatingPattern).toBeDefined();
    expect(lowRatingPattern!.sessions.length).toBeGreaterThanOrEqual(2);
  });

  test("skill miss patterns detected across sessions", async () => {
    const skillsFile = join(TMP_DIR, "skills.jsonl");

    for (let i = 0; i < 3; i++) {
      await appendSignal(
        skillsFile,
        makeSkillInvocation(`s${i}`, `sess-${i}`, "ship", false),
      );
    }

    const patterns = await minePatterns(TMP_DIR);
    const skillMiss = patterns.find((p) => p.type === "skill-miss");
    expect(skillMiss).toBeDefined();
    expect(skillMiss!.candidateRule).toContain("ship");
  });

  test("empty signal dir produces 0 patterns", async () => {
    const patterns = await minePatterns(TMP_DIR);
    expect(patterns.length).toBe(0);
  });

  test("high ratings with no corrections produce no low-rating patterns", async () => {
    const ratingsFile = join(TMP_DIR, "ratings.jsonl");

    for (let i = 0; i < 5; i++) {
      await appendSignal(ratingsFile, makeRating(`r${i}`, `sess-${i}`, 9));
    }

    const patterns = await minePatterns(TMP_DIR);
    const lowRating = patterns.find(
      (p) => p.type === "low-rating-with-corrections",
    );
    expect(lowRating).toBeUndefined();
  });

  test("patterns are sorted by severity descending", async () => {
    const ratingsFile = join(TMP_DIR, "ratings.jsonl");
    const correctionsFile = join(TMP_DIR, "corrections.jsonl");
    const skillsFile = join(TMP_DIR, "skills.jsonl");

    for (let i = 0; i < 3; i++) {
      await appendSignal(ratingsFile, makeRating(`r${i}`, `sess-${i}`, 2));
      await appendSignal(
        correctionsFile,
        makeCorrection(`c${i}`, `sess-${i}`, "wrong", 9),
      );
      await appendSignal(
        skillsFile,
        makeSkillInvocation(`s${i}`, `sess-${i}`, "tdd", false),
      );
    }

    const patterns = await minePatterns(TMP_DIR);
    for (let i = 1; i < patterns.length; i++) {
      expect(patterns[i].severity).toBeLessThanOrEqual(patterns[i - 1].severity);
    }
  });
});
