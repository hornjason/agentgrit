import { describe, test, expect } from "bun:test";
import { extractDebrief } from "../../src/capture/debrief";

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
});
