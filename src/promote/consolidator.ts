import { existsSync, readFileSync, writeFileSync } from "fs";
import { inference, type InferenceResult } from "../adapters/inference";
import { readGraph } from "../graph/builder";
import type { GraphNode } from "../adapters/types";
import type { Graph } from "../graph/types";

const MAX_EPISODES = 60;
const MAX_RATING_FOR_EPISODIC = 4;
const MIN_PATTERN_SIZE = 3;
const DETAIL_SLICE_CHARS = 300;
const PREVIEW_SLICE_CHARS = 200;
const TOP_SIMILAR_NODES = 5;
const CRITIQUE_TIMEOUT_MS = 120_000;
const PROPOSE_TIMEOUT_MS = 45_000;

export interface RatingEntry {
  timestamp: string;
  rating: number;
  session_id?: string;
  source: string;
  sentiment_summary?: string;
  sentiment_detail?: string;
  response_preview?: string;
  comment?: string;
}

export interface PatternDescriptor {
  name: string;
  episodes: number[];
  failure: string;
}

export interface ConsolidationResult {
  patternsFound: number;
  rulesProposed: number;
  duplicateNames: number;
  noneCount: number;
  errors: string[];
}

export type InferenceFn = (opts: {
  systemPrompt: string;
  userPrompt: string;
  level: "fast" | "standard" | "smart";
  expectJson?: boolean;
  timeout?: number;
}) => Promise<InferenceResult>;

// ── Helpers ──

function similarityScore(pattern: string, node: GraphNode): number {
  const patternTokens = pattern
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
  if (patternTokens.length === 0) return 0;

  const haystack = `${node.name} ${node.description}`.toLowerCase();
  let hits = 0;
  for (const tok of patternTokens) {
    if (haystack.includes(tok)) hits++;
  }
  return hits / patternTokens.length;
}

export function loadEpisodes(ratingsPath: string): RatingEntry[] {
  if (!existsSync(ratingsPath)) return [];

  const text = readFileSync(ratingsPath, "utf-8");
  const episodes: RatingEntry[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as RatingEntry;
      if (typeof obj.rating !== "number") continue;
      if (obj.rating > MAX_RATING_FOR_EPISODIC) continue;
      if (!obj.sentiment_summary && !obj.sentiment_detail) continue;
      episodes.push(obj);
    } catch { /* skip malformed */ }
  }

  episodes.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
  return episodes.slice(0, MAX_EPISODES);
}

function formatEpisodeBundle(episodes: RatingEntry[]): string {
  return episodes
    .map((e, i) => {
      const idx = i + 1;
      const summary = e.sentiment_summary ?? "no summary";
      const detail =
        e.sentiment_detail?.slice(0, DETAIL_SLICE_CHARS) ??
        e.response_preview?.slice(0, PREVIEW_SLICE_CHARS) ??
        "no detail";
      return `[${idx}] Rating: ${e.rating}/10\nSummary: ${summary}\nDetail: ${detail}`;
    })
    .join("\n\n");
}

// ── Critique step ──

export async function runCritiqueStep(
  episodes: RatingEntry[],
  infer: InferenceFn = inference,
): Promise<PatternDescriptor[]> {
  const systemPrompt = "You are analyzing failure patterns in an AI assistant's sessions. Find recurring failure themes.";

  const userPrompt =
    `Below are ${episodes.length} low-rated sessions (rating <= 4/10). Each represents a failure or correction.\n\n` +
    `${formatEpisodeBundle(episodes)}\n\n` +
    `Identify 3-6 meta-patterns where similar failures appear across multiple episodes.\n` +
    `For each pattern:\n` +
    `- Give it a short name (snake_case, under 5 words)\n` +
    `- List the episode indices that belong to it\n` +
    `- Write 1 sentence: what behavior consistently failed\n\n` +
    `Only include patterns with 3+ episodes. Return JSON:\n` +
    `[{"name":"pattern_name","episodes":[1,4,7],"failure":"The assistant did X when Y"}]`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await infer({
      systemPrompt,
      userPrompt,
      level: "standard",
      expectJson: true,
      timeout: CRITIQUE_TIMEOUT_MS,
    });

    if (result.success && Array.isArray(result.parsed)) {
      const raw = result.parsed as Array<Record<string, unknown>>;
      const patterns: PatternDescriptor[] = [];
      for (const item of raw) {
        const name = typeof item.name === "string" ? item.name : null;
        const episodesArr = Array.isArray(item.episodes)
          ? (item.episodes as unknown[]).filter((x): x is number => typeof x === "number")
          : null;
        const failure = typeof item.failure === "string" ? item.failure : null;
        if (!name || !episodesArr || !failure) continue;
        if (episodesArr.length < MIN_PATTERN_SIZE) continue;
        patterns.push({ name, episodes: episodesArr, failure });
      }
      return patterns;
    }
  }

  return [];
}

