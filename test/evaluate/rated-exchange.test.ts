/**
 * #324 — the exchange a rating refers to, read from the session transcript:
 * the last assistant reply at or before the rating, and the last message the
 * human typed before that reply.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findTranscript, MAX_REPLY_CHARS, ratedExchange } from "../../src/evaluate/rated-exchange";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rated-exchange-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const human = (ts: string, text: string) => ({ type: "user", timestamp: ts, origin: { kind: "human" }, promptSource: "typed", message: { role: "user", content: text } });
const toolResult = (ts: string) => ({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } });
const notification = (ts: string, text: string) => ({ type: "user", timestamp: ts, origin: { kind: "task-notification" }, promptSource: "system", message: { role: "user", content: text } });
const reply = (ts: string, text: string, extra: Record<string, unknown> = {}) => ({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }] }, ...extra });
const toolUse = (ts: string) => ({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] } });

function transcript(rows: unknown[]): string {
  const p = join(dir, "s.jsonl");
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

describe("ratedExchange (#324)", () => {
  test("pairs the last reply before the rating with the message the human typed", async () => {
    const p = transcript([
      human("2026-11-01T10:00:00Z", "first question"),
      reply("2026-11-01T10:00:05Z", "first answer"),
      human("2026-11-01T10:01:00Z", "second question"),
      toolUse("2026-11-01T10:01:02Z"),
      toolResult("2026-11-01T10:01:03Z"),
      reply("2026-11-01T10:01:09Z", "second answer"),
      human("2026-11-01T10:05:00Z", "third question, after the rating"),
      reply("2026-11-01T10:05:05Z", "third answer"),
    ]);
    expect(await ratedExchange(p, "2026-11-01T10:02:00Z")).toEqual({ input: "second question", output: "second answer" });
  });

  test("a notification arriving after the human's message does not replace it as the input", async () => {
    const p = transcript([
      human("2026-11-01T10:00:00Z", "ship the fix"),
      notification("2026-11-01T10:00:30Z", "<task-notification>agent done</task-notification>"),
      reply("2026-11-01T10:00:40Z", "shipped"),
    ]);
    expect(await ratedExchange(p, "2026-11-01T10:01:00Z")).toEqual({ input: "ship the fix", output: "shipped" });
  });

  test("subagent (sidechain) replies are not the rated reply", async () => {
    const p = transcript([
      human("2026-11-01T10:00:00Z", "q"),
      reply("2026-11-01T10:00:05Z", "main answer"),
      reply("2026-11-01T10:00:06Z", "subagent chatter", { isSidechain: true }),
    ]);
    expect((await ratedExchange(p, "2026-11-01T10:01:00Z"))?.output).toBe("main answer");
  });

  test("system reminders are stripped from the human's message", async () => {
    const p = transcript([
      human("2026-11-01T10:00:00Z", "<system-reminder>\nnoise\n</system-reminder>\nreal question"),
      reply("2026-11-01T10:00:05Z", "answer"),
    ]);
    expect((await ratedExchange(p, "2026-11-01T10:01:00Z"))?.input).toBe("real question");
  });

  test("a rating timestamp with an offset compares by instant, not by string", async () => {
    const p = transcript([
      human("2026-11-01T14:00:00Z", "q"),
      reply("2026-11-01T14:00:05Z", "a"),
    ]);
    // 10:01 at -04:00 is 14:01Z, after the reply.
    expect(await ratedExchange(p, "2026-11-01T10:01:00-04:00")).toEqual({ input: "q", output: "a" });
  });

  test("the reply is every assistant text in the turn up to the rating, in order", async () => {
    const p = transcript([
      human("2026-11-01T10:00:00Z", "q"),
      reply("2026-11-01T10:00:05Z", "Looking at the logs first."),
      toolUse("2026-11-01T10:00:06Z"),
      toolResult("2026-11-01T10:00:07Z"),
      reply("2026-11-01T10:00:09Z", "Found it: the cron never ran."),
    ]);
    expect((await ratedExchange(p, "2026-11-01T10:01:00Z"))?.output).toBe("Looking at the logs first.\n\nFound it: the cron never ran.");
  });

  test("a long turn keeps its end, which is what was on screen", async () => {
    const p = transcript([
      human("2026-11-01T10:00:00Z", "q"),
      reply("2026-11-01T10:00:05Z", "A".repeat(5000)),
      reply("2026-11-01T10:00:09Z", "FINAL SUMMARY"),
    ]);
    const out = (await ratedExchange(p, "2026-11-01T10:01:00Z"))!.output;
    expect(out.endsWith("FINAL SUMMARY")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(MAX_REPLY_CHARS + 1);
  });

  test("credentials are redacted from both sides before anything leaves the machine", async () => {
    // Assembled at runtime so the repo's pre-commit secret scan never sees a literal credential.
    const fake = {
      anthropic: ["sk", "ant", "api03", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"].join("-"),
      google: "AIza" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q",
      github: "ghp" + "_" + "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
      pemBody: "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
      oauth: "ya29" + ".a0AfH6SMBx-example-token-value",
      password: "hunter2" + "hunter2",
    };
    const pem = `${["-----BEGIN", "PRIVATE", "KEY-----"].join(" ")}\n${fake.pemBody}\n${["-----END", "PRIVATE", "KEY-----"].join(" ")}`;
    const p = transcript([
      human("2026-11-01T10:00:00Z", `use key ${fake.anthropic} and ${fake.google}`),
      reply("2026-11-01T10:00:05Z", `token ${fake.github} then ${pem} and Authorization: Bearer ${fake.oauth} and ${"pass" + "word"}=${fake.password} at commit 7da55ec0123456789abcdef0123456789abcdef0`),
    ]);
    const ex = (await ratedExchange(p, "2026-11-01T10:01:00Z"))!;
    for (const secret of Object.values(fake)) expect(ex.input + ex.output).not.toContain(secret);
    expect(ex.input).toContain("[REDACTED]");
    expect(ex.output).toContain("7da55ec0123456789abcdef0123456789abcdef0");
  });

  test("no reply before the rating means no exchange", async () => {
    const p = transcript([human("2026-11-01T10:00:00Z", "q"), reply("2026-11-01T10:00:05Z", "a")]);
    expect(await ratedExchange(p, "2026-11-01T09:00:00Z")).toBeNull();
  });

  test("malformed lines are skipped, not fatal", async () => {
    const p = join(dir, "s.jsonl");
    writeFileSync(p, [JSON.stringify(human("2026-11-01T10:00:00Z", "q")), "{not json", JSON.stringify(reply("2026-11-01T10:00:05Z", "a"))].join("\n"));
    expect(await ratedExchange(p, "2026-11-01T10:01:00Z")).toEqual({ input: "q", output: "a" });
  });
});

describe("findTranscript (#324)", () => {
  test("finds <root>/<project>/<session>.jsonl under any project directory", () => {
    mkdirSync(join(dir, "projects", "-Users-x-proj"), { recursive: true });
    writeFileSync(join(dir, "projects", "-Users-x-proj", "abc.jsonl"), "");
    expect(findTranscript("abc", [join(dir, "projects")])).toBe(join(dir, "projects", "-Users-x-proj", "abc.jsonl"));
  });

  test("a session id that is not a plain identifier is never resolved to a path", () => {
    mkdirSync(join(dir, "projects", "p"), { recursive: true });
    writeFileSync(join(dir, "secret.jsonl"), "");
    expect(findTranscript("../../secret", [join(dir, "projects")])).toBeNull();
  });

  test("missing everywhere means null", () => {
    expect(findTranscript("nope", [join(dir, "projects")])).toBeNull();
  });
});
