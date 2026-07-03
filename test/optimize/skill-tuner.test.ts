import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tuneSkill } from "../../src/optimize/skill-tuner";
import type { SkillEvaluator, SkillProposer, SkillEvalResult } from "../../src/optimize/skill-tuner";

const TMP_DIR = join(import.meta.dir, ".tmp-skill-tuner-test");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

function makeEvalResult(composite: number, criteria: { name: string; passed: boolean }[]): SkillEvalResult {
  return {
    compositeScore: composite,
    behavioralScore: composite * 0.7,
    taskSuccessProxy: composite * 0.3,
    perCriteria: criteria,
  };
}

describe("tuneSkill", () => {
  test("improvement is applied when evaluator score increases", async () => {
    // hillClimb calls evaluate for baseline (0.5), then tuneSkill also calls evaluator once before hillClimb.
    // tuneSkill calls evaluator once (baseline), then hillClimb calls evaluate twice (baseline + proposal).
    // So total evaluate calls: 1 (tuneSkill baseline) + 1 (hillClimb baseline) + 1 (proposal) = 3
    let evalCount = 0;
    const evaluator: SkillEvaluator = {
      evaluate: async () => {
        evalCount++;
        // First two calls are baselines (tuneSkill + hillClimb), third is proposal
        const score = evalCount <= 2 ? 0.5 : 0.8;
        return makeEvalResult(
          score,
          [
            { name: "clarity", passed: evalCount > 2 },
            { name: "completeness", passed: true },
          ],
        );
      },
    };

    const proposer: SkillProposer = {
      propose: async (text, lowestCriteria) => {
        expect(lowestCriteria).toContain("clarity");
        return text + "\n- Added clarity step";
      },
    };

    const skillText = "# Skill\n" + "- Step instruction line that is long enough to allow small changes\n".repeat(10);
    const result = await tuneSkill({
      skillText,
      evaluator,
      proposer,
      rounds: 1,
      stateDir: TMP_DIR,
    });

    expect(result.finalScore).toBeGreaterThan(result.initialScore);
    expect(result.roundsKept).toBe(1);
    expect(result.bestText).toContain("Added clarity step");
  });

  test("regression is discarded", async () => {
    let evalCount = 0;
    const evaluator: SkillEvaluator = {
      evaluate: async () => {
        evalCount++;
        // First two calls are baselines, third is proposal (worse)
        const score = evalCount <= 2 ? 0.7 : 0.4;
        return makeEvalResult(
          score,
          [
            { name: "clarity", passed: true },
            { name: "completeness", passed: evalCount <= 2 },
          ],
        );
      },
    };

    const proposer: SkillProposer = {
      propose: async (text) => text + " worse change",
    };

    const skillText = "# Skill\n" + "- Step instruction line that is long enough to allow small changes\n".repeat(10);
    const result = await tuneSkill({
      skillText,
      evaluator,
      proposer,
      rounds: 1,
      stateDir: TMP_DIR,
    });

    expect(result.finalScore).toBe(result.initialScore);
    expect(result.roundsKept).toBe(0);
    expect(result.bestText).toBe(skillText);
  });

  test("lowest criteria are extracted from failing criteria", async () => {
    let evalCount = 0;
    const capturedCriteria: string[][] = [];

    const evaluator: SkillEvaluator = {
      evaluate: async () => {
        evalCount++;
        return makeEvalResult(0.5 + evalCount * 0.05, [
          { name: "verification", passed: false },
          { name: "environment-check", passed: true },
          { name: "single-hypothesis", passed: false },
        ]);
      },
    };

    const proposer: SkillProposer = {
      propose: async (text, criteria) => {
        capturedCriteria.push([...criteria]);
        return text + " fix";
      },
    };

    await tuneSkill({
      skillText: "# Skill\n" + "- Step instruction line that is long enough to allow small changes\n".repeat(10),
      evaluator,
      proposer,
      rounds: 2,
      stateDir: TMP_DIR,
    });

    expect(capturedCriteria.length).toBeGreaterThanOrEqual(1);
    for (const criteria of capturedCriteria) {
      expect(criteria).toContain("verification");
      expect(criteria).toContain("single-hypothesis");
    }
  });

  test("result includes hill climb details", async () => {
    // tuneSkill baseline + hillClimb baseline + 3 proposals = 5 calls
    const scores = [0.2, 0.2, 0.4, 0.6, 0.8];
    let idx = 0;
    const evaluator: SkillEvaluator = {
      evaluate: async () => {
        const score = scores[idx++] ?? 0.8;
        return makeEvalResult(score, [{ name: "a", passed: score > 0.3 }]);
      },
    };

    const proposer: SkillProposer = {
      propose: async (text) => text + ".",
    };

    const skillText = "x".repeat(200);
    const result = await tuneSkill({
      skillText,
      evaluator,
      proposer,
      rounds: 3,
      stateDir: TMP_DIR,
    });

    expect(result.hillClimbResult).toBeDefined();
    expect(result.hillClimbResult.rounds).toHaveLength(3);
    expect(result.originalText).toBe(skillText);
  });
});
