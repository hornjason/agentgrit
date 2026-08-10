import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const TMP_DIR = join(import.meta.dir, ".tmp-health-test");
const BIN = join(import.meta.dir, "../../bin/agentgrit.ts");

const RULE_STATS_PATH = join(
  homedir(), ".claude", "MEMORY", "LEARNING", "STATE", "rule-stats.json",
);

let originalRuleStats: string | null = null;

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(join(TMP_DIR, "state"), { recursive: true });
  mkdirSync(join(TMP_DIR, "signals"), { recursive: true });
  mkdirSync(join(TMP_DIR, "rules"), { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;

  if (existsSync(RULE_STATS_PATH)) {
    const { readFileSync } = require("fs");
    originalRuleStats = readFileSync(RULE_STATS_PATH, "utf-8");
  }
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

function seedConfig(): void {
  writeFileSync(
    join(TMP_DIR, "config.json"),
    JSON.stringify({
      signalDir: join(TMP_DIR, "signals"),
      memoryDir: join(TMP_DIR, "memory"),
      rules: { globalBudget: 20, projectBudget: 20, autoPromote: false },
      rubrics: [],
      daemon: { interval: "30m", weeklyDay: "sunday" },
    }),
  );
}

function seedSessionContext(): void {
  writeFileSync(
    join(TMP_DIR, "state", "session-context.json"),
    JSON.stringify({
      ruleIds: ["rule-a", "rule-b", "rule-c"],
      rules: [
        { id: "rule-a", text: "Test rule A" },
        { id: "rule-b", text: "Test rule B" },
        { id: "rule-c", text: "Test rule C" },
      ],
      domains: ["verification", "delivery", "scoring"],
      domain_source: "bm25",
      timestamp: new Date().toISOString(),
      ttl: 86400000,
      rulesInjectedCount: 15,
      rulesInjectedKB: 3.2,
      totalContextLines: 847,
    }),
  );
}

function seedToolAudit(): void {
  const entries = [
    { toolName: "Read", filePath: "src/graph/context.ts", timestamp: new Date().toISOString() },
    { toolName: "Read", filePath: "src/daemon/doctor.ts", timestamp: new Date().toISOString() },
    { toolName: "Read", filePath: "bin/commands/capture.ts", timestamp: new Date().toISOString() },
    { toolName: "Read", filePath: "src/graph/context.ts", timestamp: new Date().toISOString() },
  ];
  writeFileSync(
    join(TMP_DIR, "signals", "tool-audit.jsonl"),
    entries.map(e => JSON.stringify(e)).join("\n") + "\n",
  );
}

function seedReconciliationReport(): void {
  writeFileSync(
    join(TMP_DIR, "state", "reconciliation-report.json"),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      checks: [
        { name: "budget", status: "pass", detail: "8 rules injected (ceiling: 20)" },
        { name: "telemetry", status: "pass", detail: "Last session: 8 rules, 51 totalContextLines" },
        { name: "roi-floor", status: "pass", detail: "All rules above ROI floor" },
      ],
      overall: "pass",
    }),
  );
}

function seedAllData(): void {
  seedConfig();
  seedSessionContext();
  seedToolAudit();
  seedReconciliationReport();
}

async function runHealth(...extraArgs: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", BIN, "health", ...extraArgs], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AGENTGRIT_DIR: TMP_DIR },
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

describe("health command", () => {
  test("shows all 5 sections with data present", async () => {
    seedAllData();
    const result = await runHealth();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("SESSION");
    expect(result.stdout).toContain("RULE LIFECYCLE");
    expect(result.stdout).toContain("FILES READ");
    expect(result.stdout).toContain("RECONCILIATION");
    expect(result.stdout).toContain("DOCTOR");
  });

  test("SESSION section shows real values", async () => {
    seedAllData();
    const result = await runHealth();
    expect(result.stdout).toContain("Rules injected: 15");
    expect(result.stdout).toContain("3.2 KB");
    expect(result.stdout).toContain("Context lines: 847");
    expect(result.stdout).toContain("verification");
    expect(result.stdout).toContain("bm25");
  });

  test("FILES READ section shows grouped paths", async () => {
    seedAllData();
    const result = await runHealth();
    expect(result.stdout).toContain("src/graph/context.ts");
    expect(result.stdout).toContain("src/daemon/doctor.ts");
    expect(result.stdout).toContain("Total: 3 unique files");
  });

  test("RECONCILIATION section shows check results", async () => {
    seedAllData();
    const result = await runHealth();
    expect(result.stdout).toContain("Overall:");
    expect(result.stdout).toMatch(/[✓⚠✗]/);
  });

  test("DOCTOR section shows counts", async () => {
    seedAllData();
    const result = await runHealth();
    expect(result.stdout).toContain("Errors:");
    expect(result.stdout).toContain("Warnings:");
    expect(result.stdout).toContain("OK:");
  });

  test("--json output has >=5 top-level keys", async () => {
    seedAllData();
    const result = await runHealth("--json");
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    const keys = Object.keys(data);
    expect(keys.length).toBeGreaterThanOrEqual(5);
    expect(keys).toContain("session");
    expect(keys).toContain("ruleLifecycle");
    expect(keys).toContain("filesRead");
    expect(keys).toContain("reconciliation");
    expect(keys).toContain("doctor");
  });

  test("--json session section has real values", async () => {
    seedAllData();
    const result = await runHealth("--json");
    const data = JSON.parse(result.stdout);
    expect(data.session.available).toBe(true);
    expect(data.session.rulesInjected).toBe(15);
    expect(data.session.contextLines).toBe(847);
  });

  test("graceful degradation with missing session-context.json", async () => {
    seedConfig();
    const result = await runHealth();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no session data");
    expect(result.stdout).not.toContain("undefined");
  });

  test("graceful degradation with missing tool-audit.jsonl", async () => {
    seedConfig();
    seedSessionContext();
    const result = await runHealth();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no tool audit data");
  });

  test("graceful degradation with no data files at all", async () => {
    seedConfig();
    const result = await runHealth();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("SESSION");
    expect(result.stdout).toContain("no session data");
    expect(result.stdout).toContain("DOCTOR");
  });

  test("--json graceful degradation marks sections unavailable", async () => {
    seedConfig();
    const result = await runHealth("--json");
    const data = JSON.parse(result.stdout);
    expect(data.session.available).toBe(false);
    expect(data.filesRead.available).toBe(false);
  });

  test("--issue flag accepted without crash", async () => {
    seedAllData();
    const result = await runHealth("--issue", "197");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("FILES READ");
  });

  test("command is read-only — no writes to state files", async () => {
    seedAllData();
    const { statSync } = require("fs");
    const sessionPath = join(TMP_DIR, "state", "session-context.json");
    const mtimeBefore = statSync(sessionPath).mtimeMs;

    await runHealth();

    const mtimeAfter = statSync(sessionPath).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });
});
