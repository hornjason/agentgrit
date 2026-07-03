import { describe, expect, test } from "bun:test";
import { autoLabel, buildRuleList, buildSyntheticPrompts, coDomainSiblings, domainFallback, generateSynthetic, inferDomains, pickDistractors, selectTargets, type GoldSet } from "../../src/evaluate/gold";
import type { GraphNode } from "../../src/adapters/types";

function makeNode(id: string, domains: string[], severity = 5): GraphNode {
  return { id, file: `${id}.md`, type: "rule", name: `Rule ${id}`, description: `Description for ${id}`, domains, severity, occurrence_count: 1, last_updated: new Date().toISOString(), content_hash: "abc", memoryType: "rule" };
}

describe("inferDomains", () => {
  test("detects deployment domain", () => { expect(inferDomains("rebuilt the container and deployed via docker")).toContain("deployment"); });
  test("detects verification domain", () => { expect(inferDomains("the assertion was incorrect and wrong")).toContain("verification"); });
  test("returns fallback when no pattern matches", () => { expect(inferDomains("hello world")).toEqual(["verification", "delivery"]); });
  test("accepts custom fallback", () => { expect(inferDomains("hello world", ["custom"])).toEqual(["custom"]); });
  test("deduplicates domains", () => { const d = inferDomains("verify check assert wrong incorrect"); expect(d.length).toBe(new Set(d).size); });
});

describe("domainFallback", () => {
  test("returns matching node IDs", () => {
    const nodes: Record<string, GraphNode> = { r1: makeNode("r1", ["testing"]), r2: makeNode("r2", ["deployment"]), r3: makeNode("r3", ["testing"]) };
    const r = domainFallback(["testing"], nodes);
    expect(r).toContain("r1"); expect(r).toContain("r3"); expect(r).not.toContain("r2");
  });
  test("caps at maxRules with frequency sorting", () => {
    const nodes: Record<string, GraphNode> = {};
    for (let i = 0; i < 30; i++) nodes[`r${i}`] = makeNode(`r${i}`, ["testing"]);
    const freq = new Map<string, number>(); freq.set("r0", 100);
    const r = domainFallback(["testing"], nodes, freq, 5);
    expect(r.length).toBe(5); expect(r).not.toContain("r0");
  });
});

describe("buildRuleList", () => {
  test("produces formatted rule list", () => {
    const list = buildRuleList({ r1: makeNode("r1", ["testing"]) });
    expect(list).toContain("r1"); expect(list).toContain("Rule r1");
  });
});

describe("autoLabel", () => {
  test("labels sessions not in gold set", async () => {
    const nodes: Record<string, GraphNode> = { r1: makeNode("r1", ["verification"]), r2: makeNode("r2", ["deployment"]) };
    const sessions = [{ sessionId: "s1", timestamp: "2026-01-01T00:00:00Z", description: "verified assertions were correct", transcript: "checking that assertions work correctly" }];
    const { gold, result } = await autoLabel(sessions, nodes, { labeled: {}, totalLabeled: 0, updated: "" }, { maxRulesPerSession: 25, classifier: async () => ["r1"] });
    expect(result.labeled).toBe(1); expect(result.skipped).toBe(0);
    expect(gold.labeled["s1"]).toBeDefined(); expect(gold.labeled["s1"].autoLabeled).toBe(true); expect(gold.totalLabeled).toBe(1);
  });
  test("skips sessions already in gold set", async () => {
    const nodes: Record<string, GraphNode> = { r1: makeNode("r1", ["verification"]) };
    const existingGold: GoldSet = { labeled: { s1: { sessionId: "s1", description: "existing", relevantRules: ["r1"], autoLabeled: true } }, totalLabeled: 1, updated: "2026-01-01" };
    const { result } = await autoLabel([{ sessionId: "s1", timestamp: "2026-01-01T00:00:00Z", description: "test", transcript: "test" }], nodes, existingGold, { maxRulesPerSession: 25, classifier: async () => ["r1"] });
    expect(result.skipped).toBe(1); expect(result.labeled).toBe(0);
  });
  test("uses domain fallback when classifier returns empty", async () => {
    const nodes: Record<string, GraphNode> = { r1: makeNode("r1", ["verification"]) };
    const sessions = [{ sessionId: "s1", timestamp: "2026-01-01T00:00:00Z", description: "checking verify assertion", transcript: "verification workflow" }];
    const { gold } = await autoLabel(sessions, nodes, { labeled: {}, totalLabeled: 0, updated: "" }, { maxRulesPerSession: 25, classifier: async () => [] });
    expect(gold.labeled["s1"]).toBeDefined(); expect(gold.labeled["s1"].relevantRules.length).toBeGreaterThan(0);
  });
});

