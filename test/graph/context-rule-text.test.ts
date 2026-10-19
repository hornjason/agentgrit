import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { getContextRules, resetDetectPatterns, retrieveByEmbeddingSeed } from "../../src/graph/context";
import { buildIndex } from "../../src/graph/bm25";
import { countResolvableRuleIds, resolveRuleText } from "../../src/graph/rule-text";
import type { Graph } from "../../src/graph/types";
import type { GraphNode } from "../../src/adapters/types";

const TMP_DIR = join(import.meta.dir, ".tmp-context-rule-text-test");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
  resetDetectPatterns();
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = process.env.AGENTGRIT_TEST_BASE ?? "";
});

function makeNode(id: string, domains: string[], description: string): GraphNode {
  return {
    id,
    file: `${id}.md`,
    type: "feedback",
    name: `Rule: ${id}`,
    description,
    domains,
    severity: 3,
    occurrence_count: 0,
    last_updated: new Date().toISOString(),
    content_hash: id.slice(0, 8),
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

/**
 * Reproduces the real install: the BM25 corpus (memoryDir) and the graph
 * (rulesDir) are different directories, so some candidates have no graph node.
 *
 * `orphan_*` ids are written as .md files but deliberately left OUT of
 * graph.nodes — without that the regression case below passes vacuously,
 * because every candidate would resolve through the node lookup.
 */
function fixture(): { graph: Graph; index: ReturnType<typeof buildIndex> } {
  const files: string[] = [];

  const write = (id: string, body: string) => {
    const f = join(TMP_DIR, `${id}.md`);
    writeFileSync(f, body, "utf-8");
    files.push(f);
  };

  // In the graph AND in the corpus.
  write(
    "feedback_every_issue_goes_through_ship",
    `---\nname: every-issue-goes-through-ship\ndescription: Every issue goes through the ship workflow\n---\nEvery issue goes through ship with acceptance criteria and evidence.`,
  );

  // In the corpus only — no graph node. Description in frontmatter.
  write(
    "feedback_every_issue_through_ship",
    `---\nname: every-issue-through-ship\ndescription: "Every GitHub issue must go through the ship skill with individual ACs"\n---\nEvery GitHub issue goes through ship with SCOPE then BUILD then VERIFY.`,
  );

  // In the corpus only — no graph node, no frontmatter description: body only.
  write(
    "feedback_quinn_no_config_wipe",
    `Quinn must never wipe the acceptance criteria config while validating a ship run.`,
  );

  // In the corpus only — hyphenated spelling of an underscored graph node.
  write(
    "feedback_smoke-test-insufficient",
    `---\nname: smoke-test-insufficient\ndescription: A smoke test is not acceptance evidence\n---\nA smoke test is not acceptance evidence for a ship run.`,
  );

  const graph = makeGraph([
    makeNode(
      "feedback_every_issue_goes_through_ship",
      ["delivery"],
      "Every issue goes through the ship workflow",
    ),
    makeNode(
      "feedback_smoke_test_insufficient",
      ["testing"],
      "A smoke test is not acceptance evidence",
    ),
  ]);

  return { graph, index: buildIndex(files) };
}

describe("getContextRules rule body text", () => {
  test("no emitted rule has text equal to its id", async () => {
    const { graph, index } = fixture();

    const rules = await getContextRules(
      graph,
      index,
      ["delivery", "testing"],
      10,
      undefined,
      "issue ship acceptance criteria evidence smoke test config",
    );

    expect(rules.length).toBeGreaterThan(0);
    const selfNamed = rules.filter(r => r.text.trim() === r.id);
    expect(selfNamed.map(r => r.id)).toEqual([]);
  });

  test("a candidate missing from the graph is still emitted, with body text from its source document", async () => {
    const { graph, index } = fixture();

    const rules = await getContextRules(
      graph,
      index,
      ["delivery", "testing"],
      10,
      undefined,
      "issue ship acceptance criteria evidence smoke test config",
    );

    // The cheapest wrong fix is to drop every candidate that has no graph
    // node. That hides the defect, so assert the orphan survives.
    const orphan = rules.find(r => r.id === "feedback_every_issue_through_ship");
    expect(orphan).toBeDefined();
    expect(orphan!.text).toContain("Every GitHub issue must go through the ship skill");
  });

  test("falls back to the document body when the source document has no frontmatter description", async () => {
    const { graph, index } = fixture();

    const rules = await getContextRules(
      graph,
      index,
      ["delivery", "testing"],
      10,
      undefined,
      "quinn config wipe acceptance criteria ship",
    );

    const orphan = rules.find(r => r.id === "feedback_quinn_no_config_wipe");
    expect(orphan).toBeDefined();
    expect(orphan!.text).toContain("never wipe the acceptance criteria config");
  });

  test("a candidate spelled with hyphens resolves against the underscored graph node", async () => {
    const { graph, index } = fixture();

    const rules = await getContextRules(
      graph,
      index,
      ["delivery", "testing"],
      10,
      undefined,
      "smoke test acceptance evidence ship run",
    );

    const hit = rules.find(r => r.id === "feedback_smoke-test-insufficient");
    expect(hit).toBeDefined();
    expect(hit!.text).toBe("A smoke test is not acceptance evidence");
    expect(hit!.tags).toEqual(["testing"]);
  });
});

describe("retrieveByEmbeddingSeed rule body text", () => {
  /**
   * The embedding retrieval path is a second producer of context rules and it
   * carried the same fail-open as `getContextRules`: a node whose description
   * and name are both empty fell through to the id as body text. It guards
   * `if (!node) continue`, so only an *empty* node reaches the substitution —
   * which is exactly what this fixture builds.
   */
  test("a node with no description and no name is omitted, not emitted as its own id", () => {
    const blank = makeNode("feedback_blank_node", ["testing"], "");
    blank.name = "";
    const described = makeNode("feedback_described_node", ["testing"], "Describe the rule properly");
    const graph = makeGraph([blank, described]);

    const file = join(TMP_DIR, "unrelated.md");
    writeFileSync(file, "smoke test acceptance evidence ship run", "utf-8");
    const index = buildIndex([file]);

    // Seed BM25 hits "unrelated", whose vector neighbours are the two nodes.
    const vectorCache = new Map<string, number[]>([
      ["unrelated", [1, 0, 0]],
      ["feedback_blank_node", [1, 0, 0]],
      ["feedback_described_node", [0.9, 0.1, 0]],
    ]);

    const rules = retrieveByEmbeddingSeed(
      "smoke test acceptance evidence ship run",
      graph,
      index,
      vectorCache,
      10,
    );

    expect(rules.map(r => r.id)).toContain("feedback_described_node");
    expect(rules.map(r => r.id)).not.toContain("feedback_blank_node");
    expect(rules.filter(r => r.text.trim() === r.id)).toEqual([]);
  });
});

describe("resolveRuleText and the directories it is allowed to read", () => {
  test("a candidate id that climbs out of the memory dir resolves to nothing", () => {
    // memoryDir/rulesDir sit under TMP_DIR; the decoy sits beside them.
    mkdirSync(join(TMP_DIR, "memory"), { recursive: true });
    mkdirSync(join(TMP_DIR, "rules"), { recursive: true });
    writeFileSync(
      join(TMP_DIR, "decoy-outside.md"),
      `---\ndescription: Body text from outside the memory dir\n---\nSecret.`,
      "utf-8",
    );

    // Pre-fix `join(dir, `${id}.md`)` resolved this to TMP_DIR/decoy-outside.md
    // and returned its description.
    expect(resolveRuleText("../decoy-outside", makeGraph([]))).toBeNull();
    expect(resolveRuleText("../../etc/passwd", makeGraph([]))).toBeNull();
  });

  test("an indexed corpus does not re-open the traversal", () => {
    mkdirSync(join(TMP_DIR, "memory"), { recursive: true });
    const decoy = join(TMP_DIR, "decoy-indexed.md");
    writeFileSync(decoy, `---\ndescription: Indexed decoy body\n---\nSecret.`, "utf-8");
    const index = buildIndex([decoy]);
    // The index keys the doc by its basename, so a traversal id never matches
    // it — the only way in was the memoryDir join, which the guard closes.
    expect(index.docs.map(d => d.id)).toEqual(["decoy-indexed"]);
    expect(resolveRuleText("../decoy-indexed", makeGraph([]), index)).toBeNull();
    // The safe spelling still resolves through the index, so the guard has
    // not simply disabled document resolution.
    expect(resolveRuleText("decoy-indexed", makeGraph([]), index)).toBe("Indexed decoy body");
  });
});

describe("countResolvableRuleIds", () => {
  test("counts only the ids that resolve to usable body text", () => {
    const { graph, index } = fixture();
    // Written so the traversal id below has something real to reach — without
    // it that assertion passes whether or not the guard exists.
    mkdirSync(join(TMP_DIR, "memory"), { recursive: true });
    writeFileSync(join(TMP_DIR, "decoy-outside.md"), `---\ndescription: Outside\n---\nSecret.`, "utf-8");

    const ids = [
      "feedback_every_issue_goes_through_ship", // graph node description
      "feedback_every_issue_through_ship", // document frontmatter only
      "feedback_quinn_no_config_wipe", // document body only
      "feedback_never_written_anywhere", // nothing to resolve
      "../decoy-outside", // must not be resolved by reading out of the dir
    ];

    const coverage = countResolvableRuleIds(ids, graph, index);

    expect(coverage.total).toBe(5);
    expect(coverage.resolved).toBe(3);
    expect(coverage.unresolved.sort()).toEqual([
      "../decoy-outside",
      "feedback_never_written_anywhere",
    ]);
  });
});
