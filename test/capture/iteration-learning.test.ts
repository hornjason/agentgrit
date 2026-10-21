/**
 * #253 — the iteration loop's LEARN step and this package's learning router
 * were two systems that never touched: the step produced prose, and
 * `routeRule`/`writeLearnings` sat live and uncalled next to it.
 *
 * `captureIterationLearning` is the join. These cases hold the two properties
 * that make it a join rather than a third implementation of the same thing:
 *
 *  1. the category of the written artifact comes from `extractWorkLearnings`
 *     and the tier comes from `routeRule` — both read back from the artifact
 *     the real `writeLearnings` put on disk, not from the return value alone;
 *  2. routing is SHADOW — recorded for calibration, applied to nothing.
 *
 * WHAT WAS BROKEN to make each go red, run rather than asserted:
 *
 *  - delegation: hardcoding `category: "algorithm"` in the adapter instead of
 *    mapping the one `extractWorkLearnings` returns puts the tooling-flavoured
 *    call's artifact under `algorithm/` and the case fails on the path. The
 *    two calls differ only in the gap text, so a constant cannot satisfy both.
 *  - tier: returning a literal `Tier.Project` passes the single-project call
 *    and fails here, where the same text routed through `routeRule` by the
 *    test itself comes back Global.
 *  - shadow: appending the candidate rule to the pending-rules file — the
 *    obvious "while we're here" next step — fails the byte comparison.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { captureIterationLearning } from "../../src/capture/iteration-learning";
import { extractWorkLearnings } from "../../src/capture/corrections";
import { routeRule } from "../../src/promote/router";
import { learnedRulesFile, pendingRulesFile } from "../../src/adapters/paths";
import { Tier, type Pattern } from "../../src/adapters/types";

const TEST_DIR = join(import.meta.dir, ".tmp-iteration-learning");
const LEARNING_DIR = join(TEST_DIR, "learning");

let savedHostDir: string | undefined;

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, "signals"), { recursive: true });
  mkdirSync(join(TEST_DIR, "host"), { recursive: true });
  savedHostDir = process.env.AGENTGRIT_HOST_DIR;
  process.env.AGENTGRIT_DIR = TEST_DIR;
  process.env.AGENTGRIT_HOST_DIR = join(TEST_DIR, "host");
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = process.env.AGENTGRIT_TEST_BASE ?? "";
  if (savedHostDir === undefined) delete process.env.AGENTGRIT_HOST_DIR;
  else process.env.AGENTGRIT_HOST_DIR = savedHostDir;
});

/** The pattern `routeRule` consumes, built here so the test routes for itself. */
function patternFor(mechanicalFix: string, projects: string[]): Pattern {
  return {
    id: "p-iteration",
    type: "iteration-gap",
    frequency: 1,
    sessions: projects,
    severity: 5,
    candidateRule: mechanicalFix,
  };
}

