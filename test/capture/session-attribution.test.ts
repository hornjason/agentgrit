import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { captureRating } from "../../src/capture/rating";
import { writeSessionContext } from "../../src/graph/context";
import type { SessionContext } from "../../src/graph/context";
import { Tier } from "../../src/adapters/types";

const TMP_DIR = join(import.meta.dir, ".tmp-session-attribution-test");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

describe("captureRating with session context attribution", () => {
  test("auto-reads session-context.json when ruleIds not provided", async () => {
    writeSessionContext(
      [
        { id: "ctx-rule-1", text: "rule 1", tier: Tier.Graph, tags: [], created: "", correlationScore: 0, sourceSignals: [], schemaVersion: 1 },
        { id: "ctx-rule-2", text: "rule 2", tier: Tier.Graph, tags: [], created: "", correlationScore: 0, sourceSignals: [], schemaVersion: 1 },
      ],
      ["deployment"],
    );
    const signal = await captureRating("/rate M:8 S:8 Q:8", "test-session");
    expect(signal).not.toBeNull();
    expect(signal!.rule_ids).toEqual(["ctx-rule-1", "ctx-rule-2"]);
  });

  test("explicit ruleIds take precedence over session context", async () => {
    writeSessionContext(
      [{ id: "context-rule", text: "from context", tier: Tier.Graph, tags: [], created: "", correlationScore: 0, sourceSignals: [], schemaVersion: 1 }],
      ["deployment"],
    );
    const signal = await captureRating("/rate M:8 S:8 Q:8", "test-session", {
      ruleIds: ["explicit-rule"],
    });
    expect(signal).not.toBeNull();
    expect(signal!.rule_ids).toEqual(["explicit-rule"]);
  });

  test("returns undefined rule_ids when no session context exists", async () => {
    const signal = await captureRating("/rate M:8 S:8 Q:8", "test-session");
    expect(signal).not.toBeNull();
    expect(signal!.rule_ids).toBeUndefined();
  });

  test("ignores expired session context", async () => {
    const stateDir = join(TMP_DIR, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "session-context.json"), JSON.stringify({
      ruleIds: ["expired-rule"],
      domains: ["scope"],
      timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      ttl: 24 * 60 * 60 * 1000,
    }));
    const signal = await captureRating("/rate M:8 S:8 Q:8", "test-session");
    expect(signal).not.toBeNull();
    expect(signal!.rule_ids).toBeUndefined();
  });
});
