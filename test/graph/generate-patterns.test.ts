import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import type { Graph } from "../../src/graph/types";
import type { GraphNode } from "../../src/adapters/types";
import { DOMAINS } from "../../src/graph/builder";
import {
  generatePatterns,
  loadSeedPatterns,
  loadCachedPatterns,
  writeCachedPatterns,
  loadPatterns,
  loadHybridPatterns,
} from "../../src/graph/generate-patterns";
import type { DomainPattern } from "../../src/graph/generate-patterns";

const STOP_WORDS = new Set([
  "the", "it", "is", "are", "no", "go", "an", "in", "on", "at", "to", "of",
  "or", "if", "so", "as", "by", "up", "we", "do", "be", "he", "me", "my",
  "us", "am", "has", "had", "was", "but", "not", "all", "can", "her", "his",
  "our", "its", "who", "how", "may", "did", "get", "let", "say", "see",
  "use", "way", "own", "set", "run", "put", "old", "new", "try", "ask",
  "end", "far", "low", "big", "few", "got", "out", "any", "two", "one",
  "day", "off", "man", "too", "yet", "now", "ago", "nor", "per", "via", "non",
]);

const TMP_DIR = join(import.meta.dir, ".tmp-patterns-test");

function makeNode(id: string, domains: string[], description: string): GraphNode {
  return {
    id,
    file: `${id}.md`,
    type: "rule",
    name: id,
    description,
    domains,
    severity: 3,
    occurrence_count: 0,
    last_updated: new Date().toISOString(),
    content_hash: "abc",
    memoryType: "behavioral-rule",
  };
}

