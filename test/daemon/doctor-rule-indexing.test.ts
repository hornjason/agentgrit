/**
 * #258 — 44 of 47 promoted rule files were missing from the knowledge graph
 * because the graph was only ever built from the memory directory. doctor's
 * cross-reference check compares the graph against BOTH directories, so it is
 * the check that has to read zero once the builder indexes both.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { AgentGritConfig } from "../../src/adapters/types";
import { runDoctor } from "../../src/daemon/doctor";
import { buildGraph, resetClassifyPatterns } from "../../src/graph/builder";

const TEST_DIR = "/tmp/agentgrit-doctor-rule-indexing-" + process.pid;
const SIGNAL_DIR = join(TEST_DIR, "signals");
const STATE_DIR = join(TEST_DIR, "state");
const RULES_DIR = join(TEST_DIR, "rules");
const MEMORY_DIR = join(TEST_DIR, "memory");

function makeConfig(): AgentGritConfig {
  return {
    signalDir: SIGNAL_DIR,
    memoryDir: MEMORY_DIR,
    adapter: "local",
    rubrics: [],
    rules: { globalBudget: 25, projectBudget: 25, autoPromote: false },
    daemon: { interval: "30m", weeklyDay: "sunday" },
  } as AgentGritConfig;
}

function writeMd(dir: string, id: string, description: string, body: string): void {
  writeFileSync(
    join(dir, `${id}.md`),
    `---\nname: ${id}\ndescription: ${description}\n---\n${body}\n`,
    "utf-8",
  );
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(SIGNAL_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(RULES_DIR, { recursive: true });
  mkdirSync(MEMORY_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TEST_DIR;
  resetClassifyPatterns();
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = process.env.AGENTGRIT_TEST_BASE ?? "";
});

describe("doctor cross-reference after a graph build", () => {
  test("reports zero rule files absent from the graph", async () => {
    writeMd(MEMORY_DIR, "feedback_memory_one", "deploy sequence", "Run make rebuild before deploying.");
    writeMd(RULES_DIR, "feedback_promoted_one", "Stay focused", "Keep minimal scope, don't add unrequested features.");
    writeMd(RULES_DIR, "feedback_promoted_two", "gate", "Run a security scan before deploy.");

    await buildGraph(MEMORY_DIR, STATE_DIR);

    const report = await runDoctor(makeConfig());
    const integrity = report.sections.find((s) => s.name === "INTEGRITY")!;
    const unindexed = integrity.checks.find((c) => c.name === "unindexed-rules");

    expect(unindexed).toBeUndefined();
    expect(integrity.checks.some((c) => c.name === "graph-rules-sync")).toBe(true);
  });

  test("ignores MEMORY and README files the builder deliberately skips", async () => {
    writeMd(MEMORY_DIR, "feedback_memory_one", "deploy sequence", "Run make rebuild before deploying.");
    writeMd(RULES_DIR, "feedback_promoted_one", "Stay focused", "Keep minimal scope, don't add unrequested features.");
    writeFileSync(join(RULES_DIR, "README.md"), "# Rules\n", "utf-8");
    writeFileSync(join(MEMORY_DIR, "MEMORY.md"), "# Memory index\n", "utf-8");

    await buildGraph(MEMORY_DIR, STATE_DIR);

    const report = await runDoctor(makeConfig());
    const integrity = report.sections.find((s) => s.name === "INTEGRITY")!;

    expect(integrity.checks.find((c) => c.name === "unindexed-rules")).toBeUndefined();
    expect(integrity.checks.find((c) => c.name === "orphaned-nodes")).toBeUndefined();
  });
});
