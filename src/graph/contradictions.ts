import { tokenize } from "./bm25";
import { existsSync, appendFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

export interface ContradictionResult {
  ruleA: string;
  ruleB: string;
  similarity: number;
  type: "direct" | "soft";
  resolution: "keep-a" | "keep-b";
}

interface RuleInput {
  id: string;
  text: string;
  correlationScore?: number;
  created?: string;
}

const NEGATION_PAIRS: Array<[RegExp, RegExp]> = [
  [/\balways\b/i, /\bnever\b/i],
  [/\bdo\b/i, /\bdon'?t\b/i],
  [/\bprefer\b/i, /\bavoid\b/i],
  [/\bstart\b/i, /\bstop\b/i],
];

const NEGATION_MARKERS = /\b(?:don'?t|never|avoid|stop|not)\b/i;
const POSITIVE_MARKERS = /\b(?:always|do|prefer|start|use|must|should)\b/i;

function computeTokenOverlap(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const smaller = Math.min(setA.size, setB.size);
  return smaller === 0 ? 0 : intersection / smaller;
}

function hasOpposingDirectives(textA: string, textB: string): boolean {
  for (const [patternPos, patternNeg] of NEGATION_PAIRS) {
    if (
      (patternPos.test(textA) && patternNeg.test(textB)) ||
      (patternNeg.test(textA) && patternPos.test(textB))
    ) {
      return true;
    }
  }

  const aNeg = NEGATION_MARKERS.test(textA);
  const bNeg = NEGATION_MARKERS.test(textB);
  if (aNeg !== bNeg) {
    const aPos = POSITIVE_MARKERS.test(textA);
    const bPos = POSITIVE_MARKERS.test(textB);
    if ((aNeg && bPos) || (bNeg && aPos)) return true;
  }

  return false;
}

function resolveWinner(a: RuleInput, b: RuleInput): "keep-a" | "keep-b" {
  const scoreA = a.correlationScore ?? 0;
  const scoreB = b.correlationScore ?? 0;
  if (scoreA !== scoreB) return scoreA > scoreB ? "keep-a" : "keep-b";

  const timeA = a.created ? new Date(a.created).getTime() : 0;
  const timeB = b.created ? new Date(b.created).getTime() : 0;
  return timeB >= timeA ? "keep-b" : "keep-a";
}

const OVERLAP_THRESHOLD = 0.4;

export function detectContradictions(
  rulesA: RuleInput[],
  rulesB: RuleInput[],
): ContradictionResult[] {
  const results: ContradictionResult[] = [];

  for (const a of rulesA) {
    const tokensA = tokenize(a.text);
    for (const b of rulesB) {
      if (a.id === b.id) continue;
      const tokensB = tokenize(b.text);
      const overlap = computeTokenOverlap(tokensA, tokensB);
      if (overlap < OVERLAP_THRESHOLD) continue;

      const opposing = hasOpposingDirectives(a.text, b.text);
      if (opposing) {
        results.push({
          ruleA: a.id,
          ruleB: b.id,
          similarity: overlap,
          type: "direct",
          resolution: resolveWinner(a, b),
        });
      }
    }
  }

  return results;
}

function logContradictions(contradictions: ContradictionResult[], totalPairs: number): void {
  if (contradictions.length === 0) return;

  const logDir = join(homedir(), ".agentgrit", "state");
  const logPath = join(logDir, "contradiction-log.jsonl");
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

  const rate = totalPairs > 0 ? contradictions.length / totalPairs : 0;
  const entry = {
    timestamp: new Date().toISOString(),
    contradictions: contradictions.map(c => ({
      ruleA: c.ruleA,
      ruleB: c.ruleB,
      similarity: c.similarity,
      type: c.type,
      resolution: c.resolution,
    })),
    totalPairs,
    rate: Math.round(rate * 1000) / 1000,
  };

  appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
}

interface ParsedRule {
  id: string;
  header: string;
  text: string;
  score: number;
}

function parseRulesFromMarkdown(md: string): ParsedRule[] {
  const rules: ParsedRule[] = [];
  const lines = md.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^- \*\*([^*]+)\*\*.*?\(score:\s*([\d.]+)\)/);
    if (match) {
      const id = match[1];
      const score = parseFloat(match[2]);
      const header = lines[i];
      const textLine = i + 1 < lines.length ? lines[i + 1].trim() : "";
      rules.push({ id, header, text: textLine, score });
    }
  }
  return rules;
}

export function filterContradictions(markdown: string): string {
  if (!markdown.trim()) return markdown;

  const rules = parseRulesFromMarkdown(markdown);
  if (rules.length < 2) return markdown;

  const ruleInputs: Array<RuleInput> = rules.map(r => ({
    id: r.id,
    text: r.text,
    correlationScore: r.score,
  }));

  const contradictions = detectContradictions(ruleInputs, ruleInputs);
  if (contradictions.length === 0) return markdown;

  const totalPairs = rules.length * (rules.length - 1) / 2;
  logContradictions(contradictions, totalPairs);

  const losers = new Set<string>();
  for (const c of contradictions) {
    losers.add(c.resolution === "keep-a" ? c.ruleB : c.ruleA);
  }

  const lines = markdown.split("\n");
  const filtered: string[] = [];
  let skip = false;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^- \*\*([^*]+)\*\*/);
    if (match) {
      if (losers.has(match[1])) {
        skip = true;
        if (i + 1 < lines.length && lines[i + 1].startsWith("  ")) i++;
        if (i + 1 < lines.length && lines[i + 1].trim() === "") i++;
        continue;
      }
      skip = false;
    }
    if (!skip) {
      filtered.push(lines[i]);
    }
  }

  return filtered.join("\n");
}
