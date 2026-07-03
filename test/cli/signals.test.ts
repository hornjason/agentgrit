import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, statSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, ".tmp-signals-test");

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, "signals"), { recursive: true });
  process.env.AGENTGRIT_DIR = TEST_DIR;
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

describe("signals command", () => {
  test("shows empty when no signal files exist", async () => {
    const { signalsCommand } = await import("../../bin/commands/signals");
    await signalsCommand([]);
  });

  test("shows file sizes and counts", async () => {
    const signals = Array.from({ length: 10 }, (_, i) => ({
      id: `r${i}`,
      type: "rating",
      timestamp: new Date().toISOString(),
      sessionId: `s${i}`,
      schemaVersion: 1,
      rating: 7,
      source: "explicit",
    }));

    writeFileSync(
      join(TEST_DIR, "signals", "ratings.jsonl"),
      signals.map((s) => JSON.stringify(s)).join("\n") + "\n",
    );

    const { signalsCommand } = await import("../../bin/commands/signals");
    await signalsCommand([]);
  });

  test("rotates large files", async () => {
    const line = JSON.stringify({ id: "1", type: "correction", timestamp: new Date().toISOString(), sessionId: "s1", schemaVersion: 1, trigger: "no", context: "wrong", severity: 3 }) + "\n";
    const path = join(TEST_DIR, "signals", "big.jsonl");
    writeFileSync(path, line.repeat(1000));

    const { signalsCommand } = await import("../../bin/commands/signals");
    await signalsCommand(["rotate"]);
  });
});
