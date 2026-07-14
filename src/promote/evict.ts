import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { loadConfig, statePath } from "../adapters/paths";
import { loadRuleStats, type RuleStats } from "./rules";
import { removeRule } from "./bridge";

const _cfg = loadConfig();
const EVICTION_FILE = "eviction-candidates.json";
const DEFAULT_BUDGET = _cfg.thresholds?.defaultEvictionBudget ?? 80;
const CORRELATION_THRESHOLD = _cfg.thresholds?.correlationThreshold ?? 3.0;
const MIN_SESSIONS = 5;
const SIMILARITY_THRESHOLD = _cfg.thresholds?.similarityThreshold ?? 0.85;
const STALE_DAYS = 60;

export interface EvictionCandidate {
  ruleId: string;
  avgCorrelatedRating: number;
  sessionCount: number;
  reason: string;
  requiresHumanConfirmation?: boolean;
}

export interface DuplicateCandidate {
  ruleIdA: string;
  ruleIdB: string;
  similarity: number;
}

export interface EvictionResult {
  evicted: string[];
  skipped: string[];
  errors: string[];
}

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

function isReviewedRule(ruleId: string, ruleDomains: RuleDomainsFile | null): boolean {
  if (!ruleDomains) return false;
  const entry = ruleDomains.rules[ruleId];
  return entry?.source === "reviewed";
}

export function findEvictionCandidates(options?: {
  stateDir?: string;
  ruleDomainsPath?: string;
  threshold?: number;
  minSessions?: number;
}): EvictionCandidate[] {
  const threshold = options?.threshold ?? CORRELATION_THRESHOLD;
  const minSessions = options?.minSessions ?? MIN_SESSIONS;
  const statsMap = loadRuleStats(options?.stateDir);
  const ruleDomains = loadRuleDomains(
    options?.ruleDomainsPath ?? join(process.env.HOME ?? "", ".claude", "MEMORY", "LEARNING", "STATE", "rule-domains.json"),
  );

  const candidates: EvictionCandidate[] = [];
  const now = Date.now();

  for (const stats of statsMap.values()) {
    if (stats.lastSeen) {
      const daysSince = (now - new Date(stats.lastSeen).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince > STALE_DAYS) {
        const candidate: EvictionCandidate = {
          ruleId: stats.ruleId,
          avgCorrelatedRating: Math.round(stats.avgCorrelatedRating * 100) / 100,
          sessionCount: stats.injectionCount,
          reason: `stale: last seen ${Math.round(daysSince)} days ago`,
        };
        if (isReviewedRule(stats.ruleId, ruleDomains)) {
          candidate.requiresHumanConfirmation = true;
        }
        candidates.push(candidate);
        continue;
      }
    }

    if (stats.injectionCount < minSessions) continue;
    if (stats.avgCorrelatedRating >= threshold) continue;

    const candidate: EvictionCandidate = {
      ruleId: stats.ruleId,
      avgCorrelatedRating: Math.round(stats.avgCorrelatedRating * 100) / 100,
      sessionCount: stats.injectionCount,
      reason: `avgCorrelatedRating ${stats.avgCorrelatedRating.toFixed(2)} < ${threshold} across ${stats.injectionCount} sessions`,
    };

    if (isReviewedRule(stats.ruleId, ruleDomains)) {
      candidate.requiresHumanConfirmation = true;
    }

    candidates.push(candidate);
  }

  candidates.sort((a, b) => a.avgCorrelatedRating - b.avgCorrelatedRating);

  const outPath = join(options?.stateDir ?? dirname(statePath(EVICTION_FILE)), EVICTION_FILE);
  const outDir = dirname(outPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, JSON.stringify(candidates, null, 2), "utf-8");

  return candidates;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2),
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

export function findDuplicates(
  rules: Array<{ id: string; text: string }>,
  threshold?: number,
): DuplicateCandidate[] {
  const sim = threshold ?? SIMILARITY_THRESHOLD;
  const tokenized = rules.map(r => ({ id: r.id, tokens: tokenize(r.text) }));
  const duplicates: DuplicateCandidate[] = [];

  for (let i = 0; i < tokenized.length; i++) {
    for (let j = i + 1; j < tokenized.length; j++) {
      const score = jaccardSimilarity(tokenized[i].tokens, tokenized[j].tokens);
      if (score >= sim) {
        duplicates.push({
          ruleIdA: tokenized[i].id,
          ruleIdB: tokenized[j].id,
          similarity: Math.round(score * 1000) / 1000,
        });
      }
    }
  }

  duplicates.sort((a, b) => b.similarity - a.similarity);
  return duplicates;
}

export async function evictRules(
  candidates: EvictionCandidate[],
  claudeLearnedPath: string,
  options?: {
    ruleDomainsPath?: string;
    dryRun?: boolean;
  },
): Promise<EvictionResult> {
  const result: EvictionResult = { evicted: [], skipped: [], errors: [] };
  const dryRun = options?.dryRun ?? false;

  const ruleDomains = loadRuleDomains(
    options?.ruleDomainsPath ?? join(process.env.HOME ?? "", ".claude", "MEMORY", "LEARNING", "STATE", "rule-domains.json"),
  );

  for (const candidate of candidates) {
    if (candidate.requiresHumanConfirmation) {
      result.skipped.push(candidate.ruleId);
      continue;
    }

    if (dryRun) {
      result.evicted.push(candidate.ruleId);
      continue;
    }

    // Remove from CLAUDE-LEARNED.md
    try {
      if (existsSync(claudeLearnedPath)) {
        await removeRule(candidate.ruleId, claudeLearnedPath);
      }
    } catch {
      // Rule might not exist in CLAUDE-LEARNED.md by exact ID match
    }

    // Remove from rule-domains.json
    if (ruleDomains && ruleDomains.rules[candidate.ruleId]) {
      delete ruleDomains.rules[candidate.ruleId];
    }

    result.evicted.push(candidate.ruleId);
  }

  // Persist updated rule-domains.json
  if (!dryRun && ruleDomains && result.evicted.length > 0) {
    const rdPath = options?.ruleDomainsPath ?? join(process.env.HOME ?? "", ".claude", "MEMORY", "LEARNING", "STATE", "rule-domains.json");
    if (existsSync(rdPath)) {
      ruleDomains.generated_at = new Date().toISOString();
      writeFileSync(rdPath, JSON.stringify(ruleDomains, null, 2), "utf-8");
    }
  }

  return result;
}

export function enforceBudget(
  candidates: EvictionCandidate[],
  totalRuleCount: number,
  budget?: number,
): EvictionCandidate[] {
  const cap = budget ?? DEFAULT_BUDGET;
  if (totalRuleCount <= cap) return [];

  const excess = totalRuleCount - cap;
  const evictable = candidates.filter(c => !c.requiresHumanConfirmation);
  return evictable.slice(0, excess);
}