// ── Propose step ──

export async function runProposeStep(
  pattern: PatternDescriptor,
  similarNodes: GraphNode[],
  infer: InferenceFn = inference,
): Promise<string | null> {
  const systemPrompt = "You are drafting behavioral rules to prevent recurring AI assistant failures.";

  const existingList =
    similarNodes.length > 0
      ? similarNodes.map((n) => `- ${n.name}: ${n.description}`).join("\n")
      : "- (none similar found)";

  const userPrompt =
    `Failure pattern: "${pattern.failure}"\n` +
    `Supporting episodes (${pattern.episodes.length}): episodes ${pattern.episodes.join(", ")} from the analysis\n\n` +
    `Existing similar rules (do NOT duplicate these):\n` +
    `${existingList}\n\n` +
    `Write ONE behavioral rule to prevent this failure. Requirements:\n` +
    `- Imperative voice, starts with a verb\n` +
    `- Under 30 words\n` +
    `- Testable (would a reviewer agree this was violated in the episodes?)\n` +
    `- If the failure is already covered by an existing rule, output NONE\n\n` +
    `Output ONLY the rule text or NONE.`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await infer({
      systemPrompt,
      userPrompt,
      level: "standard",
      expectJson: false,
      timeout: PROPOSE_TIMEOUT_MS,
    });

    if (result.success) {
      const text = result.output.trim();
      if (!text) return null;
      const cleaned = text
        .replace(/^```[a-z]*\n?/i, "")
        .replace(/```$/, "")
        .trim();
      if (!cleaned) return null;
      if (/^none\b/i.test(cleaned)) return null;
      const firstLine = cleaned
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      return firstLine ?? null;
    }
  }

  return null;
}

// ── Format pending block ──

export function formatPendingBlock(
  pattern: PatternDescriptor,
  proposedRule: string,
  date: string,
): string {
  return [
    `## ${pattern.name} [PROPOSED - needs review]`,
    "",
    `**Date:** ${date}`,
    `**Episodes:** ${pattern.episodes.length} low-rated sessions`,
    `**Pattern:** ${pattern.failure}`,
    `**Supporting episodes:** indices ${pattern.episodes.join(", ")}`,
    "",
    `**Proposed rule:** ${proposedRule}`,
    "",
    `**Review required:** Does this duplicate existing rules? Is it specific enough?`,
    "",
    "---",
    "",
  ].join("\n");
}

// ── Main consolidation ──

export async function consolidateEpisodes(
  ratingsPath: string,
  pendingRulesPath: string,
  opts?: {
    dryRun?: boolean;
    infer?: InferenceFn;
    graph?: Graph;
  },
): Promise<ConsolidationResult> {
  const result: ConsolidationResult = {
    patternsFound: 0,
    rulesProposed: 0,
    duplicateNames: 0,
    noneCount: 0,
    errors: [],
  };

  const infer = opts?.infer ?? inference;

  const episodes = loadEpisodes(ratingsPath);
  if (episodes.length === 0) return result;

  const patterns = await runCritiqueStep(episodes, infer);
  result.patternsFound = patterns.length;
  if (patterns.length === 0) return result;

  const existingPending = existsSync(pendingRulesPath)
    ? readFileSync(pendingRulesPath, "utf-8")
    : "";

  const graph = opts?.graph ?? readGraph();
  const allNodes = Object.values(graph.nodes);
  const dateStr = new Date().toISOString().slice(0, 10);
  const toAppend: string[] = [];

  for (const pattern of patterns) {
    if (existingPending.includes(pattern.name)) {
      result.duplicateNames++;
      continue;
    }

    const similar = allNodes
      .map((n) => ({ node: n, score: similarityScore(pattern.failure, n) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_SIMILAR_NODES)
      .map((x) => x.node);

    const proposedRule = await runProposeStep(pattern, similar, infer);
    if (!proposedRule) {
      result.noneCount++;
      continue;
    }

    toAppend.push(formatPendingBlock(pattern, proposedRule, dateStr));
    result.rulesProposed++;
  }

  if (toAppend.length === 0 || opts?.dryRun) return result;

  const header = existingPending
    ? ""
    : "# Pending Learning Rules\n\nAuto-generated. Rules here are proposals for human review.\n\n---\n\n";
  const newContent =
    existingPending +
    (existingPending.endsWith("\n") ? "" : "\n") +
    header +
    toAppend.join("\n");
  writeFileSync(pendingRulesPath, newContent, "utf-8");

  return result;
}
