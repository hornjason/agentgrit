import { tokenize } from "../graph/bm25";
import type { CorrectionSignal } from "../adapters/types";

export interface RuleAttribution {
  ruleId: string;
  sessionId: string;
  baseScore: number;
  attributedScore: number;
  correctionProximity: number;
}

interface RuleText {
  id: string;
  text: string;
  domains?: string[];
}

const CORRECTION_SIMILARITY_THRESHOLD = 0.3;
const CORRECTION_PENALTY = 0.5;
const DOMAIN_MATCH_BONUS = 0.2;

function bm25SimilarityInline(ruleTokens: Record<string, number>, ruleLen: number, queryTokens: string[]): number {
  if (queryTokens.length === 0 || ruleLen === 0) return 0;
  const K1 = 1.5;
  const B = 0.75;
  let score = 0;
  for (const term of queryTokens) {
    const tf = ruleTokens[term] || 0;
    if (tf === 0) continue;
    const idf = Math.log(2);
    const tfNorm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (ruleLen / ruleLen)));
    score += idf * tfNorm;
  }
  return score;
}

function tokenizeAndCount(text: string): { tokens: Record<string, number>; len: number } {
  const toks = tokenize(text);
  const tokens: Record<string, number> = {};
  for (const t of toks) {
    tokens[t] = (tokens[t] || 0) + 1;
  }
  return { tokens, len: toks.length };
}

export function attributeRulesToCorrections(
  sessionRules: RuleText[],
  corrections: CorrectionSignal[],
  sessionScore: number,
  taskDomains?: string[],
): RuleAttribution[] {
  if (sessionRules.length === 0) {
    return [];
  }

  const ruleTokenized = sessionRules.map(r => ({
    ...r,
    ...tokenizeAndCount(r.text),
  }));

  const attributions: RuleAttribution[] = [];

  for (const rule of ruleTokenized) {
    let adjustedScore = sessionScore;
    let maxProximity = 0;

    for (const correction of corrections) {
      const correctionText = `${correction.correction_phrase} ${correction.context}`;
      const queryTokens = tokenize(correctionText);
      const similarity = bm25SimilarityInline(rule.tokens, rule.len, queryTokens);

      if (similarity > maxProximity) maxProximity = similarity;

      if (similarity > CORRECTION_SIMILARITY_THRESHOLD) {
        adjustedScore -= CORRECTION_PENALTY;
      }
    }

    if (corrections.length === 0 && taskDomains && rule.domains) {
      const domainMatch = rule.domains.some(d => taskDomains.includes(d));
      if (domainMatch) {
        adjustedScore += DOMAIN_MATCH_BONUS;
      }
    }

    adjustedScore = Math.max(1, Math.min(sessionScore, adjustedScore));

    attributions.push({
      ruleId: rule.id,
      sessionId: corrections[0]?.session_id ?? "",
      baseScore: sessionScore,
      attributedScore: Math.round(adjustedScore * 10) / 10,
      correctionProximity: Math.round(maxProximity * 1000) / 1000,
    });
  }

  return attributions;
}
