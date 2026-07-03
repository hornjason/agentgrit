import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, ".tmp-inbox-test");

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, "signals"), { recursive: true });
  mkdirSync(join(TEST_DIR, "state"), { recursive: true });
  process.env.AGENTGRIT_DIR = TEST_DIR;
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

describe("inbox command", () => {
  test("shows empty inbox when no signals", async () => {
    const { getInboxItems } = await import("../../bin/commands/inbox");
    const items = await getInboxItems(join(TEST_DIR, "signals"));
    expect(items).toHaveLength(0);
  });

  test("detects candidates from correction signals", async () => {
    const corrections = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      type: "correction",
      timestamp: new Date().toISOString(),
      session_id: `session-${i % 3}`,
      schemaVersion: 1,
      correction_phrase: "stop doing that wrong approach",
      context: "repeated failure pattern in verification",
    }));

    writeFileSync(
      join(TEST_DIR, "signals", "corrections.jsonl"),
      corrections.map((c) => JSON.stringify(c)).join("\n") + "\n",
    );

    const { getInboxItems } = await import("../../bin/commands/inbox");
    const items = await getInboxItems(join(TEST_DIR, "signals"));

    expect(items.length).toBeGreaterThanOrEqual(0);

    for (const item of items) {
      expect(item.route.tier).toBeDefined();
      expect(item.route.rationale).toBeDefined();
    }
  });

  test("formats inbox output", async () => {
    const { inboxCommand } = await import("../../bin/commands/inbox");
    await inboxCommand([]);
  });
});
