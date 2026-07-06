import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parseRating, computeComposite } from "../../src/capture/rating";
import { SCHEMA_VERSION } from "../../src/adapters/types";
import { randomUUID } from "crypto";

const TMP_DIR = join(import.meta.dir, ".tmp-tier6");
const SIGNAL_DIR = join(TMP_DIR, "signals");

const NOISE_PATTERNS: RegExp[] = [
  /\bno\s+problem\b/i,
  /\bno\s+worries\b/i,
  /\bno\s+rush\b/i,
  /\bno\s+need\b/i,
  /\bno\s+thanks\b/i,
  /\bno\s+big\s+deal\b/i,
  /\bnot\s+(?:yet|now|sure|necessarily|bad)\b/i,
  /\bno\s+issue\b/i,
];

const CORRECTION_STARTERS: RegExp[] = [
  /^no\s/i,
  /^wrong\b/i,
  /^stop\b/i,
  /^don'?t\b/i,
  /^not\s+that\b/i,
  /^fix\b/i,
  /^undo\b/i,
  /^revert\b/i,
];

function appendJsonl(file: string, record: Record<string, unknown>): void {
  const dir = require("path").dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const { appendFileSync } = require("fs");
  appendFileSync(file, JSON.stringify(record) + "\n");
}

function simulateCaptureRating(content: string, sessionId: string, signalDir: string): boolean {
  const parsed = parseRating(content);
  if (!parsed) return false;

  const composite = computeComposite(parsed.mode, parsed.scope, parsed.quality);
  const record = {
    id: randomUUID(),
    type: "rating",
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    schemaVersion: SCHEMA_VERSION,
    rating: composite,
    source: "explicit",
    mode: parsed.mode,
    scope: parsed.scope,
    quality: parsed.quality,
    comment: parsed.comment,
  };

  appendJsonl(join(signalDir, "ratings.jsonl"), record);
  return true;
}

function simulateCaptureCorrection(content: string, sessionId: string, signalDir: string): boolean {
  if (NOISE_PATTERNS.some((p) => p.test(content))) return false;
  const isCorrection = CORRECTION_STARTERS.some((p) => p.test(content.trim()));
  if (!isCorrection) return false;

  const record = {
    id: randomUUID(),
    type: "correction",
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    schemaVersion: SCHEMA_VERSION,
    correction_phrase: content.slice(0, 300),
  };

  appendJsonl(join(signalDir, "corrections.jsonl"), record);
  return true;
}

function simulateCaptureTool(toolName: string, sessionId: string, signalDir: string): boolean {
  if (!toolName) return false;

  const record = {
    id: randomUUID(),
    type: "tool-use",
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    schemaVersion: SCHEMA_VERSION,
    tool_name: toolName,
  };

  appendJsonl(join(signalDir, "tool-audit.jsonl"), record);
  return true;
}

function simulateCaptureSkill(skillName: string, sessionId: string, signalDir: string): boolean {
  if (!skillName) return false;

  const record = {
    id: randomUUID(),
    type: "skill-invocation",
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    schemaVersion: SCHEMA_VERSION,
    skill: skillName,
  };

  appendJsonl(join(signalDir, "skill-invocations.jsonl"), record);
  return true;
}

