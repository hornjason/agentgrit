import { describe, test, expect } from "bun:test";
import {
  buildCohorts,
  generateAntiRationalizations,
} from "../../src/detect/theme-cohorts";
import type { Pattern } from "../../src/adapters/types";

function makePattern(
  id: string,
  type: string,
  frequency: number,
  severity: number,
  candidateRule?: string,
): Pattern {
  return {
    id,
    type,
    frequency,
    sessions: [`session-${id}`],
    severity,
    candidateRule,
  };
}

describe("buildCohorts", () => {
  test("groups patterns into cohorts by theme", () => {
    const patterns: Pattern[] = [
      makePattern("p1", "failure", 5, 8, "verify before asserting claims"),
      makePattern("p2", "failure", 3, 6, "incomplete delivery scope misread"),
      makePattern("p3", "failure", 4, 7, "delegate agent routing failed"),
    ];

    const cohorts = buildCohorts(patterns);
    expect(cohorts.length).toBeGreaterThan(0);

    const names = cohorts.map((c) => c.name);
    expect(names).toContain("verification");
    expect(names).toContain("scope");
    expect(names).toContain("delegation");
  });

  test("computes aggregate stats per cohort", () => {
    const patterns: Pattern[] = [
      makePattern("p1", "failure", 5, 8, "verify before asserting"),
      makePattern("p2", "failure", 3, 6, "verify evidence check"),
    ];

    const cohorts = buildCohorts(patterns);
    const verificationCohort = cohorts.find((c) => c.name === "verification");
    expect(verificationCohort).toBeDefined();
    expect(verificationCohort!.totalFrequency).toBe(8);
    expect(verificationCohort!.avgSeverity).toBe(7);
    expect(verificationCohort!.patterns).toHaveLength(2);
  });

  test("empty patterns produce empty cohorts", () => {
    const cohorts = buildCohorts([]);
    expect(cohorts).toHaveLength(0);
  });

  test("cohorts are sorted by totalFrequency descending", () => {
    const patterns: Pattern[] = [
      makePattern("p1", "failure", 2, 5, "verify check"),
      makePattern("p2", "failure", 10, 7, "deploy test build pipeline gate"),
      makePattern("p3", "failure", 5, 6, "scope incomplete delivery"),
    ];

    const cohorts = buildCohorts(patterns);
    for (let i = 1; i < cohorts.length; i++) {
      expect(cohorts[i].totalFrequency).toBeLessThanOrEqual(
        cohorts[i - 1].totalFrequency,
      );
    }
  });

  test("verification cohort is not ablatable", () => {
    const patterns: Pattern[] = [
      makePattern("p1", "failure", 5, 8, "verify before asserting"),
    ];

    const cohorts = buildCohorts(patterns);
    const verificationCohort = cohorts.find((c) => c.name === "verification");
    expect(verificationCohort).toBeDefined();
    expect(verificationCohort!.ablatable).toBe(false);
  });
});

describe("generateAntiRationalizations", () => {
  test("generates anti-rationalization shortcuts from cohorts", () => {
    const patterns: Pattern[] = [
      makePattern("p1", "failure", 5, 8, "verify before asserting"),
      makePattern("p2", "failure", 3, 6, "scope incomplete delivery"),
    ];

    const cohorts = buildCohorts(patterns);
    const antiRats = generateAntiRationalizations(cohorts);
    expect(antiRats.length).toBeGreaterThan(0);
    expect(antiRats[0].shortcut).toBeDefined();
    expect(antiRats[0].rebuttal).toBeDefined();
    expect(antiRats[0].evidence).toBeDefined();
    expect(antiRats[0].frequency).toBeGreaterThan(0);
  });

  test("anti-rationalizations sorted by frequency", () => {
    const patterns: Pattern[] = [
      makePattern("p1", "failure", 10, 8, "verify check"),
      makePattern("p2", "failure", 2, 6, "scope delivery"),
      makePattern("p3", "failure", 7, 7, "test build deploy process"),
    ];

    const cohorts = buildCohorts(patterns);
    const antiRats = generateAntiRationalizations(cohorts);

    for (let i = 1; i < antiRats.length; i++) {
      expect(antiRats[i].frequency).toBeLessThanOrEqual(
        antiRats[i - 1].frequency,
      );
    }
  });

  test("empty cohorts produce empty anti-rationalizations", () => {
    const antiRats = generateAntiRationalizations([]);
    expect(antiRats).toHaveLength(0);
  });
});
