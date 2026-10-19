/**
 * Retrieval floor — getContextRules must return a usable number of rules (#258).
 *
 * The live failure this guards: `~/.agentgrit/context/GRAPH-CONTEXT.md` froze on
 * "no context rules found for domains: delegation, communication, scope, memory,
 * pai-system, token-efficiency". The graph held rules, the index held the rule
 * files, and retrieval still handed back two entries — every candidate came from
 * the handful of nodes whose `domains` literally overlapped the query, and an
 * ordinary task description ("migrate invoice schema") shares no vocabulary with
 * the corpus so BM25 contributed nothing.
 *
 * Measured against the pre-fix code with the fixture below: 2 rules for the
 * domain-only path, 2-3 for an ordinary task description. The floor is what
 * takes those to five, and it is correlation-ranked — the two query texts in
 * "ranked, not padded" produce different lists.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { buildGraph } from "../../src/graph/builder";
import { buildIndexFromDir } from "../../src/graph/bm25";
import { getContextRules, MIN_CONTEXT_RULES } from "../../src/graph/context";
import type { Graph } from "../../src/graph/types";
import type { BM25Index } from "../../src/graph/types";

const TMP_DIR = join(import.meta.dir, ".tmp-context-domain-lookup");
const RULES_DIR = join(TMP_DIR, "rules");
const STATE_DIR = join(TMP_DIR, "state");
const RULE_DOMAINS = join(TMP_DIR, "rule-domains.json");

/**
 * A rules directory shaped like a real one: every file is a learned rule, and
 * only two of them carry a domain the session asks for. That ratio is the point
 * — it is what #258 looked like on disk.
 */
const RULE_FIXTURES: Array<{ id: string; domains: string[]; body: string }> = [
  { id: "feedback_rebuild_before_readback", domains: ["memory"], body: "Rebuild the knowledge store before reading it back so stale nodes do not leak into a session." },
  { id: "feedback_backfill_must_persist", domains: ["data"], body: "A backfill must persist to disk; an in-memory rebuild that never writes is a silent no-op." },
  { id: "feedback_red_before_green", domains: ["testing"], body: "Write the failing regression test first and watch it go red before writing the implementation." },
  { id: "feedback_commit_each_working_change", domains: ["delivery"], body: "Commit after every working change; uncommitted work is lost work." },
  { id: "feedback_verify_before_asserting", domains: ["scope"], body: "Verify before asserting — read the source and report what actually happened." },
  { id: "feedback_read_checkpoint_first", domains: ["process"], body: "Read the checkpoint before spawning helpers so finished work is not duplicated." },
  { id: "feedback_no_silent_catch", domains: ["security"], body: "Never swallow an error in a catch that reports success; a fail-open guard is a guard bypass." },
  { id: "feedback_screenshot_the_change", domains: ["ui"], body: "Look at the rendered change, not only the measurements, before calling it done." },
  { id: "feedback_pin_the_tool_version", domains: ["infra"], body: "Pin the tool version before using a flag that only a newer release supports." },
  { id: "feedback_escalate_after_two_tries", domains: ["escalation"], body: "Escalate after two failed attempts instead of spinning on the same approach." },
  { id: "feedback_document_the_decision", domains: ["architecture"], body: "Record the structural decision in a durable document in the same session it is made." },
  { id: "feedback_one_change_per_commit", domains: ["delivery"], body: "Keep a commit to one coherent change so a revert stays surgical." },
];

/** The domain set #258 reported as returning nothing. */
const SESSION_DOMAINS = ["memory", "data", "delegation", "pai-system"];

let graph: Graph;
let index: BM25Index;

beforeAll(async () => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(RULES_DIR, { recursive: true });

  const rules: Record<string, { domains: string[]; source: string }> = {};
  for (const fixture of RULE_FIXTURES) {
    writeFileSync(
      join(RULES_DIR, `${fixture.id}.md`),
      `---\ntype: learned\nseverity: 3\n---\n\n# ${fixture.id}\n\n${fixture.body}\n`,
      "utf-8",
    );
    rules[fixture.id] = { domains: fixture.domains, source: "fixture" };
  }
  writeFileSync(RULE_DOMAINS, JSON.stringify({ version: 1, reviewed: true, rules }, null, 2), "utf-8");

  graph = await buildGraph(RULES_DIR, STATE_DIR, RULE_DOMAINS);
  index = buildIndexFromDir(RULES_DIR);
});

