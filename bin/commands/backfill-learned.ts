import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getBaseDir } from "../../src/adapters/paths";
import { writeRuleFile, updateRuleDomains } from "../../src/promote/sync";
import { loadRuleStats, persistRuleStats, type RuleStats } from "../../src/promote/rules";
import { defaultRuleDomainsPath } from "../../src/graph/builder";
import { Tier, SCHEMA_VERSION, type Rule } from "../../src/adapters/types";

const RULES_DIR = join(homedir(), ".claude", "MEMORY", "LEARNING", "RULES");
const LEARNED_PATH = join(homedir(), ".claude", "CLAUDE-LEARNED.md");

interface ParsedRule {
  boldName: string;
  ruleId: string;
  text: string;
}

function slugify(name: string): string {
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, "")
    .replace(/[-\s]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");

  const knownPrefixes = ["feedback_", "success_", "project_", "reference_"];
  const hasPrefix = knownPrefixes.some((p) => slug.startsWith(p));
  if (!hasPrefix) slug = `feedback_${slug}`;

  return slug;
}

function parseLearnedRules(content: string): ParsedRule[] {
  const rules: ParsedRule[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const match = line.match(/^- \*\*(.+?)\s*(?:\(from .+?\))?:\*\*\s*(.+)$/);
    if (!match) continue;

    const boldName = match[1].trim();
    const text = match[2].trim();
    const ruleId = slugify(boldName);

    rules.push({ boldName, ruleId, text });
  }

  return rules;
}

function findExistingFile(ruleId: string, existingFiles: Map<string, string>): string | null {
  if (existingFiles.has(ruleId)) return ruleId;

  for (const [fileId, content] of existingFiles) {
    if (fileId.includes(ruleId) || ruleId.includes(fileId)) return fileId;
  }

  return null;
}

export async function backfillLearnedCommand(args: string[]): Promise<void> {
  const base = getBaseDir();

  if (!existsSync(base)) {
    console.log("agentgrit not initialized. Run 'agentgrit init' first.");
    return;
  }

  console.log("\nagentgrit rules backfill-learned\n");

  const dryRun = args.includes("--dry-run");
  if (dryRun) console.log("  [DRY RUN — no files will be written]\n");

  if (!existsSync(LEARNED_PATH)) {
    console.log(`  ✗ CLAUDE-LEARNED.md not found at ${LEARNED_PATH}`);
    return;
  }

  const learnedContent = readFileSync(LEARNED_PATH, "utf-8");
  const parsedRules = parseLearnedRules(learnedContent);

  console.log(`  Parsed ${parsedRules.length} rules from CLAUDE-LEARNED.md`);

  const existingFiles = new Map<string, string>();
  if (existsSync(RULES_DIR)) {
    for (const f of readdirSync(RULES_DIR)) {
      if (!f.endsWith(".md")) continue;
      const id = f.replace(/\.md$/, "");
      const content = readFileSync(join(RULES_DIR, f), "utf-8");
      existingFiles.set(id, content);
    }
  }

  console.log(`  Existing .md files in RULES dir: ${existingFiles.size}`);

  const ruleDomainsPath = defaultRuleDomainsPath();
  let created = 0;
  let skipped = 0;
  let domainEntries = 0;

  for (const parsed of parsedRules) {
    const existing = findExistingFile(parsed.ruleId, existingFiles);
    if (existing) {
      skipped++;
      continue;
    }

    const rule: Rule = {
      id: parsed.ruleId,
      text: parsed.text,
      tier: Tier.Graph,
      tags: ["learned", "backfill"],
      created: new Date().toISOString(),
      correlationScore: 0,
      sourceSignals: [],
      schemaVersion: SCHEMA_VERSION,
    };

    if (!dryRun) {
      writeRuleFile(rule, RULES_DIR);
      const domains = updateRuleDomains(rule, ruleDomainsPath);
      console.log(`  ✓ ${parsed.ruleId} → [${domains.join(", ")}]`);
      domainEntries++;
    } else {
      console.log(`  → would create: ${parsed.ruleId}`);
    }

    created++;
  }

  console.log(`\n  Created: ${created} | Skipped (existing): ${skipped} | Total parsed: ${parsedRules.length}`);

  if (!dryRun && created > 0) {
    console.log(`  Domain entries added: ${domainEntries}`);

    console.log("\n  Seeding stats for rules without entries...");
    const statsMap = loadRuleStats();
    let seeded = 0;
    for (const parsed of parsedRules) {
      if (statsMap.has(parsed.ruleId)) continue;
      const entry: RuleStats = {
        ruleId: parsed.ruleId,
        injectionCount: 0,
        avgCorrelatedRating: 5.0,
        sessionRatings: [],
        highRatingActivations: 0,
        lowRatingActivations: 0,
        lastSeen: "",
      };
      statsMap.set(parsed.ruleId, entry);
      seeded++;
    }

    if (seeded > 0) {
      persistRuleStats(Array.from(statsMap.values()));
      console.log(`  Seeded ${seeded} new stats entries (total: ${statsMap.size})`);
    } else {
      console.log(`  All rules already have stats entries`);
    }
  }

  if (!dryRun) {
    const fileCount = existsSync(RULES_DIR) ? readdirSync(RULES_DIR).filter((f) => f.endsWith(".md")).length : 0;
    console.log(`\n  Final .md file count in RULES dir: ${fileCount}`);
  }

  console.log("");
}
