/**
 * skill-synthesizer.ts — Synthesize SKILL.md content from algorithm reflections
 *
 * Ported from PAI Tools/SkillSynthesizer.ts.
 * For each target skill, identifies matching reflections using LLM,
 * drafts SKILL.md using a format reference, refines with a second LLM call,
 * preserves existing frontmatter, and auto-promotes to skills/<slug>/SKILL.md.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { inference } from "../adapters/inference";

// ── Types ──

export interface Reflection {
  timestamp: string;
  effort_level: string;
  task_description: string;
  prd_id?: string;
  implied_sentiment?: number;
  reflection_q1?: string;
  reflection_q2?: string;
  reflection_q3?: string;
  [key: string]: unknown;
}

/**
 * One cluster of reflections that looks like a skill worth writing.
 *
 * `meanSentiment` is `null`, never a substituted default, when no backing
 * reflection carries an `implied_sentiment`: a cluster nobody rated and a
 * cluster rated badly are different facts, and `0` or `5` would merge them.
 */
export interface SkillRecommendation {
  /** Kebab-case slug built from the terms the cluster shares. */
  slug: string;
  /** How many reflections back this recommendation. */
  reflectionCount: number;
  /** Mean `implied_sentiment` of the backing entries that carry one. */
  meanSentiment: number | null;
  /** How many of the backing entries carried a sentiment at all. */
  sentimentCount: number;
  /** The terms the cluster was formed on, strongest first. */
  terms: string[];
  /** Every backing reflection's `task_description`, in input order. */
  taskDescriptions: string[];
}

export interface SynthesisResult {
  skill: string;
  status: "promoted" | "error" | "skipped";
  trigger_count: number;
  workflow_steps: number;
  antipatterns: number;
  error?: string;
}

// ── Frontmatter parsing ──

export function parseFrontmatter(content: string): { frontmatterLines: string[]; body: string } {
  const lines = content.split("\n");
  if (lines[0] !== "---") {
    return { frontmatterLines: [], body: content };
  }
  const closeIdx = lines.indexOf("---", 1);
  if (closeIdx === -1) {
    return { frontmatterLines: [], body: content };
  }
  return {
    frontmatterLines: lines.slice(1, closeIdx),
    body: lines.slice(closeIdx + 1).join("\n").trimStart(),
  };
}

export function rebuildSkillMd(
  originalFrontmatterLines: string[],
  newBody: string,
  promotedDate: string,
  description?: string,
): string {
  const hasPromoted = originalFrontmatterLines.some((l) => l.startsWith("promoted:"));
  let lines = [...originalFrontmatterLines];
  if (!hasPromoted) {
    lines.push(`promoted: ${promotedDate}`);
  }

  if (description) {
    const descIdx = lines.findIndex((l) => l.startsWith("description:"));
    if (descIdx !== -1) {
      let endIdx = descIdx + 1;
      while (endIdx < lines.length && /^\s+/.test(lines[endIdx])) {
        endIdx++;
      }
      lines = [
        ...lines.slice(0, descIdx),
        `description: ${description}`,
        ...lines.slice(endIdx),
      ];
    } else {
      const nameIdx = lines.findIndex((l) => l.startsWith("name:"));
      const insertAt = nameIdx !== -1 ? nameIdx + 1 : 0;
      lines = [
        ...lines.slice(0, insertAt),
        `description: ${description}`,
        ...lines.slice(insertAt),
      ];
    }
  }

  return `---\n${lines.join("\n")}\n---\n\n${newBody.trim()}\n`;
}

// ── Section counting ──

