/**
 * iteration-learning.ts — the LEARN step of an iteration loop, routed (#253).
 *
 * An iteration loop ends by naming three things: the GAP it hit, the ROOT
 * CAUSE underneath it, and the MECHANICAL FIX that would stop it recurring.
 * Until this module existed that triple was prose — written down, read once,
 * and never seen by the router that decides whether a lesson belongs to one
 * project or to every project. AgentGrit already had every piece needed to
 * place it; nothing called them in sequence.
 *
 * This is that sequence, and deliberately nothing more:
 *
 *   extractWorkLearnings()  →  what kind of learning is this
 *   routeRule()             →  which tier would it belong to
 *   writeLearnings()        →  put it on disk where calibration can read it
 *
 * Each step is the existing implementation, called. Reimplementing any of the
 * three here would give the LEARN step a second opinion that drifts from the
 * one the rest of the system uses, which is the failure this issue exists to
 * remove — so `test/capture/iteration-learning.test.ts` calls `routeRule` and
 * `extractWorkLearnings` directly on the same input and compares.
 *
 * ── Shadow mode ─────────────────────────────────────────────────────────────
 * The tier is RECORDED, not APPLIED. Nothing here writes to the pending-rules
 * or learned-rules files; the only output is a learning artifact carrying the
 * tier and the router's rationale. That is on purpose and it is the whole
 * point of the first pass: a router that silently started promoting rules off
 * an uncalibrated signal would be discovered by its damage. Logged decisions
 * can be read against outcomes first, and the switch to applying them is a
 * later, separate, evidenced change.
 */

import { randomUUID } from "crypto";
import { join } from "path";
import { resolveSignalDir } from "../adapters/paths";
import type { Pattern, Tier } from "../adapters/types";
import { routeRule } from "../promote/router";
import { extractWorkLearnings, type WorkLearning } from "./corrections";
import { writeLearnings, type HarvestedLearning } from "./harvester";

/** What an iteration loop knows when its LEARN step runs. */
export interface IterationLearningInput {
  /** What was missing or went wrong. Becomes the learning's title. */
  gap: string;
  /** Why it happened — the layer beneath the symptom. */
  rootCause: string;
  /** The change that stops it recurring. This is the text the router reads. */
  mechanicalFix: string;
  /** What the loop was producing: a spec, a workflow, a review, a doc… */
  artifactType: string;
  /** Session this came from. Defaults to a fresh id so artifacts never collide. */
  sessionId?: string;
  /**
   * Projects this gap has been seen in. The router needs more than one to
   * consider anything beyond the project tier, so an empty or single-entry
   * history is a Project-tier answer by construction, not by accident.
   */
  projectHistory?: string[];
  /** Override the learning directory. Defaults alongside the signal dir. */
  learningDir?: string;
}

export interface IterationLearningResult {
  /** The tier `routeRule` returned. Recorded, not applied — see `shadow`. */
  tier: Tier;
  /** The router's own words for why. Carried into the artifact verbatim. */
  rationale: string;
  /** What `extractWorkLearnings` made of the input. */
  learning: WorkLearning;
  /** Files `writeLearnings` wrote. Empty when an identical artifact exists. */
  files: string[];
  /**
   * Always true while routing is being calibrated. It is a field rather than
   * a comment so a caller — and the test — can assert on it, and so the day
   * routing starts applying, every consumer sees the value change.
   */
  shadow: true;
}

/** Where learning artifacts go, matching `capture harvest`'s own resolution. */
function defaultLearningDir(): string {
  return join(resolveSignalDir(), "..", "learning");
}

/**
 * `WorkLearning` splits work three ways; `HarvestedLearning` splits it two.
 * Tooling gaps are system problems; approach and general gaps are reasoning
 * problems, which is what "algorithm" means in the harvester's vocabulary.
 */
function toHarvestCategory(category: WorkLearning["category"]): HarvestedLearning["category"] {
  return category === "tooling" ? "system" : "algorithm";
}

/**
 * The pattern the router is asked about.
 *
 * `candidateRule` is the mechanical fix and nothing else: the router scores
 * that text for behavioural versus procedural keywords, so folding the gap or
 * the root cause in here would score the description of the problem rather
 * than the rule being proposed.
 */
function buildPattern(input: IterationLearningInput, projects: string[]): Pattern {
  return {
    id: `iteration-${randomUUID()}`,
    type: "iteration-gap",
    frequency: Math.max(1, projects.length),
    sessions: projects,
    severity: 5,
    candidateRule: input.mechanicalFix,
    firstSeen: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };
}

/** The artifact body: the triple, the insights, and the shadow route. */
function buildContent(
  input: IterationLearningInput,
  learning: WorkLearning,
  route: { tier: Tier; rationale: string },
): string {
  const lines = [
    `**Gap:** ${input.gap}`,
    "",
    `**Root cause:** ${input.rootCause}`,
    "",
    `**Mechanical fix:** ${input.mechanicalFix}`,
    "",
    `**Artifact type:** ${input.artifactType}`,
    "",
    "### Shadow routing (recorded for calibration, NOT applied)",
    "",
    `- **Routed tier:** ${route.tier}`,
    `- **Rationale:** ${route.rationale}`,
    "- **Rules store:** untouched — no rule was promoted, pended or evicted by this capture.",
  ];

  if (learning.insights.length > 0) {
    lines.push("", "### Insights", "");
    for (const insight of learning.insights) lines.push(`- ${insight}`);
  }

  return lines.join("\n");
}

/**
 * Capture one iteration-loop learning: classify it, route it, write it down.
 *
 * Returns null when there is nothing to learn from — `extractWorkLearnings`
 * owns that judgement too, so an empty gap with no artifact is dropped by the
 * same rule that drops an empty work session, not by a second one here.
 */
export function captureIterationLearning(
  input: IterationLearningInput,
): IterationLearningResult | null {
  const sessionId = input.sessionId ?? `iteration-${randomUUID()}`;
  const projects = input.projectHistory ?? [];

  const learning = extractWorkLearnings({
    title: input.gap,
    filesChanged: input.artifactType ? [input.artifactType] : [],
    toolsUsed: [],
    agentsSpawned: [],
    sessionId,
  });
  if (!learning) return null;

  const route = routeRule(buildPattern(input, projects), projects);

  const harvested: HarvestedLearning = {
    // A fresh id per capture: `writeLearnings` keys the filename off the
    // session and the minute, so two captures sharing a session id in the
    // same minute would write one file and silently drop the second.
    sessionId: `${sessionId}-${learning.id.slice(0, 8)}`,
    timestamp: learning.timestamp,
    category: toHarvestCategory(learning.category),
    type: "insight",
    context: `Iteration LEARN step — ${input.artifactType || "unspecified artifact"}`,
    content: buildContent(input, learning, route),
    source: "iteration-learn",
  };

  const files = writeLearnings([harvested], input.learningDir ?? defaultLearningDir());

  return { tier: route.tier, rationale: route.rationale, learning, files, shadow: true };
}
