import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, ".tmp-doctor-test");

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TEST_DIR;
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

describe("doctor command", () => {
  test("reports failures for missing directories", () => {
    const { runDoctor } = require("../../bin/commands/doctor");
    const report = runDoctor();

    expect(report.failed).toBeGreaterThan(0);
    expect(report.checks.find((c: any) => c.name === "base")?.status).toBe("fail");
  });

  test("reports pass for complete setup", () => {
    mkdirSync(join(TEST_DIR, "signals"), { recursive: true });
    mkdirSync(join(TEST_DIR, "state"), { recursive: true });
    mkdirSync(join(TEST_DIR, "rubrics"), { recursive: true });

    writeFileSync(join(TEST_DIR, "config.json"), JSON.stringify({ adapter: "local" }));
    writeFileSync(join(TEST_DIR, "rubrics", "starter.json"), JSON.stringify({
      version: "1.0", schemaVersion: 1,
      dimensions: [{ name: "test", weight: 1.0, description: "test", rubric: "test" }],
      judgeModel: "test",
    }));

    const { runDoctor } = require("../../bin/commands/doctor");
    const report = runDoctor();

    expect(report.checks.find((c: any) => c.name === "base")?.status).toBe("pass");
    expect(report.checks.find((c: any) => c.name === "config")?.status).toBe("pass");
    expect(report.checks.find((c: any) => c.name === "rubrics")?.status).toBe("pass");
  });

  test("warns on large signal files", () => {
    mkdirSync(join(TEST_DIR, "signals"), { recursive: true });
    mkdirSync(join(TEST_DIR, "state"), { recursive: true });
    mkdirSync(join(TEST_DIR, "rubrics"), { recursive: true });
    writeFileSync(join(TEST_DIR, "config.json"), "{}");

    const largeLine = JSON.stringify({ id: "1", type: "rating", rating: 5 }) + "\n";
    const largeContent = largeLine.repeat(100000);
    writeFileSync(join(TEST_DIR, "signals", "ratings.jsonl"), largeContent);

    const { runDoctor } = require("../../bin/commands/doctor");
    const report = runDoctor();

    const ratingCheck = report.checks.find((c: any) => c.name === "signal:ratings.jsonl");
    expect(ratingCheck).toBeDefined();
  });

  test("formats doctor output with doctorCommand", async () => {
    mkdirSync(join(TEST_DIR, "signals"), { recursive: true });
    mkdirSync(join(TEST_DIR, "state"), { recursive: true });
    mkdirSync(join(TEST_DIR, "rubrics"), { recursive: true });
    writeFileSync(join(TEST_DIR, "config.json"), "{}");

    const { doctorCommand } = await import("../../bin/commands/doctor");
    await doctorCommand([]);
  });
});