function makeGraph(nodes: GraphNode[]): Graph {
  const nodeMap: Record<string, GraphNode> = {};
  for (const n of nodes) nodeMap[n.id] = n;
  return {
    version: "1.0",
    builtAt: new Date().toISOString(),
    nodeCount: nodes.length,
    edgeCount: 0,
    nodes: nodeMap,
    edges: [],
  };
}

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(join(TMP_DIR, "state"), { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

describe("loadSeedPatterns", () => {
  test("returns all 14 domain patterns", () => {
    const seeds = loadSeedPatterns();
    expect(seeds.length).toBe(14);
    const domains = seeds.map(s => s.domain);
    for (const d of DOMAINS) {
      expect(domains).toContain(d);
    }
  });

  test("each pattern has required fields", () => {
    const seeds = loadSeedPatterns();
    for (const s of seeds) {
      expect(typeof s.domain).toBe("string");
      expect(Array.isArray(s.terms)).toBe(true);
      expect(s.terms.length).toBeGreaterThan(0);
      expect(typeof s.pattern).toBe("string");
      expect(typeof s.priority).toBe("number");
    }
  });

  test("deployment has negativePattern and cascadePattern", () => {
    const seeds = loadSeedPatterns();
    const deployment = seeds.find(s => s.domain === "deployment");
    expect(deployment).toBeDefined();
    expect(deployment!.negativePattern).toBeDefined();
    expect(deployment!.negativePattern).toContain("before assert");
    expect(deployment!.cascadePattern).toBeDefined();
    expect(deployment!.cascadePattern).toContain("deploy sequence");
  });

  test("patterns are valid regex source strings", () => {
    const seeds = loadSeedPatterns();
    for (const s of seeds) {
      expect(() => new RegExp(s.pattern, "i")).not.toThrow();
      if (s.cascadePattern) {
        expect(() => new RegExp(s.cascadePattern, "i")).not.toThrow();
      }
      if (s.negativePattern) {
        expect(() => new RegExp(s.negativePattern, "i")).not.toThrow();
      }
    }
  });

  test("patterns are sorted by priority", () => {
    const seeds = loadSeedPatterns();
    for (let i = 1; i < seeds.length; i++) {
      expect(seeds[i].priority).toBeGreaterThanOrEqual(seeds[i - 1].priority);
    }
  });
});

describe("cached patterns", () => {
  test("loadCachedPatterns returns null when no cache exists", () => {
    expect(loadCachedPatterns()).toBeNull();
  });

  test("writeCachedPatterns creates valid cache file", () => {
    const patterns: DomainPattern[] = [{
      domain: "deployment",
      terms: ["deploy", "rebuild"],
      pattern: "deploy|rebuild",
      priority: 1,
    }];
    const path = writeCachedPatterns(patterns);
    expect(existsSync(path)).toBe(true);

    const data = JSON.parse(readFileSync(path, "utf-8"));
    expect(data.generatedAt).toBeDefined();
    expect(data.patterns).toEqual(patterns);
  });

  test("loadCachedPatterns reads written cache", () => {
    const patterns: DomainPattern[] = [{
      domain: "security",
      terms: ["auth", "credential"],
      pattern: "auth|credential",
      priority: 4,
    }];
    writeCachedPatterns(patterns);
    const loaded = loadCachedPatterns();
    expect(loaded).toEqual(patterns);
  });

  test("loadCachedPatterns returns null for invalid JSON", () => {
    const path = join(TMP_DIR, "state", "domain-patterns.json");
    writeFileSync(path, "not valid json{{{", "utf-8");
    expect(loadCachedPatterns()).toBeNull();
  });

  test("loadCachedPatterns returns null for malformed data", () => {
    const path = join(TMP_DIR, "state", "domain-patterns.json");
    writeFileSync(path, JSON.stringify({ generatedAt: "now" }), "utf-8");
    expect(loadCachedPatterns()).toBeNull();
  });
});

describe("loadPatterns", () => {
  test("returns cached patterns when available", () => {
    const patterns: DomainPattern[] = [{
      domain: "test-domain",
      terms: ["test"],
      pattern: "test",
      priority: 1,
    }];
    writeCachedPatterns(patterns);
    const loaded = loadPatterns();
    expect(loaded).toEqual(patterns);
  });

  test("falls back to seed patterns when no cache", () => {
    const loaded = loadPatterns();
    expect(loaded.length).toBe(14);
  });
});

describe("generatePatterns", () => {
  test("returns seed patterns for empty graph", () => {
    const graph = makeGraph([]);
    const patterns = generatePatterns(graph);
    expect(patterns.length).toBe(14);
    const domains = patterns.map(p => p.domain);
    for (const d of DOMAINS) {
      expect(domains).toContain(d);
    }
  });

  test("returns seed patterns for sparse domains (< 3 rules)", () => {
    const graph = makeGraph([
      makeNode("r1", ["deployment"], "deploy container rebuild"),
      makeNode("r2", ["deployment"], "makefile docker build"),
    ]);
    const patterns = generatePatterns(graph);
    const deployment = patterns.find(p => p.domain === "deployment");
    expect(deployment).toBeDefined();
    expect(deployment!.pattern).toContain("makefile");
  });

  test("generates BM25-based patterns for domains with >= 3 rules", () => {
    const graph = makeGraph([
      makeNode("sec1", ["security"], "run security scan on all changed files"),
      makeNode("sec2", ["security"], "security review for vulnerability assessment"),
      makeNode("sec3", ["security"], "security gate blocks merge without scan results"),
      makeNode("sec4", ["security"], "credential rotation and secret management"),
      makeNode("other1", ["scope"], "stay focused on minimal scope"),
    ]);
    const patterns = generatePatterns(graph);
    const security = patterns.find(p => p.domain === "security");
    expect(security).toBeDefined();
    expect(security!.terms.length).toBeGreaterThan(0);
    expect(security!.pattern.length).toBeGreaterThan(0);
  });

  test("preserves deployment negativePattern", () => {
    const nodes: GraphNode[] = [];
    for (let i = 0; i < 5; i++) {
      nodes.push(makeNode(`deploy_${i}`, ["deployment"], `deploy rebuild container docker makefile rule ${i}`));
    }
    const graph = makeGraph(nodes);
    const patterns = generatePatterns(graph);
    const deployment = patterns.find(p => p.domain === "deployment");
    expect(deployment).toBeDefined();
    expect(deployment!.negativePattern).toContain("before assert");
  });

  test("patterns are sorted by priority", () => {
    const graph = makeGraph([]);
    const patterns = generatePatterns(graph);
    for (let i = 1; i < patterns.length; i++) {
      expect(patterns[i].priority).toBeGreaterThanOrEqual(patterns[i - 1].priority);
    }
  });

  test("output covers all 14 domains from DOMAINS constant", () => {
    const graph = makeGraph([]);
    const patterns = generatePatterns(graph);
    const domainSet = new Set(patterns.map(p => p.domain));
    expect(domainSet.size).toBe(14);
    for (const d of DOMAINS) {
      expect(domainSet.has(d)).toBe(true);
    }
  });

  test("generated patterns produce valid RegExp objects", () => {
    const nodes: GraphNode[] = [];
    for (const d of DOMAINS) {
      for (let i = 0; i < 4; i++) {
        nodes.push(makeNode(`${d}_${i}`, [d], `${d} related content for rule ${i} with terms`));
      }
    }
    const graph = makeGraph(nodes);
    const patterns = generatePatterns(graph);
    for (const p of patterns) {
      expect(() => new RegExp(p.pattern, "i")).not.toThrow();
    }
  });

  test("minRulesPerDomain threshold is respected", () => {
    const graph = makeGraph([
      makeNode("sec1", ["security"], "security scan vulnerability"),
      makeNode("sec2", ["security"], "security gate review"),
    ]);
    const patternsDefault = generatePatterns(graph, 3);
    const secDefault = patternsDefault.find(p => p.domain === "security");
    expect(secDefault!.pattern).toContain("security scan");

    const patternsLow = generatePatterns(graph, 2);
    const secLow = patternsLow.find(p => p.domain === "security");
    expect(secLow!.terms.length).toBeGreaterThan(0);
  });
});

describe("stop word filter", () => {
  test("generated terms contain no stop words", () => {
    const nodes: GraphNode[] = [];
    for (const d of DOMAINS) {
      for (let i = 0; i < 5; i++) {
        nodes.push(makeNode(`${d}_${i}`, [d], `${d} related content for the rule ${i} with terms and is not in`));
      }
    }
    const graph = makeGraph(nodes);
    const patterns = generatePatterns(graph);
    for (const p of patterns) {
      for (const term of p.terms) {
        const words = term.split(" ");
        for (const w of words) {
          expect(STOP_WORDS.has(w)).toBe(false);
        }
      }
    }
  });

  test("generated terms have minimum length 3", () => {
    const nodes: GraphNode[] = [];
    for (const d of DOMAINS) {
      for (let i = 0; i < 5; i++) {
        nodes.push(makeNode(`${d}_${i}`, [d], `${d} ab cd ef gh rule ${i}`));
      }
    }
    const graph = makeGraph(nodes);
    const patterns = generatePatterns(graph);
    for (const p of patterns) {
      for (const term of p.terms) {
        if (!term.includes(" ")) {
          expect(term.length).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });
});

describe("bigram extraction", () => {
  test("generated terms include multi-word bigrams", () => {
    const graph = makeGraph([
      makeNode("sec1", ["security"], "run security scan on all changed files"),
      makeNode("sec2", ["security"], "security review for vulnerability assessment"),
      makeNode("sec3", ["security"], "security gate blocks merge without scan results"),
      makeNode("sec4", ["security"], "credential rotation and secret management"),
    ]);
    const patterns = generatePatterns(graph);
    const security = patterns.find(p => p.domain === "security");
    expect(security).toBeDefined();
    const bigrams = security!.terms.filter(t => t.includes(" "));
    expect(bigrams.length).toBeGreaterThan(0);
  });

  test("bigrams matching seed terms get boosted", () => {
    const graph = makeGraph([
      makeNode("sec1", ["security"], "run security scan on changed files"),
      makeNode("sec2", ["security"], "security scan for vulnerability assessment review"),
      makeNode("sec3", ["security"], "security scan blocks merge without results"),
      makeNode("sec4", ["security"], "credential rotation secret management token secret"),
    ]);
    const patterns = generatePatterns(graph);
    const security = patterns.find(p => p.domain === "security");
    expect(security).toBeDefined();
    const seeds = loadSeedPatterns();
    const seedSec = seeds.find(s => s.domain === "security");
    const seedTermSet = new Set(seedSec!.terms.map(t => t.toLowerCase()));
    const matchingSeedBigrams = security!.terms.filter(
      t => t.includes(" ") && seedTermSet.has(t),
    );
    expect(matchingSeedBigrams.length).toBeGreaterThan(0);
  });
});

describe("cascadePattern generation", () => {
  test("all 14 domains get cascadePattern when enough nodes exist", () => {
    const descs: Record<string, string> = {
      deployment: "deploy rebuild container docker makefile production server",
      security: "security scan vulnerability credential auth token secret",
      "ui-testing": "quinn playwright visual test screenshot validation",
      browser: "iframe page.fill page.route selector sso login scraper",
      delegation: "spawn agent worktree pre-brief handoff delegate marcus",
      escalation: "escalate bring specialist wrong approach stuck diagnos",
      algorithm: "prd isc algorithm phase effort level criteria",
      memory: "feedback_.md memory.md ratings.jsonl learning capture",
      scope: "minimal scope unrequested features stay focused only asked",
      delivery: "false completion partial deliver self audit incomplete",
      communication: "response format output format terse response trailing",
      data: "actual data live data measure before real numbers",
      architecture: "refactor abstract interface module boundary coupling cohesion",
      verification: "verify check before read answer look source first",
    };
    const nodes: GraphNode[] = [];
    for (const d of DOMAINS) {
      for (let i = 0; i < 5; i++) {
        nodes.push(makeNode(`${d}_${i}`, [d], descs[d] || `${d} content rule ${i}`));
      }
    }
    const graph = makeGraph(nodes);
    const patterns = generatePatterns(graph);
    let cascadeCount = 0;
    for (const p of patterns) {
      if (p.cascadePattern) cascadeCount++;
    }
    expect(cascadeCount).toBe(14);
  });

  test("cascadePattern contains word-boundary markers for unigrams", () => {
    const graph = makeGraph([
      makeNode("sec1", ["security"], "security scan vulnerability credential"),
      makeNode("sec2", ["security"], "security review auth token"),
      makeNode("sec3", ["security"], "security gate blocks merge"),
      makeNode("sec4", ["security"], "credential rotation secret management"),
    ]);
    const patterns = generatePatterns(graph);
    const security = patterns.find(p => p.domain === "security");
    expect(security).toBeDefined();
    expect(security!.cascadePattern).toBeDefined();
    expect(security!.cascadePattern).toMatch(/\\b/);
  });

  test("cascadePattern produces valid RegExp", () => {
    const nodes: GraphNode[] = [];
    for (const d of DOMAINS) {
      for (let i = 0; i < 5; i++) {
        nodes.push(makeNode(`${d}_${i}`, [d], `${d} related content rule ${i} specific terms`));
      }
    }
    const graph = makeGraph(nodes);
    const patterns = generatePatterns(graph);
    for (const p of patterns) {
      if (p.cascadePattern) {
        expect(() => new RegExp(p.cascadePattern!, "i")).not.toThrow();
      }
    }
  });
});

describe("regression: seed vs generated pattern agreement", () => {
  const REGRESSION_CORPUS: Array<{ input: string; expectedDomains: string[]; source: string }> = [
    // From builder.test.ts keywordClassify
    { input: "deploy-gate build sequence run make rebuild", expectedDomains: ["deployment"], source: "keywordClassify" },
    { input: "sec-check gate run security scan before deploy", expectedDomains: ["security"], source: "keywordClassify" },
    { input: "scope-guard minimal scope, don't add unrequested features", expectedDomains: ["scope"], source: "keywordClassify" },
    { input: "delivery-check avoid false completions, self audit before claiming done", expectedDomains: ["delivery"], source: "keywordClassify" },
    { input: "auth-gate validate auth token before accessing resources", expectedDomains: ["security"], source: "keywordClassify" },
    { input: "cred-check never store credential in plain text", expectedDomains: ["security"], source: "keywordClassify" },
    { input: "secret-mgmt rotate secret key every 90 days", expectedDomains: ["security"], source: "keywordClassify" },
    { input: "access enforce access control on all endpoints", expectedDomains: ["security"], source: "keywordClassify" },
    { input: "encryption encrypt sensitive data at rest", expectedDomains: ["security"], source: "keywordClassify" },
    { input: "refactor-rule refactor the module to reduce coupling", expectedDomains: ["architecture"], source: "keywordClassify" },
    { input: "design use abstract interface for module boundary", expectedDomains: ["architecture"], source: "keywordClassify" },
    { input: "deep-mod prefer deep module design with cohesion", expectedDomains: ["architecture"], source: "keywordClassify" },
    { input: "arch-decision record architecture decision in ADR", expectedDomains: ["architecture"], source: "keywordClassify" },
    // From context.test.ts detectDomains
    { input: "run make rebuild to deploy", expectedDomains: ["deployment"], source: "detectDomains" },
    { input: "verify before answering", expectedDomains: ["verification"], source: "detectDomains" },
    { input: "run security scan on vulnerability", expectedDomains: ["security"], source: "detectDomains" },
    { input: "stay focused on minimal scope", expectedDomains: ["scope"], source: "detectDomains" },
    { input: "spawn agent with worktree isolation", expectedDomains: ["delegation"], source: "detectDomains" },
    { input: "run playwright visual test", expectedDomains: ["ui-testing"], source: "detectDomains" },
  ];

  function classifyWithPatterns(text: string, patterns: DomainPattern[]): string[] {
    const lower = text.toLowerCase();
    const domains: string[] = [];
    for (const p of patterns) {
      const re = new RegExp(p.pattern, "i");
      if (re.test(lower)) domains.push(p.domain);
    }
    return domains;
  }

  test("generated patterns agree with seeds on >= 95% of test corpus", () => {
    const descs: Record<string, string> = {
      deployment: "deploy rebuild container docker makefile production server",
      security: "security scan vulnerability credential auth token secret encrypt access control",
      "ui-testing": "quinn playwright visual test screenshot validation",
      browser: "iframe page.fill page.route selector sso login scraper",
      delegation: "spawn agent worktree pre-brief handoff delegate marcus",
      escalation: "escalate bring specialist wrong approach stuck diagnos",
      algorithm: "prd isc algorithm phase effort level criteria",
      memory: "feedback_.md memory.md ratings.jsonl learning capture",
      scope: "minimal scope unrequested features stay focused only asked",
      delivery: "false completion partial deliver self audit incomplete done ship",
      communication: "response format output format terse response trailing",
      data: "actual data live data measure before real numbers",
      architecture: "refactor abstract interface module boundary coupling cohesion deep module architecture decision",
      verification: "verify check before read answer look source first",
    };
    const nodes: GraphNode[] = [];
    for (const d of DOMAINS) {
      for (let i = 0; i < 5; i++) {
        nodes.push(makeNode(`${d}_${i}`, [d], descs[d] || `${d} content rule ${i}`));
      }
    }
    const graph = makeGraph(nodes);
    const generated = generatePatterns(graph);
    const seeds = loadSeedPatterns();

    let agreed = 0;
    let total = 0;
    const mismatches: string[] = [];

    for (const { input, expectedDomains, source } of REGRESSION_CORPUS) {
      const seedResult = classifyWithPatterns(input, seeds);
      const genResult = classifyWithPatterns(input, generated);

      for (const expected of expectedDomains) {
        total++;
        const seedHas = seedResult.includes(expected);
        const genHas = genResult.includes(expected);
        if (seedHas === genHas) {
          agreed++;
        } else {
          mismatches.push(`[${source}] "${input.slice(0, 50)}": expected=${expected} seed=${seedHas} gen=${genHas}`);
        }
      }
    }

    const rate = total > 0 ? agreed / total : 0;
    console.log(`Regression agreement: ${agreed}/${total} (${(rate * 100).toFixed(1)}%)`);
    if (mismatches.length > 0) {
      console.log("Mismatches:");
      for (const m of mismatches) console.log(`  ${m}`);
    }

    expect(rate).toBeGreaterThanOrEqual(0.95);
  });
});

describe("loadHybridPatterns", () => {
  test("returns all 14 domains", () => {
    const graph = makeGraph([]);
    const hybrid = loadHybridPatterns(graph);
    expect(hybrid.length).toBe(14);
    for (const d of DOMAINS) {
      expect(hybrid.find(p => p.domain === d)).toBeDefined();
    }
  });

  test("preserves seed pattern and cascadePattern", () => {
    const graph = makeGraph([]);
    const hybrid = loadHybridPatterns(graph);
    const seeds = loadSeedPatterns();
    for (const seed of seeds) {
      const h = hybrid.find(p => p.domain === seed.domain);
      expect(h).toBeDefined();
      expect(h!.pattern).toBe(seed.pattern);
      expect(h!.cascadePattern).toBe(seed.cascadePattern);
      expect(h!.negativePattern).toBe(seed.negativePattern);
    }
  });

  test("augmentedTerms is undefined for empty graph", () => {
    const graph = makeGraph([]);
    const hybrid = loadHybridPatterns(graph);
    for (const p of hybrid) {
      expect(p.augmentedTerms).toBeUndefined();
    }
  });

  test("populates augmentedTerms when graph has enough nodes", () => {
    const nodes: GraphNode[] = [];
    for (let i = 0; i < 5; i++) {
      nodes.push(makeNode(`sec_${i}`, ["security"], `security scan vulnerability credential rotation assessment review audit ${i}`));
    }
    const graph = makeGraph(nodes);
    const hybrid = loadHybridPatterns(graph);
    const security = hybrid.find(p => p.domain === "security");
    expect(security).toBeDefined();
    expect(security!.augmentedTerms).toBeDefined();
    expect(security!.augmentedTerms!.length).toBeGreaterThan(0);
  });

  test("augmentedTerms excludes seed terms", () => {
    const nodes: GraphNode[] = [];
    for (let i = 0; i < 5; i++) {
      nodes.push(makeNode(`sec_${i}`, ["security"], `security scan vulnerability credential rotation assessment review audit ${i}`));
    }
    const graph = makeGraph(nodes);
    const hybrid = loadHybridPatterns(graph);
    const security = hybrid.find(p => p.domain === "security");
    const seeds = loadSeedPatterns();
    const seedSec = seeds.find(s => s.domain === "security")!;
    const seedTermLower = new Set(seedSec.terms.map(t => t.toLowerCase()));
    for (const t of security!.augmentedTerms ?? []) {
      expect(seedTermLower.has(t.toLowerCase())).toBe(false);
    }
  });

  test("sorted by priority", () => {
    const graph = makeGraph([]);
    const hybrid = loadHybridPatterns(graph);
    for (let i = 1; i < hybrid.length; i++) {
      expect(hybrid[i].priority).toBeGreaterThanOrEqual(hybrid[i - 1].priority);
    }
  });
});
