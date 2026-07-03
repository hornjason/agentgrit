import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import type { AgentGritConfig } from "../../src/adapters/types";
import { runDoctor } from "../../src/daemon/doctor";

const TEST_DIR = "/tmp/agentgrit-doctor-test-" + process.pid;
const SIGNAL_DIR = join(TEST_DIR, "signals");
const STATE_DIR = join(TEST_DIR, "state");
const RULES_DIR = join(TEST_DIR, "rules");

function makeConfig(overrides?: Partial<AgentGritConfig>): AgentGritConfig {
  return {
    signalDir: SIGNAL_DIR,
    adapter: "local",
    rubrics: [],
    rules: { globalBudget: 25, projectBudget: 25, autoPromote: false },
    daemon: { interval: "30m", weeklyDay: "sunday" },
    ...overrides,
  };
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(SIGNAL_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
});

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("doctor report structure", () => {
  test("returns report with all sections", async () => {
    const report = await runDoctor(makeConfig());

    expect(report).toHaveProperty("timestamp");
    expect(report).toHaveProperty("overall");
    expect(report).toHaveProperty("sections");
    expect(report.sections.length).toBe(5);

    const sectionNames = report.sections.map((s) => s.name);
    expect(sectionNames).toContain("CAPTURE");
    expect(sectionNames).toContain("SCORING");
    expect(sectionNames).toContain("GRAPH");
    expect(sectionNames).toContain("RULES");
    expect(sectionNames).toContain("SIGNALS");
  });

  test("overall status is worst of all sections", async () => {
    const report = await runDoctor(makeConfig());
    const sectionStatuses = report.sections.map((s) => s.status);

    if (sectionStatuses.includes("error")) {
      expect(report.overall).toBe("error");
    } else if (sectionStatuses.includes("warning")) {
      expect(report.overall).toBe("warning");
    } else {
      expect(report.overall).toBe("ok");
    }
  });
});

describe("CAPTURE section", () => {
  test("warns when signal files missing", async () => {
    const report = await runDoctor(makeConfig());
    const capture = report.sections.find((s) => s.name === "CAPTURE")!;

    expect(capture.checks.length).toBeGreaterThan(0);
    for (const check of capture.checks) {
      expect(check.status).toBe("warning");
    }
  });

  test("reports ok when signal files exist and are recent", async () => {
    writeFileSync(join(SIGNAL_DIR, "ratings.jsonl"), '{"test":1}\n');
    writeFileSync(join(SIGNAL_DIR, "corrections.jsonl"), '{"test":1}\n');
    writeFileSync(join(SIGNAL_DIR, "sentiment.jsonl"), '{"test":1}\n');
    writeFileSync(join(SIGNAL_DIR, "skills.jsonl"), '{"test":1}\n');

    const report = await runDoctor(makeConfig());
    const capture = report.sections.find((s) => s.name === "CAPTURE")!;

    for (const check of capture.checks) {
      expect(check.status).toBe("ok");
    }
  });
});

describe("SCORING section", () => {
  test("warns when no judge API key", async () => {
    const report = await runDoctor(makeConfig());
    const scoring = report.sections.find((s) => s.name === "SCORING")!;
    const keyCheck = scoring.checks.find((c) => c.name === "judge-api-key")!;

    expect(keyCheck.status).toBe("warning");
  });

  test("reports ok when judge configured", async () => {
    const config = makeConfig({
      judge: { provider: "gemini", model: "gemini-2.5-flash", apiKey: "test-key" },
    });
    const report = await runDoctor(config);
    const scoring = report.sections.find((s) => s.name === "SCORING")!;
    const keyCheck = scoring.checks.find((c) => c.name === "judge-api-key")!;

    expect(keyCheck.status).toBe("ok");
    expect(keyCheck.message).toContain("gemini");
  });
});

describe("GRAPH section", () => {
  test("warns when knowledge graph missing", async () => {
    const report = await runDoctor(makeConfig());
    const graph = report.sections.find((s) => s.name === "GRAPH")!;

    expect(graph.checks.some((c) => c.status === "warning")).toBe(true);
  });

  test("reports ok when graph exists and is recent", async () => {
    const graphPath = join(STATE_DIR, "knowledge-graph.json");
    writeFileSync(graphPath, JSON.stringify({ nodes: {}, edges: [] }));

    const config = makeConfig({ signalDir: join(TEST_DIR, "signals") });
    const report = await runDoctor(config);
    const graph = report.sections.find((s) => s.name === "GRAPH")!;
    const graphCheck = graph.checks.find((c) => c.name === "knowledge-graph")!;

    expect(graphCheck.status).toBe("ok");
  });
});

describe("RULES section", () => {
  test("reports ok when no rules directory", async () => {
    const report = await runDoctor(makeConfig());
    const rules = report.sections.find((s) => s.name === "RULES")!;

    expect(rules.status).toBe("ok");
  });

  test("warns when near budget", async () => {
    mkdirSync(RULES_DIR, { recursive: true });
    for (let i = 0; i < 22; i++) {
      writeFileSync(join(RULES_DIR, `rule-${i}.md`), `Rule ${i}`);
    }

    const config = makeConfig();
    const report = await runDoctor(config);
    const rules = report.sections.find((s) => s.name === "RULES")!;
    const countCheck = rules.checks.find((c) => c.name === "rule-count")!;

    expect(countCheck.status).toBe("warning");
  });

  test("errors when over budget", async () => {
    mkdirSync(RULES_DIR, { recursive: true });
    for (let i = 0; i < 30; i++) {
      writeFileSync(join(RULES_DIR, `rule-${i}.md`), `Rule ${i}`);
    }

    const config = makeConfig();
    const report = await runDoctor(config);
    const rules = report.sections.find((s) => s.name === "RULES")!;
    const countCheck = rules.checks.find((c) => c.name === "rule-count")!;

    expect(countCheck.status).toBe("error");
  });
});

describe("SIGNALS section", () => {
  test("reports each jsonl file with size", async () => {
    writeFileSync(join(SIGNAL_DIR, "ratings.jsonl"), "x".repeat(100));

    const report = await runDoctor(makeConfig());
    const signals = report.sections.find((s) => s.name === "SIGNALS")!;

    expect(signals.checks.length).toBeGreaterThan(0);
    expect(signals.checks[0].message).toContain("MB");
  });

  test("warns on signal directory missing", async () => {
    const config = makeConfig({ signalDir: "/tmp/agentgrit-nonexistent-" + Date.now() });
    const report = await runDoctor(config);
    const signals = report.sections.find((s) => s.name === "SIGNALS")!;

    expect(signals.status).toBe("warning");
  });
});
