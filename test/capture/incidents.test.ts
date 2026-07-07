import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  detectError,
  monitorToolOutput,
  parseIncidents,
  recordIncident,
  analyzeSessionPatterns,
  type IncidentRecord,
} from "../../src/capture/incidents";

const TEST_DIR = "/tmp/agentgrit-incidents-test-" + process.pid;
const INCIDENTS_FILE = join(TEST_DIR, "signals", "incidents.jsonl");
const PENDING_RULES = join(TEST_DIR, "learning", "PENDING-RULES.md");

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, "signals"), { recursive: true });
  mkdirSync(join(TEST_DIR, "learning"), { recursive: true });
});

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("detectError", () => {
  test("detects non-zero exit codes", () => {
    expect(detectError("Exit code 1").matched).toBe(true);
    expect(detectError("exit status 2").matched).toBe(true);
    expect(detectError("returned non-zero").matched).toBe(true);
  });

  test("detects error keywords", () => {
    expect(detectError("Error: something broke").matched).toBe(true);
    expect(detectError("TypeError: undefined").matched).toBe(true);
    expect(detectError("SyntaxError: unexpected").matched).toBe(true);
    expect(detectError("Cannot find module").matched).toBe(true);
    expect(detectError("permission denied").matched).toBe(true);
  });

  test("returns correct error types", () => {
    expect(detectError("Exit code 1").errorType).toBe("non-zero-exit");
    expect(detectError("TypeError: x").errorType).toBe("TypeError");
    expect(detectError("FAILED test").errorType).toBe("FAILED");
  });

  test("filters false positives", () => {
    expect(detectError("no changes detected").matched).toBe(false);
    expect(detectError("0 errors found").matched).toBe(false);
  });

  test("returns false for clean output", () => {
    expect(detectError("success: all tests passed").matched).toBe(false);
    expect(detectError("compiled successfully").matched).toBe(false);
  });
});

describe("monitorToolOutput", () => {
  test("records incident when error detected", () => {
    const result = monitorToolOutput(
      "Error: module not found",
      "bun test",
      "session-123",
      INCIDENTS_FILE,
    );

    expect(result).not.toBeNull();
    expect(result!.error_type).toBe("Error");
    expect(result!.session_id).toBe("session-123");
    expect(existsSync(INCIDENTS_FILE)).toBe(true);
  });

  test("returns null for clean output", () => {
    const result = monitorToolOutput(
      "all tests passed",
      "bun test",
      "session-123",
      INCIDENTS_FILE,
    );
    expect(result).toBeNull();
  });

  test("returns null for empty output", () => {
    const result = monitorToolOutput("", "cmd", "sess", INCIDENTS_FILE);
    expect(result).toBeNull();
  });

  test("truncates error snippet to 200 chars", () => {
    const longOutput = "Error: " + "x".repeat(300);
    const result = monitorToolOutput(
      longOutput,
      "cmd",
      "sess",
      INCIDENTS_FILE,
    );
    expect(result!.error_snippet.length).toBeLessThanOrEqual(200);
  });

  test("truncates command preview to 80 chars", () => {
    const longCmd = "bun " + "x".repeat(200);
    const result = monitorToolOutput(
      "Error: broken",
      longCmd,
      "sess",
      INCIDENTS_FILE,
    );
    expect(result!.command_preview.length).toBeLessThanOrEqual(80);
  });
});

describe("parseIncidents", () => {
  test("parses JSONL records", () => {
    const raw = [
      JSON.stringify({ timestamp: "t1", session_id: "s1", error_snippet: "e", error_type: "Error", command_preview: "c" }),
      JSON.stringify({ timestamp: "t2", session_id: "s2", error_snippet: "e", error_type: "TypeError", command_preview: "c" }),
    ].join("\n");

    const records = parseIncidents(raw);
    expect(records).toHaveLength(2);
    expect(records[0].error_type).toBe("Error");
    expect(records[1].error_type).toBe("TypeError");
  });

  test("skips malformed lines", () => {
    const raw = "not json\n" + JSON.stringify({ timestamp: "t", session_id: "s", error_snippet: "e", error_type: "Error", command_preview: "c" });
    const records = parseIncidents(raw);
    expect(records).toHaveLength(1);
  });

  test("handles empty input", () => {
    expect(parseIncidents("")).toHaveLength(0);
    expect(parseIncidents("\n\n")).toHaveLength(0);
  });
});

