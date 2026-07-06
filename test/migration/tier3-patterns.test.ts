import { describe, test, expect } from "bun:test";
import { existsSync } from "fs";
import { resolveSignalDir } from "../../src/adapters/paths";
import { detectFailurePatterns } from "../../src/detect/failures";
import { minePatterns } from "../../src/detect/patterns";
import { buildCohorts, generateAntiRationalizations } from "../../src/detect/theme-cohorts";
import type { Pattern } from "../../src/adapters/types";

const signalDir = resolveSignalDir();
const hasSignals = existsSync(signalDir);

describe("Tier 3: Pattern Detection", () => {
  let failurePatterns: Pattern[];

  test("T13 — Detect failure patterns from corrections", async () => {
    if (!hasSignals) return expect().pass();
    // threshold=1 to include all keyword-similarity groups
    failurePatterns = await detectFailurePatterns(signalDir, 1);
    expect(failurePatterns.length).toBeGreaterThanOrEqual(100);
  });

  test("T14 — Severity scoring varies", async () => {
    if (!hasSignals) return expect().pass();
    if (!failurePatterns) failurePatterns = await detectFailurePatterns(signalDir, 1);
    expect(failurePatterns.length).toBeGreaterThan(1);

    const severities = failurePatterns.map((p) => p.severity);
    const min = Math.min(...severities);
    const max = Math.max(...severities);
    expect(min).not.toBe(max);
  });

  test("T15 — Rule candidate text is descriptive", async () => {
    if (!hasSignals) return expect().pass();
    if (!failurePatterns) failurePatterns = await detectFailurePatterns(signalDir, 1);

    for (const pattern of failurePatterns) {
      if (!pattern.candidateRule) continue;
      const words = pattern.candidateRule.split(/\s+/);
      expect(words.length).toBeGreaterThan(3);

      const isRepetitive = /^(\w+;\s*)+\1{2,}/.test(pattern.candidateRule);
      expect(isRepetitive).toBe(false);
    }
  });

  test("T16 — Pattern mining finds low-rating patterns", async () => {
    if (!hasSignals) return expect().pass();
    const patterns = await minePatterns(signalDir);
    expect(patterns.length).toBeGreaterThan(0);

    const lowRated = patterns.filter((p) => p.type === "low-rating-with-corrections");
    expect(lowRated.length).toBeGreaterThanOrEqual(1);
  });

  test("T17 — Theme cohort assignment", async () => {
    if (!hasSignals) return expect().pass();
    if (!failurePatterns) failurePatterns = await detectFailurePatterns(signalDir, 1);

    const cohorts = buildCohorts(failurePatterns);
    // Real PAI corrections cluster into 2 cohorts (verification + scope);
    // all 5 definitions exist but patterns must match keywords to land there
    expect(cohorts.length).toBeGreaterThanOrEqual(2);

    for (const cohort of cohorts) {
      expect(cohort.patterns.length).toBeGreaterThanOrEqual(1);
      expect(cohort.name.length).toBeGreaterThan(0);
    }
  });

  test("T18 — Anti-rationalization generation", async () => {
    if (!hasSignals) return expect().pass();
    if (!failurePatterns) failurePatterns = await detectFailurePatterns(signalDir, 1);

    const cohorts = buildCohorts(failurePatterns);
    const rebuttals = generateAntiRationalizations(cohorts);
    expect(rebuttals.length).toBeGreaterThanOrEqual(2);

    for (const r of rebuttals) {
      expect(r.shortcut.length).toBeGreaterThan(0);
      expect(r.rebuttal.length).toBeGreaterThan(0);
      expect(r.evidence.length).toBeGreaterThan(0);
      expect(r.frequency).toBeGreaterThan(0);
    }
  });
});
