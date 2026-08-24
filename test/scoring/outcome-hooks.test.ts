import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";

const tmpDir = join(import.meta.dir, ".tmp-outcome-hooks");
const stateDir = join(tmpDir, "state");

import {
  captureCommitOutcome,
  captureCorrectionOutcome,
  captureIssueClosedOutcome,
} from "../../src/capture/outcome-hooks";
import type { OutcomeEvent } from "../../src/capture/outcomes";

function readOutcomes(): OutcomeEvent[] {
  const filePath = join(stateDir, "outcome-events.jsonl");
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

describe("outcome-hooks", () => {
  beforeEach(() => {
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it("captureCommitOutcome writes commit-merged event", async () => {
    await captureCommitOutcome("session-1", 5, stateDir);
    const events = readOutcomes();
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("commit-merged");
    expect(events[0].sessionId).toBe("session-1");
    expect(events[0].turn).toBe(5);
  });

  it("captureCorrectionOutcome writes correction event", async () => {
    await captureCorrectionOutcome("session-2", 3, stateDir);
    const events = readOutcomes();
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("correction");
    expect(events[0].sessionId).toBe("session-2");
    expect(events[0].turn).toBe(3);
  });

  it("captureIssueClosedOutcome writes issue-closed event", async () => {
    await captureIssueClosedOutcome("session-3", 10, stateDir);
    const events = readOutcomes();
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("issue-closed");
    expect(events[0].sessionId).toBe("session-3");
    expect(events[0].turn).toBe(10);
  });
});
