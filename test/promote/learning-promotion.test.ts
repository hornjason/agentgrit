import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, existsSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  queueLearning,
  directWriteLearning,
  processPromotionQueue,
  routeLearning,
} from "../../src/promote/router";
import type {
  RoutedLearning,
  LearningRouteResult,
} from "../../src/adapters/types";
import type { IncidentRecord } from "../../src/capture/incidents";

// ── Helpers ──

const TEST_DIR = join(import.meta.dir, ".tmp-promotion-test");
const QUEUE_PATH = join(TEST_DIR, "promotions-queue.jsonl");
const WRITES_PATH = join(TEST_DIR, "learning-writes.jsonl");

function makeSignal(overrides: Partial<RoutedLearning> = {}): RoutedLearning {
  return {
    type: "mechanical-fix",
    content: "Always run tests before committing",
    evidence: "3 failures traced to untested commits",
    sourceIssue: 209,
    sourcePass: 1,
    confidence: 0.85,
    timestamp: new Date().toISOString(),
    learnStepId: "learn-promo-001",
    ...overrides,
  };
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

// ── #209 AC-1: queueLearning writes high-trust items ──

describe("queueLearning", () => {
  test("writes high-trust item to promotions-queue.jsonl with required fields", () => {
    const signal = makeSignal({ type: "process-rule", confidence: 0.9 });
    const route: LearningRouteResult = {
      destination: "claude-md",
      trustTier: "high",
      action: "queue-for-promotion",
      rationale: "process-rule → claude-md",
    };

    queueLearning(signal, route, QUEUE_PATH);

    const entries = readJsonl<Record<string, unknown>>(QUEUE_PATH);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe(signal.content);
    expect(entries[0].trustTier).toBe("high");
    expect(entries[0].destination).toBe("claude-md");
    expect(entries[0].type).toBe("process-rule");
    expect(entries[0].confidence).toBe(0.9);
    expect(entries[0].queuedAt).toBeDefined();
    expect(entries[0].learnStepId).toBe("learn-promo-001");
  });

  test("appends multiple items to same queue file", () => {
    const signal1 = makeSignal({ type: "process-rule", learnStepId: "l-1" });
    const signal2 = makeSignal({
      type: "mechanical-fix",
      artifactType: "gate",
      learnStepId: "l-2",
    });
    const route1: LearningRouteResult = {
      destination: "claude-md",
      trustTier: "high",
      action: "queue-for-promotion",
      rationale: "",
    };
    const route2: LearningRouteResult = {
      destination: "gate",
      trustTier: "high",
      action: "queue-for-promotion",
      rationale: "",
    };

    queueLearning(signal1, route1, QUEUE_PATH);
    queueLearning(signal2, route2, QUEUE_PATH);

    const entries = readJsonl<Record<string, unknown>>(QUEUE_PATH);
    expect(entries).toHaveLength(2);
  });
});

// ── #209 AC-2: processPromotionQueue escalates / expires ──

describe("processPromotionQueue", () => {
  test("items less than 14 days old remain in queue", () => {
    const recent = JSON.stringify({
      content: "Recent rule",
      destination: "claude-md",
      trustTier: "high",
      type: "process-rule",
      confidence: 0.9,
      queuedAt: new Date().toISOString(),
      learnStepId: "l-recent",
    });
    writeFileSync(QUEUE_PATH, recent + "\n");

    const result = processPromotionQueue(QUEUE_PATH);
    expect(result.kept).toBe(1);
    expect(result.escalated).toHaveLength(0);
    expect(result.expired).toHaveLength(0);
  });

  test("gate patches >= 14 days old are escalated", () => {
    const old = new Date();
    old.setDate(old.getDate() - 15);
    const entry = JSON.stringify({
      content: "Old gate rule",
      destination: "gate",
      trustTier: "high",
      type: "mechanical-fix",
      confidence: 0.95,
      queuedAt: old.toISOString(),
      learnStepId: "l-old-gate",
    });
    writeFileSync(QUEUE_PATH, entry + "\n");

    const result = processPromotionQueue(QUEUE_PATH);
    expect(result.kept).toBe(0);
    expect(result.escalated).toHaveLength(1);
    expect(result.escalated[0].destination).toBe("gate");
    expect(result.expired).toHaveLength(0);
  });

  test("template patches >= 14 days old are expired (removed)", () => {
    const old = new Date();
    old.setDate(old.getDate() - 15);
    const entry = JSON.stringify({
      content: "Old template rule",
      destination: "template",
      trustTier: "high",
      type: "mechanical-fix",
      confidence: 0.88,
      queuedAt: old.toISOString(),
      learnStepId: "l-old-template",
    });
    writeFileSync(QUEUE_PATH, entry + "\n");

    const result = processPromotionQueue(QUEUE_PATH);
    expect(result.kept).toBe(0);
    expect(result.escalated).toHaveLength(0);
    expect(result.expired).toHaveLength(1);
    expect(result.expired[0].destination).toBe("template");
  });

  test("claude-md patches >= 14 days old are escalated", () => {
    const old = new Date();
    old.setDate(old.getDate() - 14);
    const entry = JSON.stringify({
      content: "Old claude-md rule",
      destination: "claude-md",
      trustTier: "high",
      type: "process-rule",
      confidence: 0.92,
      queuedAt: old.toISOString(),
      learnStepId: "l-old-cmd",
    });
    writeFileSync(QUEUE_PATH, entry + "\n");

    const result = processPromotionQueue(QUEUE_PATH);
    expect(result.kept).toBe(0);
    expect(result.escalated).toHaveLength(1);
    expect(result.escalated[0].destination).toBe("claude-md");
  });

  test("mixed queue: keeps recent, escalates old gates, expires old templates", () => {
    const old = new Date();
    old.setDate(old.getDate() - 16);
    const entries = [
      { content: "Recent", destination: "claude-md", trustTier: "high", type: "process-rule", confidence: 0.9, queuedAt: new Date().toISOString(), learnStepId: "l-1" },
      { content: "Old gate", destination: "gate", trustTier: "high", type: "mechanical-fix", confidence: 0.95, queuedAt: old.toISOString(), learnStepId: "l-2" },
      { content: "Old template", destination: "template", trustTier: "high", type: "mechanical-fix", confidence: 0.88, queuedAt: old.toISOString(), learnStepId: "l-3" },
    ];
    writeFileSync(QUEUE_PATH, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const result = processPromotionQueue(QUEUE_PATH);
    expect(result.kept).toBe(1);
    expect(result.escalated).toHaveLength(1); // gate escalates
    expect(result.expired).toHaveLength(1);   // template expires
  });

  test("returns empty result when queue file does not exist", () => {
    const result = processPromotionQueue(join(TEST_DIR, "nonexistent.jsonl"));
    expect(result.kept).toBe(0);
    expect(result.escalated).toHaveLength(0);
    expect(result.expired).toHaveLength(0);
  });
});

// ── #209 AC-3: IncidentRecord has learning_type and confidence ──

describe("IncidentRecord extension", () => {
  test("IncidentRecord accepts learning_type and confidence fields", () => {
    const record: IncidentRecord = {
      timestamp: new Date().toISOString(),
      session_id: "test-session",
      error_snippet: "low confidence signal",
      error_type: "learning-routing",
      command_preview: "routeLearning",
      learning_type: "process-rule",
      confidence: 0.5,
    };
    expect(record.learning_type).toBe("process-rule");
    expect(record.confidence).toBe(0.5);
  });

  test("IncidentRecord still works without learning_type (backward compat)", () => {
    const record: IncidentRecord = {
      timestamp: new Date().toISOString(),
      session_id: "test-session",
      error_snippet: "regular error",
      error_type: "TypeError",
      command_preview: "bun test",
    };
    expect(record.learning_type).toBeUndefined();
    expect(record.confidence).toBeUndefined();
  });
});

// ── #209 AC-4: directWriteLearning with 90-day TTL ──

describe("directWriteLearning", () => {
  test("writes record with expiresAt = timestamp + 90 days", () => {
    const signal = makeSignal({ type: "domain-knowledge", confidence: 0.8 });
    const route: LearningRouteResult = {
      destination: "feedback-memory",
      trustTier: "low",
      action: "direct-write",
      rationale: "domain-knowledge → feedback-memory",
    };

    directWriteLearning(signal, route, WRITES_PATH);

    const entries = readJsonl<Record<string, unknown>>(WRITES_PATH);
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry.content).toBe(signal.content);
    expect(entry.destination).toBe("feedback-memory");
    expect(entry.type).toBe("domain-knowledge");
    expect(entry.expiresAt).toBeDefined();

    // Verify 90-day TTL
    const writtenAt = new Date(entry.writtenAt as string);
    const expiresAt = new Date(entry.expiresAt as string);
    const daysDiff = Math.round(
      (expiresAt.getTime() - writtenAt.getTime()) / (1000 * 60 * 60 * 24),
    );
    expect(daysDiff).toBe(90);
  });

  test("appends multiple direct-write records", () => {
    const signal1 = makeSignal({ type: "domain-knowledge", learnStepId: "d-1" });
    const signal2 = makeSignal({ type: "judgment", learnStepId: "d-2" });
    const route1: LearningRouteResult = {
      destination: "feedback-memory",
      trustTier: "low",
      action: "direct-write",
      rationale: "",
    };
    const route2: LearningRouteResult = {
      destination: "questionnaire",
      trustTier: "low",
      action: "direct-write",
      rationale: "",
    };

    directWriteLearning(signal1, route1, WRITES_PATH);
    directWriteLearning(signal2, route2, WRITES_PATH);

    const entries = readJsonl<Record<string, unknown>>(WRITES_PATH);
    expect(entries).toHaveLength(2);
    expect(entries[0].destination).toBe("feedback-memory");
    expect(entries[1].destination).toBe("questionnaire");
  });
});

// ── #209 AC-5: routeLearning wiring (execute mode) ──

describe("routeLearning execute mode", () => {
  test("queue-for-promotion action writes to queue file", () => {
    const signal = makeSignal({ type: "process-rule", confidence: 0.9 });
    const result = routeLearning(signal, {
      dataDir: TEST_DIR,
    });
    expect(result.action).toBe("queue-for-promotion");

    const entries = readJsonl<Record<string, unknown>>(QUEUE_PATH);
    expect(entries).toHaveLength(1);
    expect(entries[0].destination).toBe("claude-md");
  });

  test("direct-write action writes to writes file", () => {
    const signal = makeSignal({ type: "domain-knowledge", confidence: 0.8 });
    const result = routeLearning(signal, {
      dataDir: TEST_DIR,
    });
    expect(result.action).toBe("direct-write");

    const entries = readJsonl<Record<string, unknown>>(WRITES_PATH);
    expect(entries).toHaveLength(1);
    expect(entries[0].destination).toBe("feedback-memory");
    expect(entries[0].expiresAt).toBeDefined();
  });

  test("shadow mode does not write any files", () => {
    const signal = makeSignal({ type: "process-rule", confidence: 0.9 });
    routeLearning(signal, {
      shadowMode: true,
      dataDir: TEST_DIR,
    });

    expect(existsSync(QUEUE_PATH)).toBe(false);
    expect(existsSync(WRITES_PATH)).toBe(false);
  });

  test("incident-log action records to incidents file with learning_type", () => {
    const signal = makeSignal({ type: "process-rule", confidence: 0.5 });
    const result = routeLearning(signal, {
      dataDir: TEST_DIR,
    });
    expect(result.action).toBe("incident-log");

    const incPath = join(TEST_DIR, "learning-incidents.jsonl");
    const entries = readJsonl<IncidentRecord>(incPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].learning_type).toBe("process-rule");
    expect(entries[0].confidence).toBe(0.5);
  });
});
