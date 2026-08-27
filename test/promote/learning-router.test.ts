import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { routeLearning } from "../../src/promote/router";
import type { RoutedLearning } from "../../src/adapters/types";
import { existsSync, unlinkSync, readFileSync } from "fs";
import { join } from "path";

function makeSignal(overrides: Partial<RoutedLearning> = {}): RoutedLearning {
  return {
    type: "mechanical-fix",
    content: "Always run tests before committing",
    evidence: "3 failures traced to untested commits",
    sourceIssue: 207,
    sourcePass: 1,
    confidence: 0.85,
    timestamp: new Date().toISOString(),
    learnStepId: "learn-001",
    ...overrides,
  };
}

describe("routeLearning", () => {
  // ── 4 type routing tests (AC-3 #208) ──

  test("mechanical-fix routes to template with low trust (direct-write)", () => {
    const result = routeLearning(makeSignal({ type: "mechanical-fix" }));
    expect(result.destination).toBe("template");
    expect(result.trustTier).toBe("low");
    expect(result.action).toBe("direct-write");
    expect(result.rationale).toContain("mechanical-fix");
  });

  test("mechanical-fix with gate artifactType routes to gate with high trust (queue)", () => {
    const result = routeLearning(
      makeSignal({ type: "mechanical-fix", artifactType: "gate" }),
    );
    expect(result.destination).toBe("gate");
    expect(result.trustTier).toBe("high");
    expect(result.action).toBe("queue-for-promotion");
  });

  test("mechanical-fix with both artifactType routes to both with low trust", () => {
    const result = routeLearning(
      makeSignal({ type: "mechanical-fix", artifactType: "both" }),
    );
    expect(result.destination).toBe("both");
    expect(result.trustTier).toBe("low");
    expect(result.action).toBe("direct-write");
  });

  test("process-rule routes to claude-md with high trust (queue)", () => {
    const result = routeLearning(makeSignal({ type: "process-rule" }));
    expect(result.destination).toBe("claude-md");
    expect(result.trustTier).toBe("high");
    expect(result.action).toBe("queue-for-promotion");
    expect(result.rationale).toContain("process-rule");
  });

  test("domain-knowledge routes to feedback-memory with low trust (direct-write)", () => {
    const result = routeLearning(makeSignal({ type: "domain-knowledge" }));
    expect(result.destination).toBe("feedback-memory");
    expect(result.trustTier).toBe("low");
    expect(result.action).toBe("direct-write");
    expect(result.rationale).toContain("domain-knowledge");
  });

  test("judgment routes to questionnaire with low trust (direct-write)", () => {
    const result = routeLearning(makeSignal({ type: "judgment" }));
    expect(result.destination).toBe("questionnaire");
    expect(result.trustTier).toBe("low");
    expect(result.action).toBe("direct-write");
    expect(result.rationale).toContain("judgment");
  });

  // ── Confidence boundary (AC-4 #208) ──

  test("confidence below 0.7 routes to incidents regardless of type", () => {
    const result = routeLearning(
      makeSignal({ type: "process-rule", confidence: 0.69 }),
    );
    expect(result.destination).toBe("incidents");
    expect(result.trustTier).toBe("low");
    expect(result.action).toBe("incident-log");
    expect(result.rationale).toContain("confidence");
  });

  test("confidence exactly 0.7 does NOT route to incidents", () => {
    const result = routeLearning(
      makeSignal({ type: "process-rule", confidence: 0.7 }),
    );
    expect(result.destination).toBe("claude-md");
    expect(result.action).not.toBe("incident-log");
  });

  test("confidence at 0.0 routes to incidents", () => {
    const result = routeLearning(
      makeSignal({ type: "mechanical-fix", confidence: 0.0 }),
    );
    expect(result.destination).toBe("incidents");
    expect(result.action).toBe("incident-log");
  });

  // ── Shadow mode (AC-5 #208) ──

  const shadowLogPath = join(
    import.meta.dir,
    "../../shadow-routing.jsonl",
  );

  afterEach(() => {
    // Clean up shadow log if created
    try {
      if (existsSync(shadowLogPath)) unlinkSync(shadowLogPath);
    } catch {}
  });

  test("shadow mode returns shadow-log action instead of real action", () => {
    const result = routeLearning(makeSignal({ type: "process-rule" }), {
      shadowMode: true,
    });
    expect(result.action).toBe("shadow-log");
    // Destination and trustTier still computed for observability
    expect(result.destination).toBe("claude-md");
    expect(result.trustTier).toBe("high");
  });

  test("shadow mode with low confidence still shows incidents destination", () => {
    const result = routeLearning(
      makeSignal({ type: "process-rule", confidence: 0.5 }),
      { shadowMode: true },
    );
    expect(result.action).toBe("shadow-log");
    expect(result.destination).toBe("incidents");
  });

  // ── Rationale includes debugging info ──

  test("rationale includes type, confidence, and destination", () => {
    const result = routeLearning(
      makeSignal({ type: "domain-knowledge", confidence: 0.92 }),
    );
    expect(result.rationale).toContain("domain-knowledge");
    expect(result.rationale).toContain("0.92");
    expect(result.rationale).toContain("feedback-memory");
  });
});
