import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { baselineCommand } from "../../bin/commands/baseline";
import { writeSessionContext } from "../../src/graph/context";
import type { Rule } from "../../src/adapters/types";
import { Tier } from "../../src/adapters/types";

const TMP_DIR = join(import.meta.dir, ".tmp-baseline-cmd-test");

function makeRule(id: string): Rule {
  return {
    id,
    text: `Rule text for ${id}`,
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

describe("baseline capture", () => {
  test("creates valid snapshot file from session history", async () => {
    const sigDir = join(TMP_DIR, "signals");
    mkdirSync(sigDir, { recursive: true });

    writeSessionContext([makeRule("r1"), makeRule("r2")], ["deployment"]);
    writeSessionContext([makeRule("r3")], ["verification"]);

    writeFileSync(join(sigDir, "ratings.jsonl"), "");
    writeFileSync(join(sigDir, "corrections.jsonl"), "");

    await baselineCommand(["capture"]);

    const snapshotPath = join(TMP_DIR, "state", "baseline-snapshot.json");
    expect(existsSync(snapshotPath)).toBe(true);

    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf-8"));
    expect(snapshot.capturedAt).toBeTruthy();
    expect(snapshot.sessions).toHaveLength(2);
    expect(snapshot.sessions[0].rulesCount).toBe(2);
    expect(snapshot.sessions[1].rulesCount).toBe(1);
    expect(snapshot.averages.rulesCount).toBe(1.5);
  });

  test("cross-references ratings by session_id", async () => {
    const sigDir = join(TMP_DIR, "signals");
    mkdirSync(sigDir, { recursive: true });

    writeSessionContext([makeRule("r1")], ["deployment"]);

    const historyPath = join(TMP_DIR, "state", "session-context-history.jsonl");
    const historyLine = readFileSync(historyPath, "utf-8").trim();
    const sessionData = JSON.parse(historyLine);
    const sessionId = sessionData.timestamp.replace(/[:.]/g, "-").slice(0, 19);

    writeFileSync(
      join(sigDir, "ratings.jsonl"),
      JSON.stringify({ session_id: sessionId, rating: 8, timestamp: new Date().toISOString() }) + "\n",
    );
    writeFileSync(join(sigDir, "corrections.jsonl"), "");

    await baselineCommand(["capture"]);

    const snapshot = JSON.parse(readFileSync(join(TMP_DIR, "state", "baseline-snapshot.json"), "utf-8"));
    expect(snapshot.sessions[0].rating).toBe(8);
  });

  test("handles missing signals gracefully", async () => {
    writeSessionContext([makeRule("r1")], ["deployment"]);

    await baselineCommand(["capture"]);

    const snapshotPath = join(TMP_DIR, "state", "baseline-snapshot.json");
    expect(existsSync(snapshotPath)).toBe(true);

    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf-8"));
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0].corrections).toBe(0);
    expect(snapshot.sessions[0].rating).toBe(0);
  });
});

describe("baseline show", () => {
  test("prints formatted table when snapshot exists", async () => {
    const stateDir = join(TMP_DIR, "state");
    mkdirSync(stateDir, { recursive: true });

    const snapshot = {
      capturedAt: new Date().toISOString(),
      sessions: [
        { id: "2026-07-01T10-00", rulesCount: 100, rulesKB: 40.2, corrections: 2, rating: 7, iterationCount: 5 },
      ],
      averages: { rulesCount: 100, rulesKB: 40.2, corrections: 2, rating: 7 },
    };
    writeFileSync(join(stateDir, "baseline-snapshot.json"), JSON.stringify(snapshot, null, 2));

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    await baselineCommand(["show"]);

    console.log = origLog;

    const output = logs.join("\n");
    expect(output).toContain("Baseline Snapshot");
    expect(output).toContain("2026-07-01T10-00");
    expect(output).toContain("AVERAGES");
    expect(output).toContain("100");
    expect(output).toContain("40.2");
  });

  test("prints message when no snapshot exists", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    await baselineCommand(["show"]);

    console.log = origLog;
    expect(logs.join("\n")).toContain("No baseline snapshot found");
  });
});

describe("baseline help", () => {
  test("prints usage when no subcommand given", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    await baselineCommand([]);

    console.log = origLog;
    expect(logs.join("\n")).toContain("Usage:");
  });
});