afterAll(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

describe("getContextRules retrieval floor", () => {
  test("fixture really is the #258 shape — few nodes carry a queried domain", () => {
    expect(graph.nodeCount).toBe(RULE_FIXTURES.length);
    const domainMatched = Object.values(graph.nodes).filter(n =>
      n.domains.some(d => SESSION_DOMAINS.includes(d)),
    );
    // Two. Everything above five has to come from the floor, not from domain overlap.
    expect(domainMatched.length).toBeLessThan(MIN_CONTEXT_RULES);
  });

  test("domain-only lookup returns at least five rules", async () => {
    const rules = await getContextRules(graph, index, SESSION_DOMAINS, 10);
    expect(rules.length).toBeGreaterThanOrEqual(MIN_CONTEXT_RULES);
  });

  test("ordinary task description returns at least five rules", async () => {
    for (const task of ["migrate invoice schema", "fix flaky pagination", "update graph retrieval"]) {
      const rules = await getContextRules(graph, index, SESSION_DOMAINS, 10, undefined, task);
      // Name the task in the failure message — three cases share one assertion.
      expect([task, rules.length >= MIN_CONTEXT_RULES]).toEqual([task, true]);
    }
  });

  test("floor is ranked, not padded — different queries give different lists", async () => {
    const a = await getContextRules(graph, index, SESSION_DOMAINS, 10, undefined, "bump dependency, tag release");
    const b = await getContextRules(graph, index, SESSION_DOMAINS, 10, undefined, "measure rendered page");

    expect(a.length).toBeGreaterThanOrEqual(MIN_CONTEXT_RULES);
    expect(b.length).toBeGreaterThanOrEqual(MIN_CONTEXT_RULES);
    expect(a.map(r => r.id)).not.toEqual(b.map(r => r.id));

    // Each query's own best lexical match outranks it in the other list.
    const rankIn = (rules: Array<{ id: string }>, id: string) => rules.findIndex(r => r.id === id);
    expect(rankIn(a, "feedback_pin_the_tool_version")).toBeLessThan(rankIn(b, "feedback_pin_the_tool_version"));
    expect(rankIn(b, "feedback_screenshot_the_change")).toBeLessThan(rankIn(a, "feedback_screenshot_the_change"));
  });

  test("floored results stay score-ordered and stay inside the corpus", async () => {
    const rules = await getContextRules(graph, index, SESSION_DOMAINS, 10, undefined, "migrate invoice schema");
    const corpus = new Set(RULE_FIXTURES.map(f => f.id));

    for (const rule of rules) {
      expect(corpus.has(rule.id)).toBe(true);
      expect(rule.text.length).toBeGreaterThan(0);
    }
    const scores = rules.map(r => r.correlationScore ?? 0);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
    expect(new Set(rules.map(r => r.id)).size).toBe(rules.length);
  });

  test("floor never invents rules — an empty corpus still returns nothing", async () => {
    const emptyGraph: Graph = {
      version: "1.0",
      builtAt: new Date().toISOString(),
      nodeCount: 0,
      edgeCount: 0,
      nodes: {},
      edges: [],
    };
    const emptyIndex = buildIndexFromDir(join(TMP_DIR, "does-not-exist"));
    const rules = await getContextRules(emptyGraph, emptyIndex, SESSION_DOMAINS, 10, undefined, "anything at all");
    expect(rules).toEqual([]);
  });

  test("floor respects the caller's limit when it is below the floor", async () => {
    const rules = await getContextRules(graph, index, SESSION_DOMAINS, 3, undefined, "migrate invoice schema");
    expect(rules.length).toBe(3);
  });
});
