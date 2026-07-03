import { describe, test, expect } from "bun:test";
import { extractDebrief, parseTranscript } from "../../src/capture/debrief";

function makeTranscript(
  exchanges: { user: string; assistant: string }[],
): string {
  const lines: string[] = [];
  for (const ex of exchanges) {
    lines.push(
      JSON.stringify({
        type: "user",
        message: { content: ex.user },
      }),
    );
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: { content: ex.assistant },
      }),
    );
  }
  return lines.join("\n");
}

describe("parseTranscript", () => {
  test("parses user and assistant turns", () => {
    const transcript = makeTranscript([
      { user: "fix the bug", assistant: "Done." },
    ]);
    const turns = parseTranscript(transcript);
    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe("user");
    expect(turns[0].text).toBe("fix the bug");
    expect(turns[1].role).toBe("assistant");
  });

  test("handles array content format", () => {
    const transcript = JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "text", text: "hello" },
          { type: "text", text: "world" },
        ],
      },
    });
    const turns = parseTranscript(transcript);
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("hello world");
  });

  test("skips malformed lines", () => {
    const transcript = [
      "not json",
      JSON.stringify({ type: "user", message: { content: "valid" } }),
    ].join("\n");
    const turns = parseTranscript(transcript);
    expect(turns).toHaveLength(1);
  });
});

describe("extractDebrief", () => {
  test("extracts corrections from transcript with 3 correction turns", async () => {
    const transcript = makeTranscript([
      { user: "fix the auth bug", assistant: "I refactored the module." },
      {
        user: "no not like that, just fix the specific bug",
        assistant: "Ok fixing.",
      },
      { user: "that's wrong, use v2 API", assistant: "Switching to v2." },
      {
        user: "stop doing extra refactoring",
        assistant: "Understood.",
      },
    ]);

    const result = await extractDebrief(transcript, "test-session");

    expect(result.corrections.length).toBe(3);
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);

    for (const candidate of result.candidates) {
      expect(candidate.id).toBeTruthy();
      expect(candidate.text).toBeTruthy();
      expect(candidate.sourceSessions).toContain("test-session");
      expect(candidate.frequency).toBeGreaterThanOrEqual(1);
    }
  });

  test("returns empty for transcript with no corrections", async () => {
    const transcript = makeTranscript([
      { user: "check the build", assistant: "Build passes." },
      { user: "deploy it", assistant: "Deployed." },
    ]);

    const result = await extractDebrief(transcript, "test-session");
    expect(result.corrections).toHaveLength(0);
    expect(result.candidates).toHaveLength(0);
  });

  test("filters noise phrases like 'no problem'", async () => {
    const transcript = makeTranscript([
      { user: "no problem, keep going", assistant: "Continuing." },
      { user: "don't worry about that", assistant: "Ok." },
    ]);

    const result = await extractDebrief(transcript, "test-session");
    expect(result.corrections).toHaveLength(0);
  });

  test("groups corrections by theme", async () => {
    const transcript = makeTranscript([
      { user: "wrong endpoint, use /v2", assistant: "Fixed." },
      {
        user: "incorrect, the port is 3000",
        assistant: "Updated.",
      },
      {
        user: "stop doing that refactoring",
        assistant: "Stopped.",
      },
    ]);

    const result = await extractDebrief(transcript, "test-session");
    expect(result.corrections.length).toBe(3);

    const themes = result.candidates.map((c) => c.text);
    const hasAccuracy = themes.some((t) => t.includes("accuracy"));
    const hasBehavioral = themes.some((t) => t.includes("behavioral"));
    expect(hasAccuracy || hasBehavioral).toBe(true);
  });

  test("handles malformed transcript lines", async () => {
    const transcript = [
      "not json",
      JSON.stringify({
        type: "user",
        message: { content: "that's wrong" },
      }),
      "{}",
      JSON.stringify({
        type: "assistant",
        message: { content: "Fixed." },
      }),
    ].join("\n");

    const result = await extractDebrief(transcript, "test-session");
    expect(result.corrections.length).toBe(1);
  });

  test("detects approval signals", async () => {
    const transcript = makeTranscript([
      { user: "fix the bug", assistant: "Fixed the auth module." },
      { user: "perfect, love it", assistant: "Thank you." },
      { user: "great work on the deploy", assistant: "Glad it helped." },
    ]);

    const result = await extractDebrief(transcript, "test-session");
    expect(result.approvals.length).toBeGreaterThanOrEqual(2);
    expect(result.approvals[0].phrase).toBeTruthy();
  });

  test("detects reprompts from word overlap", async () => {
    const transcript = makeTranscript([
      { user: "please fix the authentication module bug", assistant: "I refactored the code." },
      { user: "fix the authentication module bug please", assistant: "Fixing." },
    ]);

    const result = await extractDebrief(transcript, "test-session");
    expect(result.reprompts).toBe(1);
  });

  test("returns both approvals and corrections from mixed session", async () => {
    const transcript = makeTranscript([
      { user: "fix the bug", assistant: "Done." },
      { user: "perfect", assistant: "Thanks." },
      { user: "wrong, the other endpoint", assistant: "Fixed." },
      { user: "love it, great work", assistant: "Glad." },
    ]);

    const result = await extractDebrief(transcript, "test-session");
    expect(result.corrections.length).toBe(1);
    expect(result.approvals.length).toBeGreaterThanOrEqual(2);
  });
});
