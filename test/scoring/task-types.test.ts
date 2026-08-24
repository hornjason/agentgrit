import { describe, it, expect } from "bun:test";
import { detectTaskType, getOutcomeWeights, type TaskType } from "../../src/scoring/task-types";

describe("detectTaskType", () => {
  it("detects ship from implementation keywords", () => {
    expect(detectTaskType("ship the new auth feature")).toBe("ship");
    expect(detectTaskType("implement user login")).toBe("ship");
    expect(detectTaskType("fix the broken sidebar")).toBe("ship");
    expect(detectTaskType("build the dashboard")).toBe("ship");
  });

  it("detects research from investigation keywords", () => {
    expect(detectTaskType("investigate why the scraper fails")).toBe("research");
    expect(detectTaskType("research best practices for caching")).toBe("research");
    expect(detectTaskType("find out how the auth middleware works")).toBe("research");
  });

  it("detects design from planning keywords", () => {
    expect(detectTaskType("design the new scoring architecture")).toBe("design");
    expect(detectTaskType("plan the migration strategy")).toBe("design");
    expect(detectTaskType("architect the notification system")).toBe("design");
  });

  it("detects debug from diagnostic keywords", () => {
    expect(detectTaskType("debug the flaky test")).toBe("debug");
    expect(detectTaskType("diagnose the memory leak")).toBe("debug");
    expect(detectTaskType("trace why requests are timing out")).toBe("debug");
  });

  it("detects config from setup keywords", () => {
    expect(detectTaskType("configure the CI pipeline")).toBe("config");
    expect(detectTaskType("setup the development environment")).toBe("config");
    expect(detectTaskType("install the new dependencies")).toBe("config");
  });

  it("returns unknown for ambiguous prompts", () => {
    expect(detectTaskType("hello")).toBe("unknown");
    expect(detectTaskType("")).toBe("unknown");
    expect(detectTaskType("what do you think about this?")).toBe("unknown");
  });

  it("is case-insensitive", () => {
    expect(detectTaskType("SHIP the feature")).toBe("ship");
    expect(detectTaskType("Research the API")).toBe("research");
  });
});

describe("getOutcomeWeights", () => {
  it("returns default weights for ship tasks", () => {
    const weights = getOutcomeWeights("ship");
    expect(weights["commit-merged"]).toBe(1.0);
    expect(weights["tests-pass"]).toBe(0.8);
    expect(weights["issue-closed"]).toBe(1.0);
    expect(weights["correction"]).toBe(-0.3);
  });

  it("returns research-specific weights", () => {
    const weights = getOutcomeWeights("research");
    expect(weights["commit-merged"]).toBe(0.3);
    expect(weights["tests-pass"]).toBe(0.3);
    expect(weights["issue-closed"]).toBe(0.5);
  });

  it("returns debug-specific weights", () => {
    const weights = getOutcomeWeights("debug");
    expect(weights["tests-pass"]).toBe(1.5);
    expect(weights["correction"]).toBe(-0.2);
  });

  it("returns ship weights for unknown task type", () => {
    const weights = getOutcomeWeights("unknown");
    expect(weights["commit-merged"]).toBe(1.0);
    expect(weights["tests-pass"]).toBe(0.8);
  });

  it("returns weights for all outcome types", () => {
    const types: TaskType[] = ["ship", "research", "design", "debug", "config", "unknown"];
    for (const t of types) {
      const weights = getOutcomeWeights(t);
      expect(weights["commit-merged"]).toBeDefined();
      expect(weights["tests-pass"]).toBeDefined();
      expect(weights["correction"]).toBeDefined();
      expect(weights["reprompt"]).toBeDefined();
    }
  });
});