describe("selectTargets", () => {
  test("groups by domain and caps total", () => {
    const nodes: Record<string, GraphNode> = {};
    for (let i = 0; i < 10; i++) { nodes[`a${i}`] = makeNode(`a${i}`, ["domainA"], 10 - i); nodes[`b${i}`] = makeNode(`b${i}`, ["domainB"], 10 - i); }
    expect(selectTargets(nodes, 3, 5).length).toBe(5);
  });
  test("selects by descending severity", () => {
    const nodes: Record<string, GraphNode> = { low: makeNode("low", ["testing"], 1), high: makeNode("high", ["testing"], 10), mid: makeNode("mid", ["testing"], 5) };
    const targets = selectTargets(nodes, 2, 10);
    expect(targets[0].id).toBe("high"); expect(targets[1].id).toBe("mid");
  });
});

describe("coDomainSiblings", () => {
  test("finds nodes sharing enough domains", () => {
    const target = makeNode("target", ["a", "b", "c"]);
    const nodes: Record<string, GraphNode> = { target, sibling: makeNode("sibling", ["a", "b"]), distant: makeNode("distant", ["a"]), unrelated: makeNode("unrelated", ["x", "y"]) };
    const siblings = coDomainSiblings(target, nodes, 2);
    expect(siblings).toContain("sibling"); expect(siblings).not.toContain("distant"); expect(siblings).not.toContain("target");
  });
});

describe("pickDistractors", () => {
  test("returns nodes from different primary domain", () => {
    const target = makeNode("target", ["domainA"]);
    const nodes: Record<string, GraphNode> = { target, same: makeNode("same", ["domainA"]), diff1: makeNode("diff1", ["domainB"]), diff2: makeNode("diff2", ["domainC"]) };
    const d = pickDistractors(target, nodes, 2);
    expect(d.length).toBe(2);
    for (const x of d) expect(x.domains[0]).not.toBe("domainA");
  });
});

describe("buildSyntheticPrompts", () => {
  test("produces system and user prompts", () => {
    const { system, user } = buildSyntheticPrompts(makeNode("target", ["testing"]), [makeNode("d1", ["deployment"])]);
    expect(system).toContain("evaluation data"); expect(user).toContain("Target rule:"); expect(user).toContain("Distractor rules");
  });
});

describe("generateSynthetic", () => {
  test("generates sessions from nodes", async () => {
    const nodes: Record<string, GraphNode> = { r1: makeNode("r1", ["a", "b"], 10), r2: makeNode("r2", ["c"], 5) };
    const r = await generateSynthetic(nodes, { maxPerDomain: 4, totalCap: 50, coDomainMinShared: 2, maxLeakageJaccard: 0.20, minSessionChars: 10, generator: async () => "A moderately long session description about working on something" });
    expect(r.sessions.length).toBeGreaterThan(0); expect(r.sessions[0].synthetic).toBe(true); expect(r.sessions[0].generationMethod).toBe("distractor_contrast");
  });
  test("filters too-short sessions", async () => {
    const nodes: Record<string, GraphNode> = { r1: makeNode("r1", ["a"]), r2: makeNode("r2", ["b"]) };
    const r = await generateSynthetic(nodes, { maxPerDomain: 4, totalCap: 50, coDomainMinShared: 2, maxLeakageJaccard: 0.20, minSessionChars: 1000, generator: async () => "short" });
    expect(r.sessions.length).toBe(0); expect(r.filtered.tooShort).toBeGreaterThan(0);
  });
  test("handles generator failures", async () => {
    const nodes: Record<string, GraphNode> = { r1: makeNode("r1", ["a"]), r2: makeNode("r2", ["b"]) };
    const r = await generateSynthetic(nodes, { maxPerDomain: 4, totalCap: 50, coDomainMinShared: 2, maxLeakageJaccard: 0.20, minSessionChars: 10, generator: async () => null });
    expect(r.sessions.length).toBe(0); expect(r.filtered.generatorFailed).toBeGreaterThan(0);
  });
});
