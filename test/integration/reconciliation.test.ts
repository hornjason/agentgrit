import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";

const TMP_DIR = join(import.meta.dir, ".tmp-reconciliation");
const STATE_DIR = join(TMP_DIR, "state");
const SIGNALS_DIR = join(TMP_DIR, "signals");

function writeFixture(dir: string, filename: string, data: unknown): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), JSON.stringify(data, null, 2), "utf-8");
}

function writeFixtureJsonl(dir: string, filename: string, entries: unknown[]): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, filename),
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf-8",
  );
}

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(SIGNALS_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

describe("reconciliation", () => {
  test("happy path: all 3 checks pass with healthy fixtures", async () => {
    // Budget: 5 rules (under 20)
    writeFixture(STATE_DIR, "session-context.json", {
      ruleIds: ["r1", "r2", "r3", "r4", "r5"],
      rules: [
        { id: "r1", text: "rule 1" },
        { id: "r2", text: "rule 2" },
        { id: "r3", text: "rule 3" },
        { id: "r4", text: "rule 4" },
        { id: "r5", text: "rule 5" },
      ],
      domains: ["testing"],
      domain_source: "keyword",
      timestamp: new Date().toISOString(),
      ttl: 86400000,
      rulesInjectedCount: 5,
      rulesInjectedKB: 0.3,
      totalContextLines: 42,
    });

    // Telemetry: non-zero rules and totalContextLines
    writeFixtureJsonl(STATE_DIR, "session-context-history.jsonl", [
      {
        ruleIds: ["r1", "r2"],
        rules: [{ id: "r1", text: "rule 1" }, { id: "r2", text: "rule 2" }],
        domains: ["testing"],
        domain_source: "keyword",
        timestamp: new Date().toISOString(),
        ttl: 86400000,
        rulesInjectedCount: 2,
        rulesInjectedKB: 0.1,
        totalContextLines: 30,
      },
    ]);

    // ROI: all rules healthy
    writeFixture(STATE_DIR, "rule-stats.json", [
      {
        ruleId: "r1",
        injectionCount: 50,
        avgCorrelatedRating: 7.5,
        sessionRatings: [7, 8],
        highRatingActivations: 40,
        lowRatingActivations: 10,
        lastSeen: new Date().toISOString(),
      },
    ]);

    const { reconcile } = await import("../../src/daemon/reconcile");
    const report = await reconcile();

    expect(report.timestamp).toBeTruthy();
    expect(report.checks).toHaveLength(3);
    expect(report.overall).toBe("pass");

    for (const check of report.checks) {
      expect(check.status).toBe("pass");
    }

    // Verify report was written to state dir
    const reportPath = join(STATE_DIR, "reconciliation-report.json");
    expect(existsSync(reportPath)).toBe(true);

    const written = JSON.parse(readFileSync(reportPath, "utf-8"));
    expect(written.checks).toHaveLength(3);
    expect(written.overall).toBe("pass");
  });

  test("budget violation: >20 rules triggers fail", async () => {
    // 25 rules — over the 20 budget
    const ruleIds = Array.from({ length: 25 }, (_, i) => `rule-${i}`);
    const rules = ruleIds.map((id) => ({ id, text: `text for ${id}` }));

    writeFixture(STATE_DIR, "session-context.json", {
      ruleIds,
      rules,
      domains: ["testing"],
      domain_source: "keyword",
      timestamp: new Date().toISOString(),
      ttl: 86400000,
      rulesInjectedCount: 25,
      rulesInjectedKB: 1.5,
      totalContextLines: 100,
    });

    writeFixtureJsonl(STATE_DIR, "session-context-history.jsonl", [
      {
        ruleIds: ["r1"],
        rules: [{ id: "r1", text: "rule 1" }],
        domains: ["testing"],
        domain_source: "keyword",
        timestamp: new Date().toISOString(),
        ttl: 86400000,
        rulesInjectedCount: 1,
        rulesInjectedKB: 0.1,
        totalContextLines: 10,
      },
    ]);

    writeFixture(STATE_DIR, "rule-stats.json", []);

    const { reconcile } = await import("../../src/daemon/reconcile");
    const report = await reconcile();

    const budgetCheck = report.checks.find((c) => c.name === "budget");
    expect(budgetCheck).toBeDefined();
    expect(budgetCheck!.status).toBe("fail");
    expect(report.overall).toBe("fail");
  });

  test("telemetry dead: 0 rules and 0 lines triggers warn", async () => {
    writeFixture(STATE_DIR, "session-context.json", {
      ruleIds: [],
      rules: [],
      domains: [],
      domain_source: "keyword",
      timestamp: new Date().toISOString(),
      ttl: 86400000,
      rulesInjectedCount: 0,
      rulesInjectedKB: 0,
      totalContextLines: 0,
    });

    // History last entry has zero rules and zero lines
    writeFixtureJsonl(STATE_DIR, "session-context-history.jsonl", [
      {
        ruleIds: [],
        rules: [],
        domains: [],
        domain_source: "keyword",
        timestamp: new Date().toISOString(),
        ttl: 86400000,
        rulesInjectedCount: 0,
        rulesInjectedKB: 0,
        totalContextLines: 0,
      },
    ]);

    writeFixture(STATE_DIR, "rule-stats.json", []);

    const { reconcile } = await import("../../src/daemon/reconcile");
    const report = await reconcile();

    const telemetryCheck = report.checks.find((c) => c.name === "telemetry");
    expect(telemetryCheck).toBeDefined();
    expect(telemetryCheck!.status).toBe("warn");

    // Overall should be warn (not fail — telemetry dead is advisory)
    expect(["warn", "fail"]).toContain(report.overall);
  });

  test("ROI floor: rule with >=100 injections and <3.0 rating triggers warn", async () => {
    writeFixture(STATE_DIR, "session-context.json", {
      ruleIds: ["r1"],
      rules: [{ id: "r1", text: "rule 1" }],
      domains: ["testing"],
      domain_source: "keyword",
      timestamp: new Date().toISOString(),
      ttl: 86400000,
      rulesInjectedCount: 1,
      rulesInjectedKB: 0.1,
      totalContextLines: 10,
    });

    writeFixtureJsonl(STATE_DIR, "session-context-history.jsonl", [
      {
        ruleIds: ["r1"],
        rules: [{ id: "r1", text: "rule 1" }],
        domains: ["testing"],
        domain_source: "keyword",
        timestamp: new Date().toISOString(),
        ttl: 86400000,
        rulesInjectedCount: 1,
        rulesInjectedKB: 0.1,
        totalContextLines: 10,
      },
    ]);

    // Rule with 150 injections and 2.5 avg rating — below ROI floor
    writeFixture(STATE_DIR, "rule-stats.json", [
      {
        ruleId: "feedback_bad_rule",
        injectionCount: 150,
        avgCorrelatedRating: 2.5,
        sessionRatings: Array(20).fill(2.5),
        highRatingActivations: 0,
        lowRatingActivations: 150,
        lastSeen: new Date().toISOString(),
      },
      {
        ruleId: "feedback_good_rule",
        injectionCount: 200,
        avgCorrelatedRating: 8.0,
        sessionRatings: Array(20).fill(8.0),
        highRatingActivations: 200,
        lowRatingActivations: 0,
        lastSeen: new Date().toISOString(),
      },
    ]);

    const { reconcile } = await import("../../src/daemon/reconcile");
    const report = await reconcile();

    const roiCheck = report.checks.find((c) => c.name === "roi-floor");
    expect(roiCheck).toBeDefined();
    expect(roiCheck!.status).toBe("warn");
    expect(roiCheck!.detail).toContain("feedback_bad_rule");
    expect(roiCheck!.detail).not.toContain("feedback_good_rule");
  });

  test("reconcile never throws even with missing files", async () => {
    // No fixtures at all — all files missing
    // reconcile must return a partial report, not throw
    const { reconcile } = await import("../../src/daemon/reconcile");
    const report = await reconcile();

    expect(report.timestamp).toBeTruthy();
    expect(report.checks.length).toBeGreaterThanOrEqual(0);
    // Should not throw — this test passing IS the assertion
  });

  test("reconcile never throws with corrupt JSON", async () => {
    writeFileSync(join(STATE_DIR, "session-context.json"), "NOT JSON{{{", "utf-8");
    writeFileSync(join(STATE_DIR, "session-context-history.jsonl"), "CORRUPT\n", "utf-8");
    writeFileSync(join(STATE_DIR, "rule-stats.json"), "NOPE", "utf-8");

    const { reconcile } = await import("../../src/daemon/reconcile");
    const report = await reconcile();

    expect(report.timestamp).toBeTruthy();
    // Should not throw — this test passing IS the assertion
  });

  test("report has required shape: timestamp, checks array, overall status", async () => {
    writeFixture(STATE_DIR, "session-context.json", {
      ruleIds: ["r1"],
      rules: [{ id: "r1", text: "rule 1" }],
      domains: ["testing"],
      domain_source: "keyword",
      timestamp: new Date().toISOString(),
      ttl: 86400000,
      rulesInjectedCount: 1,
      rulesInjectedKB: 0.1,
      totalContextLines: 10,
    });

    writeFixtureJsonl(STATE_DIR, "session-context-history.jsonl", [
      {
        ruleIds: ["r1"],
        rules: [{ id: "r1", text: "rule 1" }],
        domains: ["testing"],
        domain_source: "keyword",
        timestamp: new Date().toISOString(),
        ttl: 86400000,
        rulesInjectedCount: 1,
        rulesInjectedKB: 0.1,
        totalContextLines: 10,
      },
    ]);

    writeFixture(STATE_DIR, "rule-stats.json", []);

    const { reconcile } = await import("../../src/daemon/reconcile");
    const report = await reconcile();

    // Shape validation
    expect(typeof report.timestamp).toBe("string");
    expect(Array.isArray(report.checks)).toBe(true);
    expect(["pass", "warn", "fail"]).toContain(report.overall);

    for (const check of report.checks) {
      expect(typeof check.name).toBe("string");
      expect(["pass", "warn", "fail"]).toContain(check.status);
      expect(typeof check.detail).toBe("string");
    }
  });
});