describe("captureIterationLearning (#253)", () => {
  test("delegates to extractWorkLearnings, routeRule and writeLearnings", () => {
    const projects = ["agentgrit", "rungate"];
    const input = {
      gap: "the LEARN step produced prose that no router ever saw",
      rootCause: "two live systems were never connected to each other",
      mechanicalFix:
        "always verify the router was called before reporting a learning captured",
      artifactType: "workflow",
      sessionId: "sess-delegation",
      projects,
    };

    const result = captureIterationLearning(input);

    // ── writeLearnings did the writing: a real file, on disk, in the
    // per-category subdirectory that function owns.
    expect(result.files).toHaveLength(1);
    const artifact = result.files[0]!;
    expect(existsSync(artifact)).toBe(true);
    expect(result.learningDir).toBe(LEARNING_DIR);

    // ── extractWorkLearnings did the classifying. This gap is neither an
    // approach nor a tooling phrase, so it comes back "general" → algorithm/.
    expect(result.learning.title).toBe(input.gap);
    expect(result.learning.filesChanged).toBe(1);
    expect(result.learning.category).toBe("general");
    expect(artifact.startsWith(join(LEARNING_DIR, "algorithm"))).toBe(true);

    // ── routeRule did the routing. The test routes the same inputs itself and
    // demands the same answer, rather than accepting whatever came back.
    const direct = routeRule(patternFor(input.mechanicalFix, projects), projects);
    expect(result.route).toEqual(direct);
    expect(result.route.tier).toBe(Tier.Global);

    const body = readFileSync(artifact, "utf-8");
    for (const field of [input.gap, input.rootCause, input.mechanicalFix, input.artifactType]) {
      expect(body).toContain(field);
    }

    // ── A second call whose gap names a tooling concern must land somewhere
    // else. A hardcoded category satisfies one of these two calls, never both.
    const tooling = captureIterationLearning({
      gap: "the deploy config path was wrong in the generated hook",
      rootCause: "the generator and the template disagreed",
      mechanicalFix: "read the generated file before shipping the generator",
      artifactType: "hook",
      sessionId: "sess-tooling",
      projects,
    });
    expect(tooling.learning.category).toBe("tooling");
    expect(tooling.files[0]!.startsWith(join(LEARNING_DIR, "system"))).toBe(true);
  });

  test("shadow mode records tier and rationale but leaves the rules store untouched", () => {
    const pending = pendingRulesFile();
    const learned = learnedRulesFile();
    mkdirSync(dirname(pending), { recursive: true });
    mkdirSync(dirname(learned), { recursive: true });
    writeFileSync(pending, "# Pending\n\n- an existing candidate\n");
    writeFileSync(learned, "# Learned\n\n- an existing rule\n");

    const beforePending = readFileSync(pending, "utf-8");
    const beforeLearned = readFileSync(learned, "utf-8");

    const result = captureIterationLearning({
      gap: "the routed tier was never written down anywhere",
      rootCause: "calibration needs the decision, not just the outcome",
      mechanicalFix: "record the tier in the artifact and apply nothing",
      artifactType: "skill",
      sessionId: "sess-shadow",
      projects: ["agentgrit"],
    });

    // Vacuity guard: "nothing changed" is also true of a call that did nothing.
    expect(result.files).toHaveLength(1);
    expect(result.applied).toBe(false);

    const body = readFileSync(result.files[0]!, "utf-8");
    expect(result.route.tier).toBe(Tier.Project);
    expect(body).toContain(`**Tier:** ${Tier.Project}`);
    expect(body).toContain(result.route.rationale);

    expect(readFileSync(pending, "utf-8")).toBe(beforePending);
    expect(readFileSync(learned, "utf-8")).toBe(beforeLearned);
  });

  test("the artifact is the only thing written under the base dir", () => {
    const result = captureIterationLearning({
      gap: "a learning capture that also wrote signals would be a side effect",
      rootCause: "shadow mode must be observable and inert",
      mechanicalFix: "write one artifact and nothing else",
      artifactType: "workflow",
      sessionId: "sess-inert",
      projects: ["agentgrit"],
    });

    expect(result.files).toHaveLength(1);
    // The signals directory existed before the call and is still empty after.
    expect(readdirSync(join(TEST_DIR, "signals"))).toEqual([]);
  });

  test("the extractor still answers for a single changed file — the premise the throw rests on", () => {
    // `captureIterationLearning` throws if `extractWorkLearnings` declines,
    // and it always passes exactly one changed file (`artifactType`). Against
    // today's significance test — `filesChanged.length > 0` — that branch
    // cannot be reached, which is why no case drives it directly: a test that
    // needed the throw would have to fake the extractor, and would then be
    // asserting the fake.
    //
    // What IS assertable is the premise. If the significance test ever
    // tightens, this goes red here rather than the adapter starting to throw
    // in production, where the first reading would be a crashed LEARN step.
    // Deliberately asserts the EXTRACTOR, not the adapter: the adapter's
    // behaviour under a declining extractor is the thing that has no coverage,
    // and pretending otherwise is what this comment exists to prevent.
    const learning = extractWorkLearnings({
      title: "a single changed file is enough work to be worth recording",
      filesChanged: ["workflow"],
      toolsUsed: [],
      agentsSpawned: [],
      sessionId: "sess-premise",
    });

    expect(learning).not.toBeNull();
  });
});
