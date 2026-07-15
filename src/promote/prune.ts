import { readFileSync } from "fs";
import { randomUUID } from "crypto";
import type { Rule } from "../adapters/types";
import { Tier, SCHEMA_VERSION } from "../adapters/types";
import { checkBudget } from "./budget";
import { getEvictionCandidates } from "./rules";
import { removeRule } from "./bridge";
import { recordPromotion } from "./ledger";
import { removeFromRuleDomains } from "./evict";

export interface PruneResult {
  removed: string[];
  remaining: number;
  wasOverBudget: boolean;
}

function countRules(content: string): number {
  return (content.match(/^- \*\*/gm) || []).length;
}

function extractRulesWithIds(content: string): Rule[] {
  const rules: Rule[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(/^- \*\*([^:]+):\*\*\s*(.*)/);
    if (!match) continue;
    rules.push({
      id: match[1],
      text: match[2],
      tier: Tier.Global,
      tags: [],
      created: "",
      correlationScore: 0,
      sourceSignals: [],
      schemaVersion: SCHEMA_VERSION,
    });
  }
  return rules;
}

export async function pruneTobudget(
  claudeMdPath: string,
  tier: Tier,
  options?: { dryRun?: boolean; maxPrune?: number; stateDir?: string; budgetOverride?: number; ruleDomainsPath?: string },
): Promise<PruneResult> {
  const maxPrune = options?.maxPrune ?? 10;
  const dryRun = options?.dryRun ?? false;

  const content = readFileSync(claudeMdPath, "utf-8");
  const ruleCount = countRules(content);
  const budget = checkBudget(tier, ruleCount, options?.budgetOverride);

  if (budget.level !== "OVER_BUDGET") {
    return { removed: [], remaining: ruleCount, wasOverBudget: false };
  }

  const rules = extractRulesWithIds(content);
  let candidates = getEvictionCandidates(rules, maxPrune + 5);
  if (candidates.length === 0) {
    candidates = rules.slice().reverse().slice(0, maxPrune + 5);
  }

  const removed: string[] = [];
  let current = ruleCount;

  for (const candidate of candidates) {
    if (removed.length >= maxPrune) break;

    const afterRemoval = checkBudget(tier, current - 1, options?.budgetOverride);
    if (dryRun) {
      removed.push(candidate.id);
      current--;
      if (afterRemoval.level !== "OVER_BUDGET") break;
      continue;
    }

    await removeRule(candidate.id, claudeMdPath);

    if (options?.stateDir) {
      await recordPromotion(
        {
          id: randomUUID(),
          ruleId: candidate.id,
          tier,
          timestamp: new Date().toISOString(),
          beforeSnapshot: "",
          afterSnapshot: "",
          approved: true,
        },
        options.stateDir,
      );
    }

    removed.push(candidate.id);
    current--;

    if (afterRemoval.level !== "OVER_BUDGET") break;
  }

  // Clean up stale entries from rule-domains.json
  if (!dryRun && removed.length > 0) {
    removeFromRuleDomains(removed, options?.ruleDomainsPath);
  }

  return { removed, remaining: current, wasOverBudget: true };
}
