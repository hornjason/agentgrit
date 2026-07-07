import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  writeSessionContext,
  readSessionContext,
  readSessionHistory,
  type SessionContext,
} from "../../src/graph/context";
import type { Rule } from "../../src/adapters/types";
import { Tier } from "../../src/adapters/types";

const TMP_DIR = join(import.meta.dir, ".tmp-baseline-test");

function makeRule(id: string): Rule {
  return {
    id,
    text: `Rule text for ${id} — a longer description to contribute to KB size`,
    tier: Tier.Graph,
    tags: ["deployment"],
    created: new Date().toISOString(),
    correlationScore: 0.8,
    sourceSignals: [],
    schemaVersion: 1,
  };
}

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

describe("writeSessionContext — rulesInjectedCount and rulesInjectedKB", () => {
  test("includes rulesInjectedCount matching rules.length", () => {
    const rules = [makeRule("r1"), makeRule("r2"), makeRule("r3")];
    writeSessionContext(rules, ["deployment"]);

    const filePath = join(TMP_DIR, "state", "session-context.json");
    const data = JSON.parse(readFileSync(filePath, "utf-8")) as SessionContext;
    expect(data.rulesInjectedCount).toBe(3);
  });

  test("includes rulesInjectedKB as JSON size / 1024 with 1 decimal", () => {
    const rules = [makeRule("r1"), makeRule("r2")];
    writeSessionContext(rules, ["verification"]);

    const filePath = join(TMP_DIR, "state", "session-context.json");
    const data = JSON.parse(readFileSync(filePath, "utf-8")) as SessionContext;
    const expectedKB = Math.round((JSON.stringify(rules).length / 1024) * 10) / 10;
    expect(data.rulesInjectedKB).toBe(expectedKB);
  });

  test("zero rules produces count=0, KB=0", () => {
    writeSessionContext([], []);

    const filePath = join(TMP_DIR, "state", "session-context.json");
    const data = JSON.parse(readFileSync(filePath, "utf-8")) as SessionContext;
    expect(data.rulesInjectedCount).toBe(0);
    expect(data.rulesInjectedKB).toBe(0);
  });

  test("appends to session-context-history.jsonl", () => {
    writeSessionContext([makeRule("r1")], ["deployment"]);
    writeSessionContext([makeRule("r2"), makeRule("r3")], ["verification"]);

    const historyPath = join(TMP_DIR, "state", "session-context-history.jsonl");
    expect(existsSync(historyPath)).toBe(true);
    const lines = readFileSync(historyPath, "utf-8").split("\n").filter((l) => l.trim());
    expect(lines.length).toBe(2);

    const first = JSON.parse(lines[0]) as SessionContext;
    expect(first.rulesInjectedCount).toBe(1);
    const second = JSON.parse(lines[1]) as SessionContext;
    expect(second.rulesInjectedCount).toBe(2);
  });
});

describe("readSessionContext — returns new fields", () => {
  test("returns rulesInjectedCount and rulesInjectedKB from current context", () => {
    const rules = [makeRule("a"), makeRule("b")];
    writeSessionContext(rules, ["deployment"]);

    const result = readSessionContext();
    expect(result).not.toBeNull();
    expect(result!.rulesInjectedCount).toBe(2);
    expect(typeof result!.rulesInjectedKB).toBe("number");
    expect(result!.rulesInjectedKB).toBeGreaterThan(0);
  });

  test("handles legacy context missing new fields gracefully", () => {
    const stateDir = join(TMP_DIR, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "session-context.json"), JSON.stringify({
      ruleIds: ["r1"],
      domains: ["scope"],
      timestamp: new Date().toISOString(),
      ttl: 24 * 60 * 60 * 1000,
    }));
    const result = readSessionContext();
    expect(result).not.toBeNull();
    expect(result!.rulesInjectedCount).toBeUndefined();
  });
});

describe("readSessionHistory", () => {
  test("returns empty array when no history file exists", () => {
    const result = readSessionHistory();
    expect(result).toEqual([]);
  });

  test("returns last N entries from history", () => {
    for (let i = 0; i < 15; i++) {
      writeSessionContext([makeRule(`r${i}`)], ["deployment"]);
    }
    const last10 = readSessionHistory(10);
    expect(last10.length).toBe(10);
    expect(last10[9].rulesInjectedCount).toBe(1);
  });

  test("returns all entries when fewer than limit", () => {
    writeSessionContext([makeRule("r1")], ["deployment"]);
    writeSessionContext([makeRule("r2")], ["verification"]);
    const all = readSessionHistory(10);
    expect(all.length).toBe(2);
  });

  test("skips malformed lines", () => {
    const stateDir = join(TMP_DIR, "state");
    mkdirSync(stateDir, { recursive: true });
    const historyPath = join(stateDir, "session-context-history.jsonl");
    writeFileSync(historyPath, '{"rulesInjectedCount":5}\nnot-json\n{"rulesInjectedCount":3}\n');
    const result = readSessionHistory(10);
    expect(result.length).toBe(2);
  });
});
