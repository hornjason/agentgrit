import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { loadConfig, statePath } from "../adapters/paths";
import { loadRuleStats, type RuleStats } from "./rules";
import { removeRule, normalizeRuleId } from "./bridge";

const _cfg = loadConfig();
const EVICTION_FILE = "eviction-candidates.json";
const DEFAULT_BUDGET = _cfg.thresholds?.defaultEvictionBudget ?? 80;
const CORRELATION_THRESHOLD = _cfg.thresholds?.correlationThreshold ?? 3.0;
const MIN_SESSIONS = 5;
const SIMILARITY_THRESHOLD = _cfg.thresholds?.similarityThreshold ?? 0.85;
const MIN_TEXT_LENGTH = 20;
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

interface GraphNode {
  id: string;
  name: string;
  description?: string;
}

function loadGraphNodes(graphPath: string): GraphNode[] {
  if (!existsSync(graphPath)) return [];
  try {
    const graph = JSON.parse(readFileSync(graphPath, "utf-8"));
    return Object.values(graph.nodes ?? {}) as GraphNode[];
  } catch {
    return [];
  }
}

function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 3);
}

function fuzzyWordMatch(needle: string[], haystack: string): boolean {
  if (needle.length === 0) return false;
  const haystackLower = haystack.toLowerCase();
  let hits = 0;
  for (const w of needle) {
    if (haystackLower.includes(w)) hits++;
  }
  return hits / needle.length > 0.6;
}

/**
 * Build a normalized lookup from CLAUDE-LEARNED.md: normalizedId → original bold name.
 * Also build a reverse map from normalizedId → stat entry, for bidirectional matching.
 * Uses three strategies: exact normalization, graph-bridge forward, graph-bridge reverse.
 */
export function buildLearnedStatsLookup(
  claudeLearnedPath: string,
  statsMap: Map<string, RuleStats>,
  graphPath?: string,
): { learnedToStatId: Map<string, string>; statIdToLearnedName: Map<string, string> } {
  const learnedToStatId = new Map<string, string>();
  const statIdToLearnedName = new Map<string, string>();

  if (!existsSync(claudeLearnedPath)) return { learnedToStatId, statIdToLearnedName };

  const content = readFileSync(claudeLearnedPath, "utf-8");
  const learnedNameRe = /^- \*\*(.+?)(?:\s*\(from\s.*?\))?:\*\*\s*/;

  const learnedNormMap = new Map<string, string>();
  for (const line of content.split("\n")) {
    const m = line.match(learnedNameRe);
    if (!m) continue;
    const boldName = m[1].trim();
    const norm = normalizeRuleId(boldName);
    learnedNormMap.set(norm, boldName);
  }

  // Strategy 1: direct normalization match
  for (const [statId] of statsMap) {
    const statNorm = normalizeRuleId(statId);
    const learnedName = learnedNormMap.get(statNorm);
    if (learnedName) {
      learnedToStatId.set(learnedName, statId);
      statIdToLearnedName.set(statId, learnedName);
    }
  }

  // Strategy 2: graph-bridge matching
  const gPath = graphPath ?? join(process.env.HOME ?? "", ".agentgrit", "state", "knowledge-graph.json");
  const graphNodes = loadGraphNodes(gPath);
  if (graphNodes.length > 0) {
    const matchedBoldNames = new Set(learnedToStatId.keys());
    const unmatchedLearned = [...learnedNormMap.entries()].filter(([, boldName]) => !matchedBoldNames.has(boldName));

    // Forward: for each unmatched bold name, find a graph node whose name words appear in it
    for (const [, boldName] of unmatchedLearned) {
      for (const node of graphNodes) {
        const nodeWords = significantWords(node.name);
        if (fuzzyWordMatch(nodeWords, boldName) && statsMap.has(node.id)) {
          learnedToStatId.set(boldName, node.id);
          statIdToLearnedName.set(node.id, boldName);
          break;
        }
      }
    }

    // Reverse: for each unmatched stat ID, find graph node, fuzzy match description against bold names
    const matchedStatIds = new Set(statIdToLearnedName.keys());
    const stillUnmatchedLearned = [...learnedNormMap.entries()].filter(([, boldName]) => !learnedToStatId.has(boldName));
    if (stillUnmatchedLearned.length > 0) {
      const nodeById = new Map(graphNodes.map(n => [n.id, n]));
      for (const [statId] of statsMap) {
        if (matchedStatIds.has(statId)) continue;
        const node = nodeById.get(statId);
        if (!node?.description) continue;
        const descWords = significantWords(node.description);
        for (const [, boldName] of stillUnmatchedLearned) {
          if (learnedToStatId.has(boldName)) continue;
          if (fuzzyWordMatch(descWords, boldName)) {
            learnedToStatId.set(boldName, statId);
            statIdToLearnedName.set(statId, boldName);
            break;
          }
        }
      }
    }
  }

  return { learnedToStatId, statIdToLearnedName };
}

