import type { GraphNode } from "../adapters/types";

// ── Gold Set Types ──

export interface GoldSession {
  sessionId: string;
  timestamp?: string;
  description: string;
  task_context?: string;
  domains?: string[];
  relevantRules: string[];
  excluded_rules?: string[];
  noRules?: boolean;
  autoLabeled?: boolean;
  synthetic?: boolean;
  targetNode?: string;
  generationMethod?: string;
}

export interface GoldSet {
  labeled: Record<string, GoldSession>;
  totalLabeled: number;
  updated: string;
}

// ── Auto-Labeling ──

const DOMAIN_PATTERNS: Array<{ pattern: RegExp; domain: string }> = [
  { pattern: /deploy|container|rebuild|make|port|docker|podman/i, domain: "deployment" },
  { pattern: /test|playwright|visual|screenshot|spec/i, domain: "ui-testing" },
  { pattern: /verify|check|assert|inaccurate|wrong|incorrect|correction|mistake|assumed/i, domain: "verification" },
  { pattern: /scope|minimal|unrequested|bonus/i, domain: "scope" },
  { pattern: /partial|omission|incomplete|missing|skipped/i, domain: "delivery" },
  { pattern: /communicate|format|response|tone|approval|conversation|dialog/i, domain: "communication" },
  { pattern: /security|vulnerabilit|destructive|gate|audit/i, domain: "security" },
  { pattern: /browser|iframe|selector|sso|scraper|vpn/i, domain: "browser" },
  { pattern: /data|pipeline|scrape|account|customer|report/i, domain: "data" },
  { pattern: /delegate|agent|escalat/i, domain: "delegation" },
  { pattern: /memory|graph|rule|learn|algorithm/i, domain: "memory" },
];

export function inferDomains(text: string, fallbackDomains = ["verification", "delivery"]): string[] {
  const matched = new Set<string>();
  for (const { pattern, domain } of DOMAIN_PATTERNS) {
    if (pattern.test(text)) matched.add(domain);
  }
  return matched.size > 0 ? [...matched] : fallbackDomains;
}

export function domainFallback(
  sessionDomains: string[], nodes: Record<string, GraphNode>,
  ruleFrequencies?: Map<string, number>, maxRules = 25,
): string[] {
  const domainSet = new Set(sessionDomains);
  let matched = Object.values(nodes).filter((n) => n.domains.some((d) => domainSet.has(d))).map((n) => n.id);
  if (matched.length > maxRules && ruleFrequencies) {
    matched.sort((a, b) => (ruleFrequencies.get(a) ?? 0) - (ruleFrequencies.get(b) ?? 0));
    matched = matched.slice(0, maxRules);
  } else if (matched.length > maxRules) {
    matched = matched.slice(0, maxRules);
  }
  return matched;
}

export interface AutoLabelConfig {
  maxRulesPerSession: number;
  classifier: (description: string, transcriptTail: string, ruleList: string) => Promise<string[]>;
}

export interface AutoLabelResult { labeled: number; skipped: number; alreadyLabeled: number; }

export function buildRuleList(nodes: Record<string, GraphNode>): string {
  return Object.values(nodes).map((n) => `${n.id}: ${n.name} -- ${n.description}`).join("\n");
}

export async function autoLabel(
  sessions: Array<{ sessionId: string; timestamp: string; description: string; transcript: string }>,
  nodes: Record<string, GraphNode>, existingGold: GoldSet, config: AutoLabelConfig,
): Promise<{ gold: GoldSet; result: AutoLabelResult }> {
  const nodeIds = new Set(Object.keys(nodes));
  const ruleList = buildRuleList(nodes);
  const gold = structuredClone(existingGold);
  let labeled = 0; let skipped = 0;
  const alreadyLabeled = Object.keys(gold.labeled).length;

  const ruleFreq = new Map<string, number>();
  for (const entry of Object.values(gold.labeled)) {
    for (const r of entry.relevantRules) ruleFreq.set(r, (ruleFreq.get(r) ?? 0) + 1);
  }

  for (const session of sessions) {
    if (session.sessionId in gold.labeled) { skipped++; continue; }
    const relevantIds = await config.classifier(session.description, session.transcript, ruleList);
    const validIds = relevantIds.filter((id) => nodeIds.has(id));
    const sessionDomains = inferDomains(session.description + " " + session.transcript.slice(-2000));
    const domainSet = new Set(sessionDomains);
    let domainAligned = validIds.filter((id) => { const node = nodes[id]; return node && node.domains.some((d) => domainSet.has(d)); });
    if (domainAligned.length > config.maxRulesPerSession) {
      domainAligned.sort((a, b) => (ruleFreq.get(a) ?? 0) - (ruleFreq.get(b) ?? 0));
      domainAligned = domainAligned.slice(0, config.maxRulesPerSession);
    }

    const entry: GoldSession = { sessionId: session.sessionId, timestamp: session.timestamp, description: session.description, relevantRules: domainAligned, autoLabeled: true };
    if (domainAligned.length === 0) {
      const fallbackIds = domainFallback(sessionDomains, nodes, ruleFreq, config.maxRulesPerSession);
      if (fallbackIds.length > 0) { entry.relevantRules = fallbackIds; } else { entry.noRules = true; }
    }
    gold.labeled[session.sessionId] = entry;
    labeled++;
  }

  gold.totalLabeled = Object.keys(gold.labeled).length;
  gold.updated = new Date().toISOString();
  return { gold, result: { labeled, skipped, alreadyLabeled } };
}

