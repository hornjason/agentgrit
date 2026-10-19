/**
 * Regression test for #257 — rating capture silently dead since 2026-10-01.
 *
 * The payload below is a VERBATIM capture from the live Claude Code binary
 * (2.1.x, 2026-10-19), taken by registering a throwaway UserPromptSubmit hook
 * that dumped its stdin:
 *
 *   {"session_id":"a7ab3b3a-...","transcript_path":"/Users/.../a7ab3b3a-....jsonl",
 *    "cwd":"/Users/...","prompt_id":"19f5ba21-...","permission_mode":"bypassPermissions",
 *    "hook_event_name":"UserPromptSubmit","prompt":"say hi"}
 *
 * There is NO `message` key. The user text lives in a top-level `prompt`.
 * `capture rating|correction|sentiment` read `input.message?.content`, found
 * undefined, and returned — exit 0, nothing written, no diagnostic.
 *
 * These tests assert on the real envelope. They must stay keyed to it: if the
 * fixture is ever loosened back to `{message:{content}}` this file stops
 * guarding anything.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

const TMP_DIR = join(import.meta.dir, ".tmp-rating-hook-payload");
const BIN = join(import.meta.dir, "../../bin/agentgrit.ts");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

async function runCapture(
  sub: string,
  stdin: string,
): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(["bun", BIN, "capture", sub], {
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AGENTGRIT_DIR: TMP_DIR },
  });
  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stderr };
}

/** The real UserPromptSubmit envelope, with only `prompt` swapped out. */
function realPayload(prompt: string, sessionId = "sess-real") {
  return JSON.stringify({
    session_id: sessionId,
    transcript_path: `/Users/test/.claude/projects/x/${sessionId}.jsonl`,
    cwd: "/Users/test/Projects/agentgrit",
    prompt_id: "19f5ba21-32a5-42ff-b761-4b4433e40d51",
    permission_mode: "bypassPermissions",
    hook_event_name: "UserPromptSubmit",
    prompt,
  });
}

function readRatings(): Record<string, unknown>[] {
  const file = join(TMP_DIR, "signals", "ratings.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("#257 capture rating — real UserPromptSubmit payload", () => {
  test("explicit /rate in top-level `prompt` writes a record", async () => {
    const result = await runCapture("rating", realPayload("/rate M:6 S:6 Q:6 solid"));
    expect(result.exitCode).toBe(0);

    const records = readRatings();
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe("rating");
    expect(records[0].source).toBe("explicit");
    expect(records[0].mode).toBe(6);
    expect(records[0].scope).toBe(6);
    expect(records[0].quality).toBe(6);
    expect(records[0].session_id).toBe("sess-real");
  });

  test("bare number in top-level `prompt` writes an implicit record", async () => {
    const result = await runCapture("rating", realPayload("6"));
    expect(result.exitCode).toBe(0);

    const records = readRatings();
    expect(records).toHaveLength(1);
    expect(records[0].source).toBe("implicit");
    expect(records[0].rating).toBe(6);
  });

  test("legacy {message:{content}} envelope still writes a record", async () => {
    // bin/commands/capture.ts is also driven by non-Claude-Code callers and by
    // test/commands/capture.test.ts; the fix must accept both envelopes.
    const legacy = JSON.stringify({
      session_id: "sess-legacy",
      message: { role: "user", content: "/rate M:6 S:6 Q:6" },
    });
    const result = await runCapture("rating", legacy);
    expect(result.exitCode).toBe(0);

    const records = readRatings();
    expect(records).toHaveLength(1);
    expect(records[0].session_id).toBe("sess-legacy");
  });

  test("correction in top-level `prompt` writes to corrections.jsonl", async () => {
    // Must match CORRECTION_STARTERS (/^no\s/) — "no," with a comma does not.
    const result = await runCapture("correction", realPayload("no that is wrong"));
    expect(result.exitCode).toBe(0);

    const file = join(TMP_DIR, "signals", "corrections.jsonl");
    expect(existsSync(file)).toBe(true);
    const rec = JSON.parse(readFileSync(file, "utf-8").trim());
    expect(rec.type).toBe("correction");
    expect(rec.correction_phrase).toContain("wrong");
  });
});

describe("#257 capture — unparseable payloads must not be silent", () => {
  test("payload with no user-text field logs a diagnostic naming the keys", async () => {
    // A well-formed JSON object that carries no prompt and no message.content —
    // exactly the shape that produced 0 records for 18 days.
    const result = await runCapture(
      "rating",
      JSON.stringify({ session_id: "s", hook_event_name: "UserPromptSubmit" }),
    );

    expect(result.stderr).toContain("agentgrit");
    expect(result.stderr).toContain("prompt");
    expect(readRatings()).toHaveLength(0);
  });

  test("malformed JSON logs a diagnostic", async () => {
    const result = await runCapture("rating", "not json at all");
    expect(result.stderr).toContain("agentgrit");
  });

  test("a parseable payload with no rating in it stays quiet", async () => {
    // Not a defect: the envelope was understood, the text simply was not a
    // rating. This must NOT log, or every prompt would emit noise.
    const result = await runCapture("rating", realPayload("what time is it"));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(readRatings()).toHaveLength(0);
  });
});
