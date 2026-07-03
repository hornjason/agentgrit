import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  detectCorrection,
  captureFailure,
  auditAssertions,
  extractWorkLearnings,
} from "../../src/capture/corrections";

const TMP_DIR = join(import.meta.dir, ".tmp-corrections-test");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

describe("detectCorrection", () => {
  test("detects 'no not like that'", async () => {
    const signal = await detectCorrection(
      "no not like that, use the other approach",
      "I refactored the function.",
      "test-session",
    );
    expect(signal).not.toBeNull();
    expect(signal!.type).toBe("correction");
    expect(signal!.correction_phrase).toBeTruthy();
  });

  test("detects 'stop doing'", async () => {
    const signal = await detectCorrection(
      "stop doing that, it breaks the build",
      "I added the configuration.",
      "test-session",
    );
    expect(signal).not.toBeNull();
    expect(signal!.type).toBe("correction");
  });

  test("detects 'wrong'", async () => {
    const signal = await detectCorrection(
      "wrong, the API is at /v2 not /v1",
      "I called the /v1 endpoint.",
      "test-session",
    );
    expect(signal).not.toBeNull();
  });

  test("detects 'I didn't ask for'", async () => {
    const signal = await detectCorrection(
      "I didn't ask for a refactor, just fix the bug",
      "I refactored the module.",
      "test-session",
    );
    expect(signal).not.toBeNull();
    expect(signal!.correction_phrase).toBeTruthy();
  });

  test("returns null for 'no problem'", async () => {
    const signal = await detectCorrection(
      "no problem, that works",
      "Done.",
      "test-session",
    );
    expect(signal).toBeNull();
  });

  test("returns null for 'no worries'", async () => {
    const signal = await detectCorrection(
      "no worries, keep going",
      "Working on it.",
      "test-session",
    );
    expect(signal).toBeNull();
  });

  test("returns null for 'don't worry'", async () => {
    const signal = await detectCorrection(
      "don't worry about that edge case",
      "I'll handle it.",
      "test-session",
    );
    expect(signal).toBeNull();
  });

  test("returns null for 'don't forget'", async () => {
    const signal = await detectCorrection(
      "don't forget to update the docs",
      "Will do.",
      "test-session",
    );
    expect(signal).toBeNull();
  });

  test("returns null for neutral messages", async () => {
    const signal = await detectCorrection(
      "can you check the logs?",
      "Sure.",
      "test-session",
    );
    expect(signal).toBeNull();
  });

  test("writes to corrections.jsonl", async () => {
    await detectCorrection(
      "that's wrong, the endpoint is different",
      "I used /api/v1.",
      "test-session",
    );

    const filePath = join(TMP_DIR, "signals", "corrections.jsonl");
    expect(existsSync(filePath)).toBe(true);
    const line = readFileSync(filePath, "utf-8").trim();
    const parsed = JSON.parse(line);
    expect(parsed.type).toBe("correction");
    expect(parsed.session_id).toBe("test-session");
  });
});

describe("captureFailure", () => {
  test("captures failure for rating <= 3", () => {
    const result = captureFailure({
      rating: 2,
      sentimentSummary: "Frustrated with incorrect output",
      sessionId: "test-session",
    });

    expect(result).not.toBeNull();
    expect(result!.type).toBe("failure");
    expect(result!.severity).toBe("high");
    expect(result!.session_id).toBe("test-session");
  });

  test("returns null for rating > 3", () => {
    const result = captureFailure({
      rating: 5,
      sentimentSummary: "Mediocre output",
      sessionId: "test-session",
    });

    expect(result).toBeNull();
  });

  test("classifies severity by rating", () => {
    expect(captureFailure({ rating: 1, sentimentSummary: "bad", sessionId: "s" })!.severity).toBe("critical");
    expect(captureFailure({ rating: 2, sentimentSummary: "bad", sessionId: "s" })!.severity).toBe("high");
    expect(captureFailure({ rating: 3, sentimentSummary: "bad", sessionId: "s" })!.severity).toBe("medium");
  });

  test("includes conversation snippets in context", () => {
    const result = captureFailure({
      rating: 1,
      sentimentSummary: "Broke everything",
      detailedContext: "Detailed analysis here",
      conversationSnippets: [
        { role: "user", content: "Fix the auth" },
        { role: "assistant", content: "I deleted the database" },
      ],
      sessionId: "test-session",
    });

    expect(result).not.toBeNull();
    expect(result!.context).toContain("Detailed analysis");
    expect(result!.context).toContain("Fix the auth");
  });

  test("includes tool names when provided", () => {
    const result = captureFailure({
      rating: 2,
      sentimentSummary: "Wrong tools used",
      toolNames: ["Bash", "Write", "Edit"],
      sessionId: "test-session",
    });

    expect(result!.toolsUsed).toEqual(["Bash", "Write", "Edit"]);
  });
});

