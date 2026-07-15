/**
 * effectiveness.ts — Rule effectiveness tracking
 *
 * Measures whether promoted rules actually reduce the frequency of their
 * source correction patterns. Compares correction frequency BEFORE vs AFTER
 * each rule's promotion date.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { resolveSignalFile } from "../adapters/paths";
import type { PromotionRecord, CorrectionSignal, GraphNode } from "../adapters/types";

export interface EffectivenessResult {
  ruleId: string;
  patternText: string;
  promotedAt: string;
  beforeFreq: number;
  afterFreq: number;
  delta: number;
  effective: boolean;
}

// ── Text matching ──

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

const STOPWORDS = new Set([
  "the", "is", "at", "of", "on", "in", "to", "a", "an", "and", "or",
  "for", "was", "not", "but", "with", "this", "that", "from", "by",
  "are", "be", "has", "have", "had", "its", "you", "your", "can",
  "will", "all", "each", "any", "than", "then", "also",
]);

function meaningfulTokens(text: string): string[] {
  return tokenize(text).filter((w) => !STOPWORDS.has(w));
}

/**
 * Stem-aware token match: two tokens match if either is a prefix
 * of the other with at least 4 shared characters.
 * Handles "delegate"/"delegated", "task"/"tasks", "verify"/"verified".
 */
function stemMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const minLen = Math.min(a.length, b.length);
  if (minLen < 4) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  return longer.startsWith(shorter);
}

function correctionMatchesRule(
  correction: CorrectionSignal,
  ruleTokens: string[],
): boolean {
  if (ruleTokens.length === 0) return false;

  const correctionText = `${correction.correction_phrase} ${correction.context}`;
  const corrTokens = meaningfulTokens(correctionText);
  if (corrTokens.length === 0) return false;

  let hits = 0;
  for (const ruleTok of ruleTokens) {
    for (const corrTok of corrTokens) {
      if (stemMatch(ruleTok, corrTok)) {
        hits++;
        break;
      }
    }
  }

  // Require at least 20% overlap of rule tokens to consider it a match
  return hits / ruleTokens.length >= 0.2;
}

// ── Data loading ──

function loadPromotions(stateDir: string): PromotionRecord[] {
  const path = join(stateDir, "promotions.jsonl");
  if (!existsSync(path)) return [];

  const content = readFileSync(path, "utf-8");
  const records: PromotionRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as PromotionRecord);
    } catch { /* skip malformed */ }
  }
  return records;
}

function loadCorrections(signalDir: string): CorrectionSignal[] {
  const path = resolveSignalFile(signalDir, "corrections.jsonl");
  if (!existsSync(path)) return [];

  const content = readFileSync(path, "utf-8");
  const signals: CorrectionSignal[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.type === "correction") {
        signals.push(parsed as CorrectionSignal);
      }
    } catch { /* skip malformed */ }
  }
  return signals;
}

function loadRuleText(stateDir: string, ruleId: string): string | null {
  const graphPath = join(stateDir, "knowledge-graph.json");
  if (!existsSync(graphPath)) return null;

  try {
    const graph = JSON.parse(readFileSync(graphPath, "utf-8"));
    const nodes = graph.nodes ?? {};
    const node = nodes[ruleId] as GraphNode | undefined;
    return node?.description ?? null;
  } catch {
    return null;
  }
}

// ── Core function ──

export function trackRuleEffectiveness(
  stateDir: string,
  signalDir: string,
): EffectivenessResult[] {
  const promotions = loadPromotions(stateDir).filter((p) => p.approved);
  if (promotions.length === 0) return [];

  const corrections = loadCorrections(signalDir);
  const results: EffectivenessResult[] = [];

  for (const promotion of promotions) {
    const ruleText = loadRuleText(stateDir, promotion.ruleId);
    const patternText = ruleText ?? promotion.ruleId;
    const ruleTokens = meaningfulTokens(patternText);
    const promotedAt = new Date(promotion.timestamp).getTime();

    let beforeFreq = 0;
    let afterFreq = 0;

    for (const correction of corrections) {
      if (!correctionMatchesRule(correction, ruleTokens)) continue;

      const correctionTime = new Date(correction.timestamp).getTime();
      if (correctionTime < promotedAt) {
        beforeFreq++;
      } else {
        afterFreq++;
      }
    }

    const delta = afterFreq - beforeFreq;

    results.push({
      ruleId: promotion.ruleId,
      patternText,
      promotedAt: promotion.timestamp,
      beforeFreq,
      afterFreq,
      delta,
      effective: afterFreq < beforeFreq,
    });
  }

  return results;
}