export function findEvictionCandidates(options?: {
  stateDir?: string;
  ruleDomainsPath?: string;
  threshold?: number;
  minSessions?: number;
  claudeLearnedPath?: string;
}): EvictionCandidate[] {
  const threshold = options?.threshold ?? CORRELATION_THRESHOLD;
  const minSessions = options?.minSessions ?? MIN_SESSIONS;
  const statsMap = loadRuleStats(options?.stateDir);
  const ruleDomains = loadRuleDomains(
    options?.ruleDomainsPath ?? join(process.env.HOME ?? "", ".claude", "MEMORY", "LEARNING", "STATE", "rule-domains.json"),
  );

  const candidates: EvictionCandidate[] = [];
  const candidateIds = new Set<string>();
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
        candidateIds.add(stats.ruleId);
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
    candidateIds.add(stats.ruleId);
  }

  // Bidirectional: scan CLAUDE-LEARNED.md entries for stat matches and untracked rules
  if (options?.claudeLearnedPath && existsSync(options.claudeLearnedPath)) {
    const { learnedToStatId } = buildLearnedStatsLookup(options.claudeLearnedPath, statsMap);

    // Phase 1: learned entries with matching (but bad) stats
    for (const [learnedName, statId] of learnedToStatId) {
      if (candidateIds.has(statId)) continue;
      const stats = statsMap.get(statId);
      if (!stats) continue;

      let reason: string | null = null;
      if (stats.lastSeen) {
        const daysSince = (now - new Date(stats.lastSeen).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSince > STALE_DAYS) {
          reason = `stale (via learned match): last seen ${Math.round(daysSince)} days ago`;
        }
      }
      if (!reason && stats.injectionCount >= minSessions && stats.avgCorrelatedRating < threshold) {
        reason = `learned match: avgCorrelatedRating ${stats.avgCorrelatedRating.toFixed(2)} < ${threshold} across ${stats.injectionCount} sessions`;
      }
      if (!reason) continue;

      const candidate: EvictionCandidate = {
        ruleId: learnedName,
        avgCorrelatedRating: Math.round(stats.avgCorrelatedRating * 100) / 100,
        sessionCount: stats.injectionCount,
        reason,
      };
      if (isReviewedRule(statId, ruleDomains)) {
        candidate.requiresHumanConfirmation = true;
      }
      candidates.push(candidate);
      candidateIds.add(statId);
    }

    // Phase 2: learned entries with NO stats at all — untracked and old
    const learnedContent = readFileSync(options.claudeLearnedPath, "utf-8");
    const dateRe = /^- \*\*(.+?)(?:\s*\(from\s+(?:\S+)\s+(\d{4}-\d{2}-\d{2})\))?:\*\*\s*/;
    const trackedNorms = new Set<string>();
    for (const [statId] of statsMap) trackedNorms.add(normalizeRuleId(statId));

    for (const line of learnedContent.split("\n")) {
      const m = line.match(dateRe);
      if (!m) continue;
      const boldName = m[1].trim();
      const dateStr = m[2];
      const norm = normalizeRuleId(boldName);

      if (trackedNorms.has(norm)) continue;
      if (candidateIds.has(boldName)) continue;
      if (!dateStr) continue;

      const ruleDate = new Date(dateStr + "T00:00:00Z").getTime();
      const daysSince = (now - ruleDate) / (1000 * 60 * 60 * 24);
      if (daysSince <= STALE_DAYS) continue;

      candidates.push({
        ruleId: boldName,
        avgCorrelatedRating: 0,
        sessionCount: 0,
        reason: `untracked: no stats, created ${Math.round(daysSince)} days ago`,
      });
      candidateIds.add(boldName);
    }
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
  const eligible = rules.filter(r => r.text.length >= MIN_TEXT_LENGTH);
  const tokenized = eligible.map(r => ({ id: r.id, tokens: tokenize(r.text) }));
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

    result.evicted.push(candidate.ruleId);
  }

  // Remove evicted rules from rule-domains.json
  if (!dryRun && result.evicted.length > 0) {
    removeFromRuleDomains(result.evicted, options?.ruleDomainsPath);
  }

  return result;
}