export function countWorkflowSteps(body: string): number {
  const matches = body.match(/^### Step \d+/gm);
  return matches ? matches.length : 0;
}

export function countAntipatterns(body: string): number {
  const apSection = body.match(/## Anti-patterns[\s\S]*?(?=\n## |\n---|\s*$)/);
  if (!apSection) return 0;
  const bullets = apSection[0].match(/^- /gm);
  return bullets ? bullets.length : 0;
}

// ── Step 1: Identify matching reflections ──

export async function identifyMatchingReflections(
  slug: string,
  reflections: Reflection[],
): Promise<number[]> {
  const numbered = reflections
    .map((r, i) => `${i}: ${r.task_description.slice(0, 80)}`)
    .join("\n");

  const systemPrompt =
    "You are a skill cluster analyst. Given a skill category slug and a list of task descriptions, " +
    "identify which tasks belong to that skill cluster. Be inclusive. " +
    'Return JSON only: {"indices": [array of integer indices]}';

  const userPrompt =
    `Skill cluster: "${slug}"\n\n` +
    `Task descriptions (index: description):\n${numbered}\n\n` +
    `Which of these task descriptions belong to the "${slug}" skill cluster?\n` +
    `Return ONLY valid JSON: {"indices": [0, 3, 7, ...]}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await inference({
      systemPrompt,
      userPrompt,
      level: "fast",
      expectJson: true,
      timeout: 90000,
    });

    if (result.success && result.parsed) {
      const parsed = result.parsed as { indices?: unknown[] };
      if (Array.isArray(parsed.indices)) {
        return parsed.indices.filter(
          (x): x is number => typeof x === "number" && x >= 0 && x < reflections.length,
        );
      }
    }
  }

  return [];
}

// ── Step 2: Draft SKILL.md ──

export async function draftSkillMd(
  slug: string,
  matchingReflections: Reflection[],
  formatReference: string,
): Promise<string | null> {
  const topReflections = [...matchingReflections]
    .sort((a, b) => (b.implied_sentiment ?? 5) - (a.implied_sentiment ?? 5))
    .slice(0, 20);

  const reflectionSummaries = topReflections
    .map(
      (r, i) =>
        `--- Reflection ${i + 1} ---\n` +
        `Task: ${r.task_description}\n` +
        (r.reflection_q1 ? `What worked: ${r.reflection_q1}\n` : "") +
        (r.reflection_q2 ? `What would have been smarter: ${r.reflection_q2}\n` : "") +
        (r.reflection_q3 ? `Under-used capabilities: ${r.reflection_q3}\n` : ""),
    )
    .join("\n");

  const systemPrompt =
    "You are a senior engineer writing a skill workflow file for an AI assistant. " +
    "Synthesize real patterns from engineering reflections into a precise, " +
    "actionable SKILL.md. Follow the format reference EXACTLY.";

  const userPrompt =
    `Skill slug: ${slug}\n\n` +
    `FORMAT REFERENCE:\n${formatReference}\n\n` +
    `REFLECTIONS TO SYNTHESIZE:\n${reflectionSummaries}\n\n` +
    `Write a SKILL.md for the "${slug}" skill.\n` +
    `Rules:\n` +
    `- Use the exact same section structure as the format reference\n` +
    `- Do NOT include frontmatter (--- block)\n` +
    `- Be specific and concrete\n` +
    `- Keep step descriptions tight: 1-2 sentences each`;

  const result = await inference({
    systemPrompt,
    userPrompt,
    level: "fast",
    timeout: 60000,
  });

  return result.success ? result.output.trim() : null;
}

// ── Step 3: Refine ──

export async function refineSkillMd(
  slug: string,
  draft: string,
  reflections: Reflection[],
): Promise<string> {
  const systemPrompt =
    "You are a principal engineer reviewing a skill workflow file draft. " +
    "Sharpen the draft: add missing concrete details, remove vague filler. " +
    "Do not restructure -- only improve clarity and precision.";

  const reflectionContext = reflections
    .slice(0, 10)
    .map((r) => `- ${r.task_description}: ${r.reflection_q1 ?? ""}`)
    .join("\n");

  const userPrompt =
    `Skill: ${slug}\n\n` +
    `DRAFT:\n${draft}\n\n` +
    `REFLECTION CONTEXT:\n${reflectionContext}\n\n` +
    `Return the complete refined SKILL.md body (no frontmatter, no explanation).`;

  const result = await inference({
    systemPrompt,
    userPrompt,
    level: "standard",
    timeout: 60000,
  });

  return result.success ? result.output.trim() : draft;
}

// ── Step 4: Generate description ──

export async function generateDescription(
  slug: string,
  matchingReflections: Reflection[],
): Promise<string> {
  const topTasks = matchingReflections
    .slice(0, 5)
    .map((r) => `- ${r.task_description.slice(0, 100)}`)
    .join("\n");

  const result = await inference({
    systemPrompt:
      "You write skill trigger descriptions for an AI assistant. Output one sentence only. 15-25 words.",
    userPrompt:
      `Skill slug: ${slug}\n\n` +
      `Top task examples:\n${topTasks}\n\n` +
      `Write a description. Format: '[what it does]. USE WHEN [triggers].'\n` +
      `Return the sentence only.`,
    level: "fast",
    timeout: 30000,
  });

  if (!result.success || !result.output.trim()) {
    return `${slug} skill. USE WHEN ${slug.replace(/-/g, ", ")}.`;
  }

  return result.output.trim();
}

// ── Load reflections ──

export function loadReflections(filePath: string): Reflection[] {
  if (!existsSync(filePath)) return [];

  let rawLines: string[];
  try {
    rawLines = readFileSync(filePath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }

  const reflections: Reflection[] = [];
  for (const line of rawLines) {
    try {
      const parsed = JSON.parse(line) as Reflection;
      if (typeof parsed.task_description === "string" && parsed.task_description.trim()) {
        reflections.push(parsed);
      }
    } catch {
      // skip malformed
    }
  }

  return reflections;
}

// ── Inference-free recommendations ──

/**
 * Terms that carry no cluster signal.
 *
 * Ordinary English function words, plus the three words the daemon's fallback
 * description is built from (`Autonomous session <id>`): a corpus of fallback
 * descriptions genuinely has nothing to cluster on, and letting those words
 * through would produce one confident recommendation covering every session.
 */
const RECOMMENDATION_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "when", "then",
  "have", "has", "had", "was", "were", "are", "its", "but", "not", "all",
  "any", "out", "our", "you", "your", "they", "them", "their", "there",
  "here", "what", "which", "who", "why", "how", "can", "will", "would",
  "should", "could", "did", "does", "done", "get", "got", "let", "via",
  "per", "off", "than", "too", "very", "just", "now", "new", "old", "one",
  "two", "about", "after", "before", "again", "also", "because", "been",
  "being", "between", "both", "each", "more", "most", "other", "over",
  "same", "some", "such", "only", "own", "under", "while", "autonomous",
  "session", "task",
]);

/** Distinct, lower-cased, meaningful terms in one description. */
function recommendationTerms(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9+#]+/)) {
    if (raw.length < 3) continue;
    if (/^[0-9]+$/.test(raw)) continue;
    if (RECOMMENDATION_STOPWORDS.has(raw)) continue;
    seen.add(raw);
  }
  return [...seen];
}

/**
 * Cluster reflections into skill recommendations without calling an LLM.
 *
 * This is the path a standalone install has: `identifyMatchingReflections`
 * and everything downstream of it need an API key, so without one the whole
 * reflection-driven half of the optimizer is dead. Here the clustering is
 * term overlap over `task_description` — a greedy cover that repeatedly takes
 * the term shared by the most still-uncovered reflections, so every
 * reflection backs at most one recommendation and the output is deterministic
 * for a given input order.
 *
 * A term carried by fewer than `minSupport` reflections is not a cluster; it
 * is one task described once, and recommending a skill for it is noise.
 */
export function recommendSkills(
  reflections: Reflection[],
  options: { minSupport?: number; maxRecommendations?: number } = {},
): SkillRecommendation[] {
  const minSupport = Math.max(2, options.minSupport ?? 2);
  const maxRecommendations = Math.max(0, options.maxRecommendations ?? 10);

  const docs = reflections
    .filter(
      (r): r is Reflection =>
        !!r && typeof r.task_description === "string" && r.task_description.trim().length > 0,
    )
    .map((reflection) => ({
      reflection,
      terms: new Set(recommendationTerms(reflection.task_description)),
    }));

  let remaining = docs.map((_, i) => i);
  const recommendations: SkillRecommendation[] = [];

  while (recommendations.length < maxRecommendations) {
    const postings = new Map<string, number[]>();
    for (const i of remaining) {
      for (const term of docs[i].terms) {
        const members = postings.get(term);
        if (members) members.push(i);
        else postings.set(term, [i]);
      }
    }

    // Highest support wins; ties go to the alphabetically first term, so the
    // same corpus always produces the same slugs.
    let bestTerm = "";
    let bestMembers: number[] = [];
    for (const term of [...postings.keys()].sort()) {
      const members = postings.get(term) as number[];
      if (members.length > bestMembers.length) {
        bestTerm = term;
        bestMembers = members;
      }
    }
    if (bestMembers.length < minSupport) break;

    // Terms every member shares describe the cluster better than one word.
    const shared = [...docs[bestMembers[0]].terms]
      .filter((t) => t !== bestTerm && bestMembers.every((i) => docs[i].terms.has(t)))
      .sort();
    const terms = [bestTerm, ...shared];

    const backing = bestMembers.map((i) => docs[i].reflection);
    const sentiments = backing
      .map((r) => r.implied_sentiment)
      .filter((s): s is number => typeof s === "number" && Number.isFinite(s));

    recommendations.push({
      slug: terms.slice(0, 2).join("-"),
      reflectionCount: backing.length,
      meanSentiment:
        sentiments.length > 0
          ? sentiments.reduce((sum, s) => sum + s, 0) / sentiments.length
          : null,
      sentimentCount: sentiments.length,
      terms,
      taskDescriptions: backing.map((r) => r.task_description),
    });

    const covered = new Set(bestMembers);
    remaining = remaining.filter((i) => !covered.has(i));
  }

  return recommendations;
}

// ── Synthesize one skill ──

export async function synthesizeSkill(config: {
  slug: string;
  reflections: Reflection[];
  formatReference: string;
  proposedDir: string;
  skillsDir: string;
  today: string;
}): Promise<SynthesisResult> {
  const { slug, reflections, formatReference, proposedDir, skillsDir, today } = config;
  const proposedSkillPath = join(proposedDir, slug, "SKILL.md");
  const promotedSkillPath = join(skillsDir, slug, "SKILL.md");

  if (!existsSync(proposedSkillPath)) {
    return { skill: slug, status: "skipped", trigger_count: 0, workflow_steps: 0, antipatterns: 0 };
  }

  const existingContent = readFileSync(proposedSkillPath, "utf8");
  const { frontmatterLines } = parseFrontmatter(existingContent);

  const indices = await identifyMatchingReflections(slug, reflections);
  if (indices.length === 0) {
    return {
      skill: slug,
      status: "skipped",
      trigger_count: 0,
      workflow_steps: 0,
      antipatterns: 0,
      error: "No matching reflections",
    };
  }

  const matchingReflections = indices.map((i) => reflections[i]);

  const draft = await draftSkillMd(slug, matchingReflections, formatReference);
  if (!draft) {
    return {
      skill: slug,
      status: "error",
      trigger_count: indices.length,
      workflow_steps: 0,
      antipatterns: 0,
      error: "Draft generation failed",
    };
  }

  const refined = await refineSkillMd(slug, draft, matchingReflections);
  const description = await generateDescription(slug, matchingReflections);

  const finalContent = rebuildSkillMd(frontmatterLines, refined, today, description);

  writeFileSync(proposedSkillPath, finalContent, "utf8");

  const promotedDir = join(skillsDir, slug);
  if (!existsSync(promotedDir)) {
    mkdirSync(promotedDir, { recursive: true });
  }
  writeFileSync(promotedSkillPath, finalContent, "utf8");

  return {
    skill: slug,
    status: "promoted",
    trigger_count: indices.length,
    workflow_steps: countWorkflowSteps(refined),
    antipatterns: countAntipatterns(refined),
  };
}
