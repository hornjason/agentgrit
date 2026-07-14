import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, ".tmp-import-test");
const EXPORT_FILE = join(TEST_DIR, "backup.json");

function makeExport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "0.1.0",
    exportedAt: new Date().toISOString(),
    graph: {
      nodes: [{ id: "n1", name: "test-rule", type: "rule" }],
      edges: [{ from: "n1", to: "n1", relationship: "sibling", strength: 0.5 }],
    },
    rubrics: {
      "starter.json": { version: "1.0", dimensions: [{ name: "accuracy", weight: 1 }] },
      "custom.json": { version: "1.0", dimensions: [{ name: "tone", weight: 0.5 }] },
    },
    config: {
      adapter: "local",
      rules: { globalBudget: 15, projectBudget: 10, autoPromote: false },
      daemon: { interval: "30m", weeklyDay: "sunday" },
    },
    promotions: [
      { id: "p1", ruleId: "r1", tier: "global", timestamp: "2026-01-01T00:00:00Z", approved: true },
      { id: "p2", ruleId: "r2", tier: "project", timestamp: "2026-01-02T00:00:00Z", approved: false },
    ],
    recallEval: { precision: 0.85, recall: 0.72, timestamp: "2026-01-01T00:00:00Z" },
    ...overrides,
  };
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TEST_DIR;
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

describe("init --import", () => {
  test("restores graph, rubrics, config, promotions, recallEval", async () => {
    writeFileSync(EXPORT_FILE, JSON.stringify(makeExport()));
    const { importInit } = await import("../../bin/commands/init");
    const result = await importInit(EXPORT_FILE);

    expect(result.graph).toBe(true);
    expect(result.rubrics).toEqual(["starter.json", "custom.json"]);
    expect(result.config).toBe(true);
    expect(result.promotions).toBe(2);
    expect(result.recallEval).toBe(true);

    const graph = JSON.parse(readFileSync(join(TEST_DIR, "state", "knowledge-graph.json"), "utf-8"));
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(1);

    const rubric = JSON.parse(readFileSync(join(TEST_DIR, "rubrics", "custom.json"), "utf-8"));
    expect(rubric.dimensions[0].name).toBe("tone");

    const ledger = readFileSync(join(TEST_DIR, "state", "promotions.jsonl"), "utf-8").trim().split("\n");
    expect(ledger).toHaveLength(2);
    expect(JSON.parse(ledger[0]).id).toBe("p1");

    const recall = JSON.parse(readFileSync(join(TEST_DIR, "state", "recall-eval.json"), "utf-8"));
    expect(recall.precision).toBe(0.85);
  });

  test("merges config preserving local paths", async () => {
    mkdirSync(join(TEST_DIR, "state"), { recursive: true });
    mkdirSync(join(TEST_DIR, "rubrics"), { recursive: true });
    mkdirSync(join(TEST_DIR, "signals"), { recursive: true });

    const localConfig = {
      signalDir: "/my/local/signals",
      memoryDir: "/my/local/memory",
      transcriptDir: "/my/local/transcripts",
      langfuse: { publicKey: "pk", secretKey: "sk", baseUrl: "http://localhost" },
      adapter: "local",
      rules: { globalBudget: 5, autoPromote: false },
      daemon: { interval: "0" },
    };
    writeFileSync(join(TEST_DIR, "config.json"), JSON.stringify(localConfig));

    const exportData = makeExport({
      config: {
        adapter: "both",
        signalDir: "/other/signals",
        memoryDir: "/other/memory",
        rules: { globalBudget: 20, autoPromote: true },
        daemon: { interval: "30m", weeklyDay: "sunday" },
      },
    });
    writeFileSync(EXPORT_FILE, JSON.stringify(exportData));

    const { importInit } = await import("../../bin/commands/init");
    await importInit(EXPORT_FILE);

    const merged = JSON.parse(readFileSync(join(TEST_DIR, "config.json"), "utf-8"));
    expect(merged.signalDir).toBe("/my/local/signals");
    expect(merged.memoryDir).toBe("/my/local/memory");
    expect(merged.transcriptDir).toBe("/my/local/transcripts");
    expect(merged.langfuse.publicKey).toBe("pk");
    expect(merged.adapter).toBe("both");
    expect(merged.rules.globalBudget).toBe(20);
    expect(merged.daemon.interval).toBe("30m");
  });

  test("handles partial export (graph only)", async () => {
    writeFileSync(EXPORT_FILE, JSON.stringify({
      version: "0.1.0",
      exportedAt: new Date().toISOString(),
      graph: { nodes: [{ id: "n1" }], edges: [] },
    }));

    const { importInit } = await import("../../bin/commands/init");
    const result = await importInit(EXPORT_FILE);

    expect(result.graph).toBe(true);
    expect(result.rubrics).toEqual([]);
    expect(result.config).toBe(false);
    expect(result.promotions).toBe(0);
    expect(result.recallEval).toBe(false);
  });

  test("round-trip: export → import produces identical data", async () => {
    mkdirSync(join(TEST_DIR, "state"), { recursive: true });
    mkdirSync(join(TEST_DIR, "rubrics"), { recursive: true });
    mkdirSync(join(TEST_DIR, "signals"), { recursive: true });

    const graphData = {
      nodes: [{ id: "r1", name: "rule-1", type: "rule" }],
      edges: [{ from: "r1", to: "r1", relationship: "sibling", strength: 1 }],
    };
    writeFileSync(join(TEST_DIR, "state", "knowledge-graph.json"), JSON.stringify(graphData));

    const rubricData = { version: "1.0", dimensions: [{ name: "accuracy", weight: 1 }] };
    writeFileSync(join(TEST_DIR, "rubrics", "starter.json"), JSON.stringify(rubricData));

    const configData = {
      signalDir: TEST_DIR,
      adapter: "local",
      rules: { globalBudget: 15, autoPromote: false },
      daemon: { interval: "0", weeklyDay: "sunday" },
    };
    writeFileSync(join(TEST_DIR, "config.json"), JSON.stringify(configData));

    const { exportCommand } = await import("../../bin/commands/export");
    const exportPath = join(TEST_DIR, "exported.json");
    await exportCommand([exportPath]);

    const IMPORT_DIR = join(import.meta.dir, ".tmp-import-roundtrip");
    if (existsSync(IMPORT_DIR)) rmSync(IMPORT_DIR, { recursive: true });
    mkdirSync(IMPORT_DIR, { recursive: true });

    process.env.AGENTGRIT_DIR = IMPORT_DIR;

    try {
      const { importInit } = await import("../../bin/commands/init");
      await importInit(exportPath);

      const importedGraph = JSON.parse(readFileSync(join(IMPORT_DIR, "state", "knowledge-graph.json"), "utf-8"));
      expect(importedGraph.nodes).toEqual(graphData.nodes);
      expect(importedGraph.edges).toEqual(graphData.edges);

      const importedRubric = JSON.parse(readFileSync(join(IMPORT_DIR, "rubrics", "starter.json"), "utf-8"));
      expect(importedRubric).toEqual(rubricData);
    } finally {
      if (existsSync(IMPORT_DIR)) rmSync(IMPORT_DIR, { recursive: true });
      process.env.AGENTGRIT_DIR = TEST_DIR;
    }
  });
});