// ── Synthetic Gold Generation ──

export interface SyntheticConfig {
  maxPerDomain: number;
  totalCap: number;
  coDomainMinShared: number;
  maxLeakageJaccard: number;
  minSessionChars: number;
  generator: (systemPrompt: string, userPrompt: string) => Promise<string | null>;
}

export interface SyntheticResult {
  sessions: GoldSession[];
  filtered: { leakage: number; tooShort: number; generatorFailed: number };
}

function tokenize(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const uni = a.size + b.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

function primaryDomain(n: GraphNode): string { return n.domains?.[0] ?? "unknown"; }

export function selectTargets(nodes: Record<string, GraphNode>, maxPerDomain: number, totalCap: number): GraphNode[] {
  const byDomain = new Map<string, GraphNode[]>();
  for (const n of Object.values(nodes)) {
    const d = primaryDomain(n);
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d)!.push(n);
  }
  const selected: GraphNode[] = [];
  for (const d of [...byDomain.keys()].sort()) {
    const bucket = byDomain.get(d)!;
    bucket.sort((a, b) => (b.severity ?? 0) - (a.severity ?? 0));
    for (const n of bucket.slice(0, maxPerDomain)) selected.push(n);
  }
  return selected.slice(0, totalCap);
}

export function coDomainSiblings(target: GraphNode, allNodes: Record<string, GraphNode>, minShared: number): string[] {
  const tgtSet = new Set(target.domains ?? []);
  if (tgtSet.size === 0) return [];
  const siblings: string[] = [];
  for (const n of Object.values(allNodes)) {
    if (n.id === target.id) continue;
    let shared = 0;
    for (const d of n.domains ?? []) if (tgtSet.has(d)) shared++;
    if (shared >= minShared) siblings.push(n.id);
  }
  return siblings;
}

export function pickDistractors(target: GraphNode, allNodes: Record<string, GraphNode>, count: number): GraphNode[] {
  const tgtDomain = primaryDomain(target);
  const candidates = Object.values(allNodes).filter((n) => n.id !== target.id && primaryDomain(n) !== tgtDomain);
  const k = Math.min(count, candidates.length);
  const arr = candidates.slice();
  for (let i = 0; i < k; i++) { const j = i + Math.floor(Math.random() * (arr.length - i)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr.slice(0, k);
}

export function buildSyntheticPrompts(target: GraphNode, distractors: GraphNode[]): { system: string; user: string } {
  const system = "You are generating evaluation data for a behavioral rule retrieval system.\nOutput ONLY the session description. No explanation, no preamble, no quotes.";
  const distractorLines = distractors.map((d) => `${d.name}: ${d.description}`).join("\n");
  const user = `Target rule:\nName: ${target.name}\nDescription: ${target.description}\n\nDistractor rules (these should NOT apply to your session):\n${distractorLines}\n\nWrite a 1-2 sentence session description for a software engineering or AI assistant session context where:\n1. The TARGET RULE would be clearly applicable\n2. The distractors would NOT apply\n3. Do NOT mention the rule name or copy phrases verbatim from the rule body\n4. Be specific enough that a retrieval system could infer the relevant rule`;
  return { system, user };
}

export async function generateSynthetic(nodes: Record<string, GraphNode>, config: SyntheticConfig): Promise<SyntheticResult> {
  const targets = selectTargets(nodes, config.maxPerDomain, config.totalCap);
  const sessions: GoldSession[] = [];
  const filtered = { leakage: 0, tooShort: 0, generatorFailed: 0 };

  for (const target of targets) {
    const distractors = pickDistractors(target, nodes, 3);
    const { system, user } = buildSyntheticPrompts(target, distractors);
    const sessionText = await config.generator(system, user);
    if (!sessionText) { filtered.generatorFailed++; continue; }
    if (sessionText.length < config.minSessionChars) { filtered.tooShort++; continue; }
    const ruleBag = tokenize(`${target.name} ${target.description}`);
    const sessionBag = tokenize(sessionText);
    if (jaccard(sessionBag, ruleBag) > config.maxLeakageJaccard) { filtered.leakage++; continue; }
    const siblings = coDomainSiblings(target, nodes, config.coDomainMinShared);
    sessions.push({
      sessionId: `synthetic_${String(sessions.length + 1).padStart(3, "0")}`,
      description: sessionText, relevantRules: [target.id, ...siblings],
      domains: target.domains ?? [], targetNode: target.id,
      generationMethod: "distractor_contrast", synthetic: true,
    });
  }
  return { sessions, filtered };
}