describe("analyzeSessionPatterns", () => {
  function writeIncidents(records: IncidentRecord[]): void {
    writeFileSync(
      INCIDENTS_FILE,
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
  }

  test("proposes rule when same error type appears 2+ times", () => {
    const records: IncidentRecord[] = [
      { timestamp: new Date().toISOString(), session_id: "sess-1", error_snippet: "e1", error_type: "TypeError", command_preview: "c" },
      { timestamp: new Date().toISOString(), session_id: "sess-1", error_snippet: "e2", error_type: "TypeError", command_preview: "c" },
    ];
    writeIncidents(records);

    const result = analyzeSessionPatterns(
      INCIDENTS_FILE,
      PENDING_RULES,
      "sess-1",
    );

    expect(result.patternsFound).toBe(1);
    expect(result.rulesProposed).toBe(1);
    expect(existsSync(PENDING_RULES)).toBe(true);

    const rules = readFileSync(PENDING_RULES, "utf-8");
    expect(rules).toContain("TypeError");
    expect(rules).toContain("incident-pattern");
  });

  test("does not propose rule for single occurrence", () => {
    const records: IncidentRecord[] = [
      { timestamp: new Date().toISOString(), session_id: "sess-1", error_snippet: "e1", error_type: "TypeError", command_preview: "c" },
    ];
    writeIncidents(records);

    const result = analyzeSessionPatterns(
      INCIDENTS_FILE,
      PENDING_RULES,
      "sess-1",
    );

    expect(result.patternsFound).toBe(0);
    expect(result.rulesProposed).toBe(0);
  });

  test("only analyzes incidents from specified session", () => {
    const records: IncidentRecord[] = [
      { timestamp: new Date().toISOString(), session_id: "sess-1", error_snippet: "e1", error_type: "TypeError", command_preview: "c" },
      { timestamp: new Date().toISOString(), session_id: "sess-2", error_snippet: "e2", error_type: "TypeError", command_preview: "c" },
    ];
    writeIncidents(records);

    const result = analyzeSessionPatterns(
      INCIDENTS_FILE,
      PENDING_RULES,
      "sess-1",
    );
    expect(result.patternsFound).toBe(0);
  });

  test("prunes incidents older than retention period", () => {
    const old = new Date();
    old.setDate(old.getDate() - 20);
    const recent = new Date();

    const records: IncidentRecord[] = [
      { timestamp: old.toISOString(), session_id: "old", error_snippet: "e", error_type: "Error", command_preview: "c" },
      { timestamp: recent.toISOString(), session_id: "new", error_snippet: "e", error_type: "Error", command_preview: "c" },
    ];
    writeIncidents(records);

    const result = analyzeSessionPatterns(
      INCIDENTS_FILE,
      PENDING_RULES,
      "new",
    );
    expect(result.incidentsRetained).toBe(1);

    const remaining = parseIncidents(readFileSync(INCIDENTS_FILE, "utf-8"));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].session_id).toBe("new");
  });

  test("returns zeros for nonexistent incidents file", () => {
    const result = analyzeSessionPatterns(
      "/tmp/nonexistent-" + Date.now(),
      PENDING_RULES,
      "sess-1",
    );
    expect(result.patternsFound).toBe(0);
    expect(result.rulesProposed).toBe(0);
  });

  test("deduplicates rule proposals", () => {
    writeFileSync(
      PENDING_RULES,
      "## [PROPOSED] incident-pattern-TypeError\nExisting rule\n",
    );

    const records: IncidentRecord[] = [
      { timestamp: new Date().toISOString(), session_id: "sess-1", error_snippet: "e1", error_type: "TypeError", command_preview: "c" },
      { timestamp: new Date().toISOString(), session_id: "sess-1", error_snippet: "e2", error_type: "TypeError", command_preview: "c" },
    ];
    writeIncidents(records);

    const result = analyzeSessionPatterns(
      INCIDENTS_FILE,
      PENDING_RULES,
      "sess-1",
    );
    expect(result.rulesProposed).toBe(0);
  });
});
