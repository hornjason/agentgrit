import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { getContextRules, resetDetectPatterns, retrieveByEmbeddingSeed } from "../../src/graph/context";
import { buildIndex } from "../../src/graph/bm25";
import { readRuleTextFromDocument, resolveRuleText } from "../../src/graph/rule-text";
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

/**
 * `getContextRules` is not the only path in context.ts that builds a Rule.
 * `retrieveByEmbeddingSeed` builds its own, and had the same
 * `description || name || id` fallback — a node present in the graph but
 * carrying no text still rendered as `- **id:** id`.
 */
describe("retrieveByEmbeddingSeed rule body text", () => {
  function seedFixture() {
    const files: string[] = [];
    const write = (id: string, body: string) => {
      const f = join(TMP_DIR, `${id}.md`);
      writeFileSync(f, body, "utf-8");
      files.push(f);
    };

    write(
      "feedback_rebuild_before_deploy",
      `---\ndescription: Rebuild the container before deploying\n---\nRebuild the container before deploying to production.`,
    );

    const textless = makeNode("feedback_textless_node", ["delivery"], "");
    textless.name = "";

    const graph = makeGraph([
      makeNode("feedback_rebuild_before_deploy", ["delivery"], "Rebuild the container before deploying"),
      textless,
    ]);

    const vectorCache = new Map<string, number[]>([
      ["feedback_rebuild_before_deploy", [1, 0, 0]],
      ["feedback_textless_node", [0.99, 0.1, 0]],
    ]);

    return { graph, index: buildIndex(files), vectorCache };
  }

  test("a graph node with no description and no name is omitted, not rendered as its own id", () => {
    const { graph, index, vectorCache } = seedFixture();

    const rules = retrieveByEmbeddingSeed(
      "rebuild the container before deploying to production",
      graph,
      index,
      vectorCache,
      10,
    );

    // Without a resolving candidate this passes vacuously on an empty array.
    expect(rules.map(r => r.id)).toContain("feedback_rebuild_before_deploy");
    expect(rules.map(r => r.id)).not.toContain("feedback_textless_node");
    expect(rules.filter(r => r.text.trim() === r.id)).toEqual([]);
  });
});

/**
 * `resolveRuleText` is exported and takes an id from the registry, the graph
 * or a BM25 doc — none of which it minted. Reading `join(memoryDir, id +
 * ".md")` for an unvalidated id lets `../` walk out of the corpus.
 */
describe("document reads are confined to the corpus directories", () => {
  const emptyGraph = (): Graph => makeGraph([]);

  function plantSecretOutsideCorpus(): string {
    mkdirSync(join(TMP_DIR, "memory"), { recursive: true });
    mkdirSync(join(TMP_DIR, "rules"), { recursive: true });
    const secret = join(TMP_DIR, "secret.md");
    writeFileSync(
      secret,
      `---\ndescription: SECRET outside the corpus\n---\nSECRET outside the corpus.`,
      "utf-8",
    );
    return secret;
  }

  test("a traversal id does not read a file outside the memory and rules dirs", () => {
    const secretPath = plantSecretOutsideCorpus();

    // Without this the assertion below passes vacuously: the escape target
    // has to be reachable by the join the resolver performs.
    expect(existsSync(secretPath)).toBe(true);
    expect(existsSync(join(TMP_DIR, "memory", "../secret.md"))).toBe(true);

    expect(readRuleTextFromDocument("../secret")).toBeNull();
    expect(resolveRuleText("../secret", emptyGraph())).toBeNull();
  });

  test("a nested traversal id does not read outside either", () => {
    const secretPath = plantSecretOutsideCorpus();
    expect(existsSync(secretPath)).toBe(true);

    expect(readRuleTextFromDocument("rules/../../secret")).toBeNull();
    expect(readRuleTextFromDocument(join(TMP_DIR, "secret"))).toBeNull();
  });

  test("a traversal id is rejected before any corpus path is built", () => {
    plantSecretOutsideCorpus();
    // An index entry is keyed by doc id, so it cannot be reached by a
    // traversal id — but the id must be refused even with one present.
    const index = buildIndex([join(TMP_DIR, "memory")].filter(() => false));
    expect(readRuleTextFromDocument("../secret", index)).toBeNull();
    expect(readRuleTextFromDocument("..", index)).toBeNull();
  });

  test("the sentence-shaped ids the registry actually holds still resolve", () => {
    const memory = join(TMP_DIR, "memory");
    mkdirSync(memory, { recursive: true });
    const id = "Brief and dashboard must render consistently (from debrief 2026-06-11)";
    writeFileSync(
      join(memory, `${id}.md`),
      `---\ndescription: The brief and the dashboard must render the same data\n---\nBody.`,
      "utf-8",
    );

    // The guard must reject traversal without rejecting spaces, parens or
    // dots in a legitimate id — 586 of the 623 registry ids look like this.
    expect(readRuleTextFromDocument(id)).toBe(
      "The brief and the dashboard must render the same data",
    );
  });
});