/**
 * Remove evicted rule IDs from rule-domains.json on disk.
 * Shared by evictRules, pruneLearnedRules, and pruneTobudget.
 */
export function removeFromRuleDomains(
  ruleIds: string[],
  ruleDomainsPath?: string,
): void {
  if (ruleIds.length === 0) return;
  const rdPath = ruleDomainsPath ?? join(process.env.HOME ?? "", ".claude", "MEMORY", "LEARNING", "STATE", "rule-domains.json");
  const ruleDomains = loadRuleDomains(rdPath);
  if (!ruleDomains) return;

  let changed = false;
  for (const id of ruleIds) {
    if (ruleDomains.rules[id]) {
      delete ruleDomains.rules[id];
      changed = true;
    }
  }

  if (changed) {
    ruleDomains.generated_at = new Date().toISOString();
    writeFileSync(rdPath, JSON.stringify(ruleDomains, null, 2), "utf-8");
  }
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

export interface ExpiredEntry {
  slug: string;
  date: string;
  ageDays: number;
}

export interface ExpireResult {
  expired: ExpiredEntry[];
  kept: number;
  total: number;
}

const PENDING_SECTION_RE = /^## \[(PROPOSED|PROMOTED)\s*-\s*(\d{4}-\d{2}-\d{2})\]\s+(.+)$/;
const DEFAULT_PENDING_EXPIRY_DAYS = 30;

export function expirePendingRules(
  pendingMdPath: string,
  maxAgeDays?: number,
): ExpireResult {
  const cfg = loadConfig();
  const expiryDays = maxAgeDays ?? cfg.rules?.pendingExpiryDays ?? DEFAULT_PENDING_EXPIRY_DAYS;
  const now = Date.now();

  if (!existsSync(pendingMdPath)) {
    return { expired: [], kept: 0, total: 0 };
  }

  const content = readFileSync(pendingMdPath, "utf-8");
  const lines = content.split("\n");

  interface Section {
    startLine: number;
    endLine: number;
    slug: string;
    date: string;
    status: string;
  }

  const sections: Section[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(PENDING_SECTION_RE);
    if (match) {
      if (sections.length > 0) {
        sections[sections.length - 1].endLine = i;
      }
      sections.push({
        startLine: i,
        endLine: lines.length,
        slug: match[3],
        date: match[2],
        status: match[1],
      });
    }
  }
  if (sections.length > 0) {
    sections[sections.length - 1].endLine = lines.length;
  }

  const total = sections.length;
  const expired: ExpiredEntry[] = [];
  const linesToRemove = new Set<number>();

  for (const section of sections) {
    const sectionDate = new Date(section.date + "T00:00:00Z");
    const ageDays = (now - sectionDate.getTime()) / (1000 * 60 * 60 * 24);

    if (ageDays > expiryDays) {
      expired.push({ slug: section.slug, date: section.date, ageDays: Math.round(ageDays) });
      for (let i = section.startLine; i < section.endLine; i++) {
        linesToRemove.add(i);
      }
    }
  }

  if (expired.length > 0) {
    const kept = lines.filter((_, i) => !linesToRemove.has(i));
    const cleaned: string[] = [];
    for (const line of kept) {
      if (line.trim() === "" && cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === "") {
        continue;
      }
      cleaned.push(line);
    }
    writeFileSync(pendingMdPath, cleaned.join("\n"), "utf-8");
  }

  return { expired, kept: total - expired.length, total };
}
