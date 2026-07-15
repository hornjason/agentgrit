import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type { Rule } from "../../src/adapters/types";
import { Tier } from "../../src/adapters/types";
import { writeRuleFile, appendToLearnedMd } from "../../src/promote/sync";

const HOME = process.env.HOME ?? "";
const PROMOTIONS_PATH = join(HOME, ".agentgrit/state/promotions.jsonl");
const RULES_DIR = join(HOME, ".claude/MEMORY/LEARNING/RULES");
const RULE_DOMAINS_PATH = join(HOME, ".claude/MEMORY/LEARNING/STATE/rule-domains.json");
const CLAUDE_LEARNED_PATH = join(HOME, ".claude/CLAUDE-LEARNED.md");

interface PromotionEntry {
  id: string;
  ruleId: string;
  tier: string;
  timestamp: string;
  beforeSnapshot: string;
  afterSnapshot: string;
  approved: boolean;
}

const KEEP_RULES: Record<string, string[]> = {
  "Canonical vocabulary for shared constants (from debrief 2026-06-24)": ["architecture", "data"],
  "Gate all optional dependencies with dynamic import (from debrief 2026-06-12)": ["deployment", "architecture"],
  "Brief and dashboard must render consistently (from debrief 2026-06-11)": ["delivery", "ui-testing"],
};

const EVICT_RULE_IDS = [
  "Gate format cheatsheet in DA context (from debrief 2026-06-29)",
  "Handoff or sub-session at 4+ hours (from debrief 2026-06-26)",
  "Never close an issue without gate files present (from debrief 2026-06-26)",
  "Quinn triggers on OUTCOME ACs, not just tsx changes (from debrief 2026-06-26)",
  "Compact context before building (from debrief 2026-06-26)",
  "Fix gate tuning issues in same session (from debrief 2026-06-26)",
  "Measure input completeness, not just output quality (from debrief 2026-06-24)",
  "Metrics + behavior change in same PR (from debrief 2026-06-24)",
  "Classify documents by content, not location (from debrief 2026-06-22)",
  "Execute when goal is clear (from debrief 2026-06-22)",
  "Visual UI audit before scraper code (from debrief 2026-06-22)",
  "Budget gate on all file-writing tools (from debrief 2026-06-19)",
  "UI visual verification mandatory (from debrief 2026-06-18)",
  "Research APIs before building scrapers (from debrief 2026-05-28)",
  "Context7 before scraper/framework development (from debrief 2026-06-16)",
  "ADR implementation tracking is mechanical (from session 2026-06-24)",
  "Enforce no-worktree for DDB at skill level (from debrief 2026-06-16)",
  "No git stash for verification (from debrief 2026-06-16)",
  "Worktree agents default to bypassPermissions (from debrief 2026-06-15)",
  "SkillRouter system-reminders are conditional mandatory rules (PAI-086)",
  "Council before structural presentation changes (from debrief 2026-06-11)",
  "Sequential presentation for design discussions (from debrief 2026-06-10)",
  "Cached fallback for Gemini extractions (from debrief 2026-06-09)",
  "Council must critique real output (from debrief 2026-06-09)",
  "Action buttons on intelligence cards must auto-generate, not navigate to blank forms (from debrief 2026-06-07)",
  "Verify external link URLs after shipping (from debrief 2026-06-04)",
  "Checkpoint must include project path (from debrief 2026-06-04)",
  "DA must grep-verify after every agent edit (from debrief 2026-06-03)",
];

const KEEP_RULE_TEXT: Record<string, string> = {
  "Canonical vocabulary for shared constants (from debrief 2026-06-24)":
    "When multiple modules reference the same constant values (status codes, category names, tier labels), define them in a single canonical source file. Never duplicate string literals across modules — import from the canonical source.",
  "Gate all optional dependencies with dynamic import (from debrief 2026-06-12)":
    "Optional dependencies (AI models, cloud SDKs, analytics) must use dynamic import() behind capability checks. Static imports of optional packages cause startup failures when the dependency is unavailable in certain environments.",
  "Brief and dashboard must render consistently (from debrief 2026-06-11)":
    "The daily brief email and the dashboard web view must render the same data with consistent formatting. Any change to rendering logic must be verified in both contexts before shipping.",
};

function run() {
  const lines = readFileSync(PROMOTIONS_PATH, "utf-8").trim().split("\n");
  const entries: PromotionEntry[] = lines.map((l) => JSON.parse(l));
  const beforeCount = entries.length;

  console.log(`Promotions before: ${beforeCount}`);

  const keepIds = new Set(Object.keys(KEEP_RULES));
  const evictIds = new Set(EVICT_RULE_IDS);

  // Validate counts
  const orphanCount = entries.filter((e) => keepIds.has(e.ruleId) || evictIds.has(e.ruleId)).length;
  console.log(`Orphans identified: ${orphanCount} (keep: ${keepIds.size}, evict: ${evictIds.size})`);

  // --- KEEP: sync 3 rules ---
  for (const [ruleId, domains] of Object.entries(KEEP_RULES)) {
    const entry = entries.find((e) => e.ruleId === ruleId);
    if (!entry) {
      console.error(`KEEP rule not found in ledger: ${ruleId}`);
      continue;
    }

    const rule: Rule = {
      id: ruleId,
      text: KEEP_RULE_TEXT[ruleId],
      tier: entry.tier === "global" ? Tier.Global : Tier.Project,
      tags: [],
      created: entry.timestamp,
      correlationScore: 0,
      sourceSignals: [],
      schemaVersion: 1,
    };

    // 1. Write .md file
    const mdPath = writeRuleFile(rule, RULES_DIR);
    console.log(`  Created: ${mdPath}`);

    // 2. Update rule-domains.json with specified domains (not auto-classified)
    updateDomainsManual(ruleId, domains);
    console.log(`  Domains: ${domains.join(", ")}`);

    // 3. Append to CLAUDE-LEARNED.md
    appendToLearnedMd(rule, CLAUDE_LEARNED_PATH);
    console.log(`  Appended to CLAUDE-LEARNED.md`);
  }

  // --- EVICT: remove 28 from ledger ---
  const remaining = entries.filter((e) => !evictIds.has(e.ruleId));
  const evictedCount = beforeCount - remaining.length;
  console.log(`\nEvicted ${evictedCount} entries from promotions.jsonl`);

  // Write back
  const newContent = remaining.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(PROMOTIONS_PATH, newContent);

  const afterCount = remaining.length;
  console.log(`Promotions after: ${afterCount}`);
  console.log(`\nSummary: ${beforeCount} -> ${afterCount} (removed ${evictedCount}, kept ${keepIds.size} synced)`);
}

function updateDomainsManual(ruleId: string, domains: string[]) {
  let file: { version: number; reviewed: boolean; rules: Record<string, { domains: string[]; source: string }> };

  if (existsSync(RULE_DOMAINS_PATH)) {
    file = JSON.parse(readFileSync(RULE_DOMAINS_PATH, "utf-8"));
  } else {
    file = { version: 1, reviewed: false, rules: {} };
  }

  file.rules[ruleId] = { domains, source: "manual-cleanup" };
  writeFileSync(RULE_DOMAINS_PATH, JSON.stringify(file, null, 2));
}

run();
