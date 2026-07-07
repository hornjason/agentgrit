/**
 * skill-forge.ts — Auto-propose skill scaffolds from recurring reflection themes
 *
 * Ported from PAI Tools/SkillForge.ts.
 * Reads algorithm-reflections.jsonl, clusters entries by LLM semantic grouping,
 * and proposes SKILL.md scaffolds for clusters with 3+ entries.
 *
 * Output: skills/_PROPOSED/<slug>/SKILL.md
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { inference } from "../adapters/inference";
import type { Benchmark, BenchmarkTask } from "./benchmark";

// ── Types ──

export interface Reflection {
  task_description: string;
  prd_id?: string;
  implied_sentiment?: number;
  effort_level?: string;
  reflection_q1?: string;
  reflection_q2?: string;
  [key: string]: unknown;
}

export interface Cluster {
  label: string;
  entries: Reflection[];
}

export interface SuppressedCluster {
  cluster: Cluster;
  matchedSkill: string;
}

export interface SuppressionResult {
  kept: Cluster[];
  suppressed: SuppressedCluster[];
}

export interface ForgeResult {
  totalClusters: number;
  suppressed: number;
  written: number;
  alreadyExisted: number;
}

// ── Slug / Title helpers ──

export function toSlug(desc: string): string {
  return desc
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
}

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function mean(nums: number[]): number {
  if (nums.length === 0) return 0;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10;
}

// ── Load reflections from JSONL ──

export function loadReflections(filePath: string, limit: number = 60): Reflection[] {
  if (!existsSync(filePath)) return [];

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const reflections: Reflection[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Reflection;
      if (typeof parsed.task_description === "string" && parsed.task_description.trim()) {
        reflections.push(parsed);
      }
    } catch {
      // skip malformed
    }
  }

  return reflections.slice(-limit);
}

// ── Semantic clustering via LLM ──

export async function semanticCluster(reflections: Reflection[]): Promise<Cluster[]> {
  const numbered = reflections
    .map((r, i) => `${i}: ${r.task_description}`)
    .join("\n");

  const systemPrompt =
    "You are a skill pattern analyst. Identify recurring work patterns in a list of task descriptions.";

  const userPrompt =
    `Below are task descriptions from an AI assistant's work log (index: description):\n\n` +
    `${numbered}\n\n` +
    `Group these task descriptions into thematic clusters representing recurring work patterns.\n` +
    `Return JSON: {"clusters": [{"label": string, "indices": number[]}]}\n` +
    `Only include clusters with 3 or more entries.\n` +
    `Labels should be 3-5 words describing the skill pattern.\n` +
    `Use 4-10 clusters total. Cover the full range of task types.\n` +
    `Return only valid JSON, no explanation.`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await inference({
      systemPrompt,
      userPrompt,
      level: "standard",
      expectJson: true,
      timeout: 180000,
    });

    if (result.success && result.parsed && typeof result.parsed === "object") {
      const parsed = result.parsed as { clusters?: Array<{ label: string; indices: number[] }> };
      const rawClusters = parsed.clusters;

      if (!Array.isArray(rawClusters)) continue;

      const clusters: Cluster[] = [];
      for (const c of rawClusters) {
        if (typeof c.label !== "string" || !Array.isArray(c.indices)) continue;
        const entries = c.indices
          .filter((idx): idx is number => typeof idx === "number" && idx >= 0 && idx < reflections.length)
          .map((idx) => reflections[idx]);
        if (entries.length < 3) continue;
        clusters.push({ label: c.label, entries });
      }

      return clusters;
    }
  }

  return [];
}

// ── Live skill detection ──

export function getLiveSkillSlugs(skillsDir: string): string[] {
  try {
    return readdirSync(skillsDir).filter((e) => {
      if (e.startsWith("_") || e.startsWith(".")) return false;
      try {
        return statSync(join(skillsDir, e)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

// ── Router usage counts ──

export function getRouterUsageCounts(suggestionsFile: string): Map<string, number> {
  const counts = new Map<string, number>();
  if (!existsSync(suggestionsFile)) return counts;

  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  try {
    const lines = readFileSync(suggestionsFile, "utf-8").split("\n").filter((l) => l.trim());
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as {
          timestamp?: string;
          ts?: string;
          suggested_skills?: string[];
          suggestions?: string[];
        };
        const ts = entry.timestamp ?? entry.ts;
        if (!ts || new Date(ts).getTime() < cutoff) continue;
        const skills = entry.suggested_skills ?? entry.suggestions ?? [];
        for (const s of skills) counts.set(s, (counts.get(s) ?? 0) + 1);
      } catch {
        // skip malformed
      }
    }
  } catch {
    // fail-open
  }
  return counts;
}

// ── Suppression filtering ──

export async function filterSuppressedClusters(
  clusters: Cluster[],
  skillsDir: string,
  suggestionsFile: string,
): Promise<SuppressionResult> {
  const failOpen: SuppressionResult = { kept: clusters, suppressed: [] };
  if (clusters.length === 0) return failOpen;

  const liveSkills = getLiveSkillSlugs(skillsDir);
  const usageCounts = getRouterUsageCounts(suggestionsFile);

  if (liveSkills.length === 0) return failOpen;

  const liveSkillLines = liveSkills
    .map((s) => `  ${s}: ${usageCounts.get(s) ?? 0} suggestions`)
    .join("\n");

  const clusterLines = clusters
    .map((c, i) => {
      const samples = c.entries
        .slice(0, 3)
        .map((e) => `      - ${e.task_description}`)
        .join("\n");
      return `  ${i}. "${c.label}"\n${samples}`;
    })
    .join("\n");

  const systemPrompt =
    "You are a skill portfolio analyst. Prevent redundant proposed skills when live skills already cover the same work.";

  const userPrompt =
    `Live skills and their recent routing frequency (last 30 days):\n${liveSkillLines}\n\n` +
    `Proposed clusters to evaluate:\n${clusterLines}\n\n` +
    `Rules:\n` +
    `- Suppress a cluster if its work is semantically covered by a live skill.\n` +
    `- Also suppress if the matching live skill has 5+ recent suggestions.\n` +
    `- Do NOT suppress if the cluster represents genuinely new work.\n` +
    `- When in doubt, do NOT suppress (fail-open).\n` +
    `- matched_skill must be an exact slug from the live skills list, or null.\n\n` +
    `Return JSON only:\n` +
    `{"results": [{"label": string, "suppress": boolean, "matched_skill": string | null, "reason": string}]}`;

  try {
    const result = await inference({
      systemPrompt,
      userPrompt,
      level: "fast",
      expectJson: true,
      timeout: 90000,
    });

    if (!result.success || !result.parsed) return failOpen;

    const parsed = result.parsed as {
      results?: Array<{
        label: string;
        suppress: boolean;
        matched_skill?: string | null;
        reason: string;
      }>;
    };
    if (!Array.isArray(parsed.results) || parsed.results.length !== clusters.length) {
      return failOpen;
    }

    const kept: Cluster[] = [];
    const suppressed: SuppressedCluster[] = [];
    for (let i = 0; i < clusters.length; i++) {
      const decision = parsed.results[i];
      if (decision?.suppress && decision.matched_skill) {
        suppressed.push({ cluster: clusters[i], matchedSkill: decision.matched_skill });
      } else {
        kept.push(clusters[i]);
      }
    }
    return { kept, suppressed };
  } catch {
    return failOpen;
  }
}

// ── Benchmark feeding ──

function taskId(task: string): string {
  return createHash("sha256").update(task).digest("hex").slice(0, 16);
}

function computeContentHash(tasks: BenchmarkTask[]): string {
  const combined = tasks.map((t) => t.task).join("|");
  return createHash("sha256").update(combined).digest("hex");
}

function benchmarkFileFor(slug: string): string {
  const overrides: Record<string, string> = {
    "debugging-and-bug-fixes": "skill-benchmark.json",
    "dev-loop": "skill-benchmark-devloop.json",
    "testing-and-qa-validation": "skill-benchmark-qa.json",
    Developer: "skill-benchmark-developer.json",
  };
  return overrides[slug] ?? `skill-benchmark-${slug}.json`;
}

export function feedSuppressedToBenchmarks(
  suppressed: SuppressedCluster[],
  stateDir: string,
): { skill: string; added: number }[] {
  if (suppressed.length === 0) return [];

  const results: { skill: string; added: number }[] = [];
  const bySkill = new Map<string, SuppressedCluster[]>();
  for (const s of suppressed) {
    const list = bySkill.get(s.matchedSkill) ?? [];
    list.push(s);
    bySkill.set(s.matchedSkill, list);
  }

  for (const [skill, items] of bySkill) {
    const benchFile = join(stateDir, benchmarkFileFor(skill));

    let benchmark: Benchmark;
    if (existsSync(benchFile)) {
      try {
        benchmark = JSON.parse(readFileSync(benchFile, "utf-8")) as Benchmark;
      } catch {
        continue;
      }
    } else {
      benchmark = { generated: new Date().toISOString(), content_hash: "", tasks: [] };
    }

    const existingIds = new Set(benchmark.tasks.map((t) => t.id));
    let added = 0;

    for (const { cluster } of items) {
      for (const entry of cluster.entries) {
        const id = taskId(entry.task_description);
        if (existingIds.has(id)) continue;

        benchmark.tasks.push({
          id,
          task: entry.task_description,
          rating: typeof entry.implied_sentiment === "number" ? entry.implied_sentiment : 5,
          gold_q1: typeof entry.reflection_q1 === "string" ? entry.reflection_q1 : "",
          gold_q2: typeof entry.reflection_q2 === "string" ? entry.reflection_q2 : "",
          domain: typeof entry.effort_level === "string" ? entry.effort_level : "standard",
        });
        existingIds.add(id);
        added++;
      }
    }

    if (added > 0) {
      benchmark.generated = new Date().toISOString();
      benchmark.content_hash = computeContentHash(benchmark.tasks);
      const dir = join(stateDir);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(benchFile, JSON.stringify(benchmark, null, 2), "utf-8");
    }

    results.push({ skill, added });
  }

  return results;
}

// ── Slug existence check ──

export function slugExists(slug: string, skillsDir: string, proposedDir: string): boolean {
  if (existsSync(join(proposedDir, slug))) return true;
  if (existsSync(join(skillsDir, slug))) return true;

  try {
    const entries = readdirSync(skillsDir);
    for (const e of entries) {
      if (e.toLowerCase() === slug.toLowerCase()) return true;
    }
  } catch {
    // ignore
  }

  return false;
}

// ── Build SKILL.md scaffold ──

export function buildSkillMd(
  cluster: Cluster,
  slug: string,
  today: string,
): string {
  const sentiments = cluster.entries
    .map((e) => e.implied_sentiment)
    .filter((s): s is number => typeof s === "number");
  const avgSentiment = mean(sentiments);
  const title = titleCase(cluster.label);
  const n = cluster.entries.length;

  const candidateLines = cluster.entries
    .slice(0, 3)
    .map((e) => `- ${e.task_description}${e.prd_id ? ` (${e.prd_id})` : ""}`)
    .join("\n");

  return `---
name: ${title}
description: >
  Auto-proposed skill for recurring task pattern: "${cluster.label}".
  Handles the repeated work identified across ${n} algorithm reflections.
source: SkillForge auto-proposed from ${n} reflections
proposed: ${today}
cluster_entries: ${n}
avg_implied_sentiment: ${avgSentiment}
---

## What it does
Handles recurring work in the domain of: ${cluster.label}.

## Trigger conditions
- [placeholder -- review candidate reflections below]

## Anti-patterns (do NOT do these)
- [placeholder]

## Success patterns
- [placeholder]

## Candidate reflections
${candidateLines}
`;
}

// ── Main forge function ──

export async function forge(config: {
  reflectionsFile: string;
  skillsDir: string;
  proposedDir: string;
  stateDir: string;
  suggestionsFile: string;
  limit?: number;
}): Promise<ForgeResult> {
  const reflections = loadReflections(config.reflectionsFile, config.limit ?? 60);
  if (reflections.length === 0) {
    return { totalClusters: 0, suppressed: 0, written: 0, alreadyExisted: 0 };
  }

  const rawClusters = await semanticCluster(reflections);

  const { kept: candidates, suppressed } = await filterSuppressedClusters(
    rawClusters,
    config.skillsDir,
    config.suggestionsFile,
  );

  feedSuppressedToBenchmarks(suppressed, config.stateDir);

  const today = new Date().toISOString().slice(0, 10);

  if (!existsSync(config.proposedDir)) {
    mkdirSync(config.proposedDir, { recursive: true });
  }

  let written = 0;
  let alreadyExisted = 0;

  for (const c of candidates) {
    const slug = toSlug(c.label);
    if (!slug) continue;
    if (slugExists(slug, config.skillsDir, config.proposedDir)) {
      alreadyExisted++;
      continue;
    }

    const skillDir = join(config.proposedDir, slug);
    mkdirSync(skillDir, { recursive: true });

    const content = buildSkillMd(c, slug, today);
    writeFileSync(join(skillDir, "SKILL.md"), content, "utf8");
    written++;
  }

  return {
    totalClusters: rawClusters.length,
    suppressed: suppressed.length,
    written,
    alreadyExisted,
  };
}
