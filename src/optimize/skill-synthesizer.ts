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
