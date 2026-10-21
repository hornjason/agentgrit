/**
 * iteration-learning.ts — the LEARN step of an iteration loop, wired into the
 * learning router (#253).
 *
 * An iteration loop ends by naming three things: the GAP between what was
 * asked for and what was produced, the ROOT CAUSE underneath it, and the
 * MECHANICAL FIX that would have prevented it. Until this file existed those
 * three were prose. Meanwhile `extractWorkLearnings`, `routeRule` and
 * `writeLearnings` were live, tested and called by nothing on that path — two
 * systems that should have been connected and were not.
 *
 * This module is the join and deliberately nothing else. Every decision it
 * reports is made somewhere else:
 *
 *   gap/artifact  → extractWorkLearnings()  → category + insights
 *   mechanical fix → routeRule()            → tier + rationale
 *   the two above  → writeLearnings()       → the artifact on disk
 *
 * It re-implements none of them, because a second copy of the classifier is a
 * second answer to one question, and the day the two disagree the artifact and
 * the inbox describe different learnings.
 *
 * SHADOW MODE. The tier is recorded in the artifact and applied to nothing:
 * no pending rule, no learned rule, no signal. Routing an iteration gap
 * straight into the rules store would be a promotion nobody reviewed, and the
 * recorded decisions are what a later calibration pass needs in order to say
 * whether the routing is any good before it is allowed to act.
 */

import { basename, resolve } from "path";
import { randomUUID } from "crypto";
import { resolveSignalDir } from "../adapters/paths";
import type { Pattern } from "../adapters/types";
import { routeRule, type RouteResult } from "../promote/router";
import { extractWorkLearnings, type WorkLearning } from "./corrections";
import { writeLearnings, type HarvestedLearning } from "./harvester";

/**
 * Severity carried on the synthesised pattern. `routeRule` does not read it,
 * but `Pattern` requires it and a later consumer might, so it is a stated
 * mid-scale default rather than an implied zero.
 */
const ITERATION_SEVERITY = 5;

/** The pattern type an iteration gap is recorded under. */
const ITERATION_PATTERN_TYPE = "iteration-gap";

export interface IterationLearningInput {
  /** What was asked for versus what was produced. */
  gap: string;
  /** Why the gap happened — the cause, not the symptom. */
  rootCause: string;
  /** The change that would have prevented it. Routed as the candidate rule. */
  mechanicalFix: string;
  /** What was being produced when the gap appeared: skill, hook, workflow… */
  artifactType: string;
  /** Session this came from. A fresh id when the caller has none. */
  sessionId?: string;
  /** Projects the gap has been seen in — what `routeRule` scopes the tier by. */
  projects?: string[];
  /** Override the learning directory. Tests and callers with their own layout. */
  learningDir?: string;
}

export interface IterationLearningResult {
  /** Exactly what `extractWorkLearnings` returned. */
  learning: WorkLearning;
  /** Exactly what `routeRule` returned. */
  route: RouteResult;
  /** Artifact paths `writeLearnings` wrote. Empty if one already existed. */
  files: string[];
  /** The directory written to, resolved through the path authority. */
  learningDir: string;
  /**
   * Shadow mode: always false. Typed as the literal so a future change that
   * starts applying rules has to come through the type and be read by every
   * caller, rather than flipping a boolean nobody notices.
   */
  applied: false;
}

/**
 * Where learnings live. Same directory `agentgrit capture harvest` writes to,
 * resolved from the path authority so a caller in any working directory —
 * which is every real caller — lands in the configured install rather than in
 * whatever it happened to be `cd`'d into.
 */
function learningDirectory(): string {
  return resolve(resolveSignalDir(), "..", "learning");
}

/**
 * `WorkLearning.category` and `HarvestedLearning.category` are two different
 * vocabularies, so somebody has to map. Tooling problems are system problems;
 * approach and general problems are how the work was reasoned about.
 */
function toHarvestedCategory(
  category: WorkLearning["category"],
): HarvestedLearning["category"] {
  return category === "tooling" ? "system" : "algorithm";
}

/** The learning body: the loop's three fields plus what the extractor added. */
function formatBody(input: IterationLearningInput, learning: WorkLearning): string {
  const lines = [
    `**Gap:** ${input.gap}`,
    "",
    `**Root cause:** ${input.rootCause}`,
    "",
    `**Mechanical fix:** ${input.mechanicalFix}`,
    "",
    `**Artifact type:** ${input.artifactType}`,
    `**Work category:** ${learning.category}`,
  ];

  if (learning.insights.length > 0) {
    lines.push("", "**Insights:**", ...learning.insights.map((i) => `- ${i}`));
  }

  return lines.join("\n");
}

/**
 * Record one iteration-loop learning: classify it, route it in shadow mode,
 * and write the artifact.
 *
 * Throws rather than returning null when the extractor declines the input —
 * `artifactType` is always passed as a changed file, so a null here means the
 * extractor's contract changed underneath this adapter, and a silent empty
 * result would look exactly like a learning that was captured.
 */
export function captureIterationLearning(
  input: IterationLearningInput,
): IterationLearningResult {
  const sessionId = input.sessionId ?? randomUUID();
  const projects =
    input.projects && input.projects.length > 0
      ? input.projects
      : [basename(process.cwd())];

  const learning = extractWorkLearnings({
    title: input.gap,
    filesChanged: [input.artifactType],
    toolsUsed: [],
    agentsSpawned: [],
    sessionId,
  });

  if (!learning) {
    throw new Error(
      "extractWorkLearnings returned no learning for an iteration gap that " +
        `names an artifact (${input.artifactType}). Its significance test has ` +
        "changed; this adapter must be updated rather than writing nothing.",
    );
  }

  const pattern: Pattern = {
    id: learning.id,
    type: ITERATION_PATTERN_TYPE,
    frequency: 1,
    sessions: projects,
    severity: ITERATION_SEVERITY,
    candidateRule: input.mechanicalFix,
    firstSeen: learning.timestamp,
    lastSeen: learning.timestamp,
  };
  const route = routeRule(pattern, projects);

  const harvested: HarvestedLearning = {
    sessionId,
    timestamp: learning.timestamp,
    category: toHarvestedCategory(learning.category),
    type: "insight",
    context: input.rootCause,
    content: formatBody(input, learning),
    source: `${ITERATION_PATTERN_TYPE}:${input.artifactType}`,
    shadow: { tier: route.tier, rationale: route.rationale },
  };

  const learningDir = input.learningDir ?? learningDirectory();
  const files = writeLearnings([harvested], learningDir);

  return { learning, route, files, learningDir, applied: false };
}
