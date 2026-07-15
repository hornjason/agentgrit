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
} from "../../src/graph/generate-patterns";
import type { DomainPattern } from "../../src/graph/generate-patterns";

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
