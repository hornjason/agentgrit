#!/usr/bin/env bun
/**
 * Eviction validation script for issue #152
 * Evicts worst performers and measures effectiveness delta
 */

import { findEvictionCandidates, evictRules } from "./src/promote/evict";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME ?? "";
const CLAUDE_LEARNED = join(HOME, ".claude", "CLAUDE-LEARNED.md");
const RULE_DOMAINS = join(HOME, ".claude", "MEMORY", "LEARNING", "STATE", "rule-domains.json");

interface RuleDomainEntry {
  domains: string[];
  source: string;
}

interface RuleDomainsFile {
  version: number;
  generated_at: string;
  reviewed: boolean;
  rules: Record<string, RuleDomainEntry>;
}

function loadRuleDomains(path: string): RuleDomainsFile | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as RuleDomainsFile;
  } catch {
    return null;
  }
}

function countRulesInLearnedMd(): number {
  if (!existsSync(CLAUDE_LEARNED)) return 0;
  const content = readFileSync(CLAUDE_LEARNED, "utf-8");
  const matches = content.match(/^- \*\*/gm);
  return matches?.length ?? 0;
}

async function main() {
  console.log("=== EVICTION VALIDATION #152 ===\n");

  // BEFORE state
  const beforeBudget = countRulesInLearnedMd();
  console.log(`BEFORE Budget: ${beforeBudget}/50 rules in CLAUDE-LEARNED.md\n`);

  // Find candidates
  console.log("Finding eviction candidates...");
  const candidates = findEvictionCandidates({
    claudeLearnedPath: CLAUDE_LEARNED,
    ruleDomainsPath: RULE_DOMAINS,
  });

  console.log(`Found ${candidates.length} candidates\n`);

  // Filter out reviewed rules and critical behavioral rules
  const ruleDomains = loadRuleDomains(RULE_DOMAINS);
  const criticalRules = new Set([
    "verify_before_answering",
    "minimal_scope",
    "corrections trigger immediate CLAUDE.md edits",
    "surface assumptions before implementing",
    "flag memory rule conflicts before executing",
    "never declare a fix complete before the user flow confirms it",
    "verify before asserting",
    "negative assertions get the SAME evidence bar",
  ]);

  const evictable = candidates.filter(c => {
    // Skip reviewed rules
    if (c.requiresHumanConfirmation) {
      console.log(`  SKIP (reviewed): ${c.ruleId}`);
      return false;
    }

    // Skip critical behavioral rules by name matching
    const normalized = c.ruleId.toLowerCase().replace(/[^a-z0-9]/g, "_");
    for (const critical of criticalRules) {
      const critNorm = critical.toLowerCase().replace(/[^a-z0-9]/g, "_");
      if (normalized.includes(critNorm) || critNorm.includes(normalized)) {
        console.log(`  SKIP (critical): ${c.ruleId}`);
        return false;
      }
    }

    return true;
  });

  console.log(`\n${evictable.length} evictable candidates after filtering\n`);

  // Take worst 10 (or fewer if less than 10 available)
  const toEvict = evictable.slice(0, Math.min(10, evictable.length));

  console.log(`Evicting ${toEvict.length} worst performers:\n`);
  for (const c of toEvict) {
    console.log(`  - ${c.ruleId}`);
    console.log(`    Avg rating: ${c.avgCorrelatedRating}, Sessions: ${c.sessionCount}`);
    console.log(`    Reason: ${c.reason}\n`);
  }

  // Evict
  const result = await evictRules(toEvict, CLAUDE_LEARNED, {
    ruleDomainsPath: RULE_DOMAINS,
    dryRun: false,
  });

  console.log(`\nEviction result:`);
  console.log(`  Evicted: ${result.evicted.length}`);
  console.log(`  Skipped: ${result.skipped.length}`);
  console.log(`  Errors: ${result.errors.length}\n`);

  // AFTER state
  const afterBudget = countRulesInLearnedMd();
  console.log(`AFTER Budget: ${afterBudget}/50 rules in CLAUDE-LEARNED.md`);
  console.log(`Budget freed: ${beforeBudget - afterBudget} slots\n`);

  console.log("=== VERIFICATION ===");
  console.log("Run the following commands to verify:\n");
  console.log("1. bun test --isolate test/ # Full test suite");
  console.log("2. agentgrit eval recall --live # Check recall >= 0.20");
  console.log("3. Manually verify effectiveness by checking recent session ratings\n");

  console.log("Evicted rules:");
  for (const id of result.evicted) {
    console.log(`  - ${id}`);
  }
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
