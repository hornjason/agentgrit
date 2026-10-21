/**
 * The iteration LEARN step hands its gap/root-cause/fix to AgentGrit (#253).
 *
 * Two questions are asked here, and they are different questions:
 *
 *   1. Does `captureIterationLearning` DELEGATE — i.e. is the tier it returns
 *      the tier `routeRule` gives for the same input when this test calls it
 *      directly, and is the learning file the one `writeLearnings` writes? A
 *      reimplementation that happened to agree on one input would pass a
 *      weaker test; the direct call is the control.
 *   2. Is the routing SHADOW — recorded in the artifact for calibration while
 *      the rules store is left exactly as it was? Asserted by reading the
 *      pending-rules and learned-rules files before and after.
 *
 * Both run against a sandboxed base dir and host dir. Nothing here may touch
 * the real `~/.agentgrit` or the real host config.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { routeRule } from "../../src/promote/router";
import { extractWorkLearnings } from "../../src/capture/corrections";
import { Tier, type Pattern } from "../../src/adapters/types";
import {
  captureIterationLearning,
  type IterationLearningInput,
} from "../../src/capture/iteration-learning";
import { learnedRulesFile, pendingRulesFile } from "../../src/adapters/paths";

const TEST_DIR = join(import.meta.dir, ".tmp-iteration-learning-test");
const HOST_DIR = join(TEST_DIR, "host");

const PREV = {
  base: process.env.AGENTGRIT_DIR,
  host: process.env.AGENTGRIT_HOST_DIR,
};

/** A multi-project, unmistakably behavioural fix — routes Global via routeRule. */
const BEHAVIOURAL_FIX =
  "Always verify and validate the evidence before asserting; read and check first.";

function input(over: Partial<IterationLearningInput> = {}): IterationLearningInput {
  return {
    gap: "LEARN step produced text nobody routed",
    rootCause: "The iteration loop never called the learning router",
    mechanicalFix: BEHAVIOURAL_FIX,
    artifactType: "iteration-loop",
    sessionId: "sess-253",
    projectHistory: ["proj-a", "proj-b"],
    ...over,
  };
}

/** What the file says, or null when it does not exist. Both are state. */
function snapshot(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, "signals"), { recursive: true });
  mkdirSync(join(TEST_DIR, "state"), { recursive: true });
  mkdirSync(HOST_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TEST_DIR;
  process.env.AGENTGRIT_HOST_DIR = HOST_DIR;
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = PREV.base ?? "";
  process.env.AGENTGRIT_HOST_DIR = PREV.host ?? "";
});

describe("captureIterationLearning", () => {
  test("delegates to extractWorkLearnings, routeRule and writeLearnings", () => {
    const opts = input();
    const result = captureIterationLearning(opts);
    expect(result).not.toBeNull();

    // ── routeRule, called directly on the same input ────────────────────────
    const pattern: Pattern = {
      id: "control",
      type: "iteration-gap",
      frequency: 1,
      sessions: opts.projectHistory!,
      severity: 5,
      candidateRule: opts.mechanicalFix,
    };
    const control = routeRule(pattern, opts.projectHistory!);
    expect(control.tier).toBe(Tier.Global);
    expect(result!.tier).toBe(control.tier);
    expect(result!.rationale).toBe(control.rationale);

    // ── extractWorkLearnings, called directly on the same input ─────────────
    const controlLearning = extractWorkLearnings({
      title: opts.gap,
      filesChanged: [opts.artifactType],
      toolsUsed: [],
      agentsSpawned: [],
      sessionId: opts.sessionId!,
    });
    expect(controlLearning).not.toBeNull();
    expect(result!.learning.category).toBe(controlLearning!.category);
    expect(result!.learning.title).toBe(controlLearning!.title);
    expect(result!.learning.filesChanged).toBe(controlLearning!.filesChanged);

    // ── writeLearnings: a real file, in the category subdirectory ───────────
    expect(result!.files.length).toBe(1);
    const written = result!.files[0];
    expect(existsSync(written)).toBe(true);
    expect(written.startsWith(TEST_DIR)).toBe(true);

    const body = readFileSync(written, "utf-8");
    expect(body).toContain(opts.gap);
    expect(body).toContain(opts.rootCause);
    expect(body).toContain(opts.mechanicalFix);
    expect(body).toContain(opts.artifactType);
  });

  test("returns the Project tier routeRule gives for a single-project history", () => {
    const opts = input({ projectHistory: ["only-one"] });
    const result = captureIterationLearning(opts);
    const control = routeRule(
      {
        id: "control",
        type: "iteration-gap",
        frequency: 1,
        sessions: opts.projectHistory!,
        severity: 5,
        candidateRule: opts.mechanicalFix,
      },
      opts.projectHistory!,
    );
    expect(result!.tier).toBe(Tier.Project);
    expect(result!.tier).toBe(control.tier);
  });

  test("shadow mode records the route in the artifact and leaves the rules store untouched", () => {
    const pending = pendingRulesFile();
    const learned = learnedRulesFile();

    // Seed both so "unchanged" is a comparison of content, not of absence —
    // two missing files compare equal no matter what the code did in between.
    mkdirSync(join(TEST_DIR), { recursive: true });
    writeFileSync(pending, "# Pending\n\n- pre-existing pending rule\n");
    writeFileSync(learned, "# Learned\n\n- pre-existing learned rule\n");

    const before = { pending: snapshot(pending), learned: snapshot(learned) };
    expect(before.pending).not.toBeNull();
    expect(before.learned).not.toBeNull();

    const result = captureIterationLearning(input());
    expect(result).not.toBeNull();

    const after = { pending: snapshot(pending), learned: snapshot(learned) };
    expect(after.pending).toBe(before.pending!);
    expect(after.learned).toBe(before.learned!);

    // …and the route is recorded where calibration can read it.
    expect(result!.shadow).toBe(true);
    const body = readFileSync(result!.files[0], "utf-8");
    expect(body).toContain(result!.tier);
    expect(body).toContain(result!.rationale);
    expect(body.toLowerCase()).toContain("shadow");
  });

  test("shadow mode writes no rules file when the rules store does not exist yet", () => {
    const pending = pendingRulesFile();
    const learned = learnedRulesFile();
    expect(existsSync(pending)).toBe(false);
    expect(existsSync(learned)).toBe(false);

    captureIterationLearning(input());

    expect(existsSync(pending)).toBe(false);
    expect(existsSync(learned)).toBe(false);
  });

  test("returns null when there is nothing to learn from", () => {
    expect(
      captureIterationLearning(input({ gap: "", artifactType: "" })),
    ).toBeNull();
  });
});