describe("Tier 6: Capture Commands", () => {
  beforeEach(() => {
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
    mkdirSync(SIGNAL_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  });

  // T28: capture rating with /rate M:7 S:8 Q:6
  test("T28: capture rating writes entry with mode=7, scope=8, quality=6", () => {
    const wrote = simulateCaptureRating("/rate M:7 S:8 Q:6", "session-t28", SIGNAL_DIR);
    expect(wrote).toBe(true);

    const ratingsFile = join(SIGNAL_DIR, "ratings.jsonl");
    expect(existsSync(ratingsFile)).toBe(true);

    const content = readFileSync(ratingsFile, "utf-8").trim();
    const entry = JSON.parse(content);

    expect(entry.mode).toBe(7);
    expect(entry.scope).toBe(8);
    expect(entry.quality).toBe(6);
    expect(entry.type).toBe("rating");
    expect(entry.session_id).toBe("session-t28");
    expect(entry.schemaVersion).toBe(SCHEMA_VERSION);

    // Verify composite calculation
    const expectedComposite = Math.round((7 * 0.34 + 8 * 0.33 + 6 * 0.33) * 10) / 10;
    expect(entry.rating).toBeCloseTo(expectedComposite, 1);
  });

  // T29: capture correction with "no not that"
  test("T29: capture correction writes entry, filters 'no problem'", () => {
    // "no not that" should be captured
    const captured = simulateCaptureCorrection("no not that, try again", "session-t29", SIGNAL_DIR);
    expect(captured).toBe(true);

    const correctionsFile = join(SIGNAL_DIR, "corrections.jsonl");
    expect(existsSync(correctionsFile)).toBe(true);

    const content = readFileSync(correctionsFile, "utf-8").trim();
    const entry = JSON.parse(content);
    expect(entry.type).toBe("correction");
    expect(entry.correction_phrase).toContain("no not that");

    // "no problem" should be filtered out (noise)
    const filtered = simulateCaptureCorrection("no problem, that's fine", "session-t29b", SIGNAL_DIR);
    expect(filtered).toBe(false);

    // "no worries" should also be filtered
    const filtered2 = simulateCaptureCorrection("no worries about that", "session-t29c", SIGNAL_DIR);
    expect(filtered2).toBe(false);

    // "wrong approach" should be captured
    const captured2 = simulateCaptureCorrection("wrong approach, use the API instead", "session-t29d", SIGNAL_DIR);
    expect(captured2).toBe(true);
  });

  // T30: capture tool with Bash
  test("T30: capture tool writes tool_name=Bash", () => {
    const wrote = simulateCaptureTool("Bash", "session-t30", SIGNAL_DIR);
    expect(wrote).toBe(true);

    const toolFile = join(SIGNAL_DIR, "tool-audit.jsonl");
    expect(existsSync(toolFile)).toBe(true);

    const content = readFileSync(toolFile, "utf-8").trim();
    const entry = JSON.parse(content);
    expect(entry.tool_name).toBe("Bash");
    expect(entry.type).toBe("tool-use");
    expect(entry.session_id).toBe("session-t30");
  });

  // T31: capture skill with ship
  test("T31: capture skill writes skill=ship", () => {
    const wrote = simulateCaptureSkill("ship", "session-t31", SIGNAL_DIR);
    expect(wrote).toBe(true);

    const skillFile = join(SIGNAL_DIR, "skill-invocations.jsonl");
    expect(existsSync(skillFile)).toBe(true);

    const content = readFileSync(skillFile, "utf-8").trim();
    const entry = JSON.parse(content);
    expect(entry.skill).toBe("ship");
    expect(entry.type).toBe("skill-invocation");
    expect(entry.session_id).toBe("session-t31");
  });

  // T32: All captures exit 0 on invalid input (no crashes)
  test("T32: all captures handle invalid input without crashing", () => {
    // Rating: invalid format
    expect(() => simulateCaptureRating("garbage input", "s1", SIGNAL_DIR)).not.toThrow();
    expect(simulateCaptureRating("garbage input", "s1", SIGNAL_DIR)).toBe(false);

    // Rating: out of range (11)
    expect(simulateCaptureRating("/rate M:11 S:5 Q:5", "s2", SIGNAL_DIR)).toBe(false);

    // Rating: zero
    expect(simulateCaptureRating("/rate M:0 S:5 Q:5", "s3", SIGNAL_DIR)).toBe(false);

    // Correction: empty string
    expect(() => simulateCaptureCorrection("", "s4", SIGNAL_DIR)).not.toThrow();

    // Tool: empty tool name
    expect(() => simulateCaptureTool("", "s5", SIGNAL_DIR)).not.toThrow();
    expect(simulateCaptureTool("", "s5", SIGNAL_DIR)).toBe(false);

    // Skill: empty skill name
    expect(() => simulateCaptureSkill("", "s6", SIGNAL_DIR)).not.toThrow();
    expect(simulateCaptureSkill("", "s6", SIGNAL_DIR)).toBe(false);

    // Rating: malformed JSON-like input
    expect(() => simulateCaptureRating("{broken: json", "s7", SIGNAL_DIR)).not.toThrow();
  });
});