describe("auditAssertions", () => {
  test("detects unverified negative assertions", () => {
    const message = "The scraper can't run from this machine locally. " +
      "It only works on the Mac Mini. You need special auth to access the service.";
    const result = auditAssertions(message, "test-session");

    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations.some((v) => !v.hasEvidence)).toBe(true);
  });

  test("does not flag assertions with evidence", () => {
    const message = "The scraper can't run locally. Error: connection refused. " +
      "I tried running it and got exit code 1.";
    const result = auditAssertions(message, "test-session");

    // Should not have unverified violations (evidence markers present)
    const unverified = result.violations.filter((v) => !v.hasEvidence);
    expect(unverified.length).toBe(0);
  });

  test("returns empty for short messages", () => {
    const result = auditAssertions("ok", "test-session");
    expect(result.violations).toHaveLength(0);
  });

  test("returns empty for messages without negative assertions", () => {
    const result = auditAssertions(
      "I updated the configuration and deployed the service. " +
      "The tests are passing and the build succeeded.",
      "test-session",
    );
    expect(result.violations).toHaveLength(0);
  });

  test("checks surrounding context for evidence", () => {
    const message = "I verified by running the command. " +
      "The scraper can't run locally because the actual error is: " +
      "ECONNREFUSED on port 443.";
    const result = auditAssertions(message, "test-session");
    // Evidence markers are in surrounding context
    const unverified = result.violations.filter((v) => !v.hasEvidence);
    expect(unverified.length).toBe(0);
  });
});

describe("extractWorkLearnings", () => {
  test("extracts learning from significant work", () => {
    const result = extractWorkLearnings({
      title: "Fix auth module refactoring",
      filesChanged: ["src/auth.ts", "src/auth.test.ts"],
      toolsUsed: ["Read", "Edit", "Bash", "Write"],
      agentsSpawned: ["Marcus"],
      sessionId: "test-session",
    });

    expect(result).not.toBeNull();
    expect(result!.id).toBeTruthy();
    expect(result!.filesChanged).toBe(2);
    expect(result!.toolsUsed.length).toBeGreaterThan(0);
    expect(result!.insights.length).toBeGreaterThan(0);
  });

  test("returns null for trivial work", () => {
    const result = extractWorkLearnings({
      title: "Quick config tweak",
      filesChanged: [],
      toolsUsed: ["Read"],
      agentsSpawned: [],
      sessionId: "test-session",
    });

    expect(result).toBeNull();
  });

  test("classifies approach-related work", () => {
    const result = extractWorkLearnings({
      title: "Wrong approach to database migration",
      filesChanged: ["migration.sql"],
      toolsUsed: ["Bash"],
      agentsSpawned: [],
      sessionId: "test-session",
    });

    expect(result).not.toBeNull();
    expect(result!.category).toBe("approach");
  });

  test("classifies tooling-related work", () => {
    const result = extractWorkLearnings({
      title: "Fix broken deployment config",
      filesChanged: ["deploy.yaml"],
      toolsUsed: ["Read", "Write"],
      agentsSpawned: [],
      sessionId: "test-session",
    });

    expect(result).not.toBeNull();
    expect(result!.category).toBe("tooling");
  });

  test("generates insights for heavy tool usage", () => {
    const result = extractWorkLearnings({
      title: "Big refactor",
      filesChanged: Array.from({ length: 8 }, (_, i) => `file${i}.ts`),
      toolsUsed: Array.from({ length: 15 }, () => "Edit"),
      agentsSpawned: ["Marcus", "Quinn"],
      sessionId: "test-session",
      duration: "2h 30m",
    });

    expect(result).not.toBeNull();
    expect(result!.insights.some((i) => i.includes("files"))).toBe(true);
    expect(result!.insights.some((i) => i.includes("agent"))).toBe(true);
    expect(result!.insights.some((i) => i.includes("tool usage"))).toBe(true);
    expect(result!.insights.some((i) => i.includes("duration"))).toBe(true);
  });
});
