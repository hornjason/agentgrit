/**
 * #331 — capture records only what the human typed.
 *
 * `UserPromptSubmit` fires for prompts no human typed: task notifications,
 * cross-session (peer) messages, teammate/agent messages, delivery notices and
 * `/loop` iterations. Every capture read that text as the human's. Measured on
 * the owner's install: 107 thumbs rows, 0 typed by the human; 71% of
 * sentiment.jsonl came from task notifications.
 *
 * The wrapper fixtures below are the shapes found at the START of real
 * `prompt` values in sentiment.jsonl (which stores the first 100 chars of every
 * UserPromptSubmit prompt): `<task-notification>`, `<cross-session-message`,
 * `<agent-message`, `[Cross-session delivery notice]`, `/loop`. The hook payload
 * carries no origin field (code.claude.com/docs/en/hooks#userpromptsubmit-input),
 * so the hook path has to recognise the wrappers. Transcripts do carry
 * `origin.kind`, and the transcript path is tested against it.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { parseThumbsRating } from "../../src/capture/rating";
import { extractDebrief } from "../../src/capture/debrief";
import { detectCorrection } from "../../src/capture/corrections";

const TMP_DIR = join(import.meta.dir, ".tmp-human-prompt");
const BIN = join(import.meta.dir, "../../bin/agentgrit.ts");

let savedDir: string | undefined;

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
  savedDir = process.env.AGENTGRIT_DIR;
  process.env.AGENTGRIT_DIR = TMP_DIR;
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  if (savedDir === undefined) delete process.env.AGENTGRIT_DIR;
  else process.env.AGENTGRIT_DIR = savedDir;
});

async function runCapture(sub: string, prompt: string): Promise<number> {
  const payload = JSON.stringify({
    session_id: "sess-331",
    transcript_path: "/Users/test/.claude/projects/x/sess-331.jsonl",
    cwd: "/Users/test/Projects/agentgrit",
    prompt_id: "19f5ba21-32a5-42ff-b761-4b4433e40d51",
    permission_mode: "bypassPermissions",
    hook_event_name: "UserPromptSubmit",
    prompt,
  });
  const proc = Bun.spawn(["bun", BIN, "capture", sub], {
    stdin: new Blob([payload]),
    stdout: "pipe",
    stderr: "pipe",
    // Gemini with no key fails at once, so sentiment falls back to keywords
    // offline instead of calling a model.
    env: { ...process.env, AGENTGRIT_DIR: TMP_DIR, AGENTGRIT_PROVIDER: "gemini", GEMINI_API_KEY: "" },
  });
  return proc.exited;
}

function rows(file: string): Record<string, unknown>[] {
  const path = join(TMP_DIR, "signals", file);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const TASK_NOTIFICATION_PLUS_ONE = [
  "<task-notification>",
  "<task-id>bdsvxlzrp</task-id>",
  "<status>completed</status>",
  '<summary>Agent "triage" completed</summary>',
  "<result>Closed 4 duplicates (+1 more pending review).</result>",
  "</task-notification>",
].join("\n");

const MACHINE_PROMPTS: [string, string][] = [
  ["task notification", TASK_NOTIFICATION_PLUS_ONE],
  ["peer message", '<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="peer">CI is -1 on lint.</cross-session-message>'],
  ["teammate message", '<teammate-message teammate_id="team-lead" summary="x">+1, merge it</teammate-message>'],
  ["agent message", '<agent-message from="builder">+1 shipped</agent-message>'],
  ["delivery notice", "[Cross-session delivery notice] peer refused: -1"],
  ["/loop iteration", "/loop Keep the board moving; fix the N+1 query each pass"],
];

describe("#331 hook capture ignores prompts no human typed", () => {
  test.each(MACHINE_PROMPTS)("%s containing +1/-1 writes no rating", async (_kind, prompt) => {
    expect(await runCapture("rating", prompt)).toBe(0);
    expect(rows("ratings.jsonl")).toHaveLength(0);
  });

  // The +1/-1 case above is also stopped by the standalone-reaction rule. A 👍
  // matches anywhere in the text, so only the human-typed gate can stop this one.
  test.each(MACHINE_PROMPTS)("%s containing 👍 writes no rating", async (_kind, prompt) => {
    expect(await runCapture("rating", `${prompt} 👍`)).toBe(0);
    expect(rows("ratings.jsonl")).toHaveLength(0);
  });

  test("task notification writes no sentiment row", async () => {
    expect(await runCapture("sentiment", TASK_NOTIFICATION_PLUS_ONE)).toBe(0);
    expect(rows("sentiment.jsonl")).toHaveLength(0);
  });

  test("human prompt still writes a sentiment row (gate is not a blanket drop)", async () => {
    expect(await runCapture("sentiment", "thanks, that works")).toBe(0);
    expect(rows("sentiment.jsonl")).toHaveLength(1);
  });

  test("pasted text counts: the human submitted it, even when it holds a wrapper", async () => {
    const pasted = '<pasted_content id="p1">\n<task-notification>log</task-notification>\n</pasted_content id="p1">\n👍';
    expect(await runCapture("rating", pasted)).toBe(0);
    expect(rows("ratings.jsonl").map((r) => r.rating)).toEqual([9]);
  });
});

describe("#331 +1 / -1 count only as a short standalone reaction", () => {
  test("typed code containing slice(0, -1) writes no rating", async () => {
    await runCapture("rating", "why does args.slice(0, -1) drop the last arg?");
    expect(rows("ratings.jsonl")).toHaveLength(0);
  });

  test("typed +1 inside a working prompt writes no rating", async () => {
    await runCapture("rating", "bump the retry counter by +1 and rerun");
    expect(rows("ratings.jsonl")).toHaveLength(0);
  });

  test("typed 👍 writes thumbs 9", async () => {
    await runCapture("rating", "👍");
    const r = rows("ratings.jsonl");
    expect(r).toHaveLength(1);
    expect(r[0].source).toBe("thumbs");
    expect(r[0].rating).toBe(9);
  });

  test("typed -1 alone writes thumbs 2", async () => {
    await runCapture("rating", "-1");
    const r = rows("ratings.jsonl");
    expect(r).toHaveLength(1);
    expect(r[0].source).toBe("thumbs");
    expect(r[0].rating).toBe(2);
  });

  test("parseThumbsRating: embedded tokens are not reactions", () => {
    for (const text of [
      "args.slice(0, -1)",
      "if (at === -1) return",
      "fix the N+1 query",
      "CI [−13.2, +1.9]",
      "set retries to -1",
    ]) {
      expect(parseThumbsRating(text)).toBeNull();
    }
  });

  test("parseThumbsRating: short standalone reactions still count", () => {
    expect(parseThumbsRating("+1")?.score).toBe(9);
    expect(parseThumbsRating("+1 nice work")?.score).toBe(9);
    expect(parseThumbsRating("-1")?.score).toBe(2);
    expect(parseThumbsRating("-1, wrong file")?.score).toBe(2);
  });
});

describe("#331 transcript capture ignores user-role text no human typed", () => {
  const line = (o: Record<string, unknown>) => JSON.stringify(o);
  const assistant = line({ type: "assistant", message: { role: "assistant", content: "Done." } });

  const transcript = [
    line({ type: "user", origin: { kind: "human" }, message: { role: "user", content: "that's wrong, revert it" } }),
    assistant,
    // Older transcripts have no origin field; a plain typed prompt must still count.
    line({ type: "user", message: { role: "user", content: "stop doing that, it is incorrect" } }),
    assistant,
    line({
      type: "user",
      origin: { kind: "task-notification", producer: "session-task" },
      message: { role: "user", content: "<task-notification>\n<result>That's wrong: stop the deploy.</result>\n</task-notification>" },
    }),
    assistant,
    line({
      type: "user",
      origin: { kind: "peer" },
      message: { role: "user", content: 'Another Claude session sent a message: <cross-session-message from="x">That is incorrect, stop.</cross-session-message>' },
    }),
    assistant,
    line({
      type: "user",
      origin: { kind: "coordinator" },
      message: { role: "user", content: "The coordinator sent a message while you were working: STOP rerunning, that's wrong." },
    }),
    assistant,
    line({
      type: "user",
      isCompactSummary: true,
      message: { role: "user", content: "This session is being continued from a previous conversation. The user said: that's wrong, stop." },
    }),
    assistant,
    // Origin missing AND a wrapper: the text fallback must still catch it.
    line({ type: "user", message: { role: "user", content: "<task-notification>\n<result>incorrect, stop</result>\n</task-notification>" } }),
    assistant,
    // How transcripts record a /loop line: no origin field at all.
    line({
      type: "user",
      message: {
        role: "user",
        content: "<command-message>loop</command-message>\n<command-name>/loop</command-name>\n<command-args>stop when the board is wrong</command-args>",
      },
    }),
    assistant,
  ].join("\n");

  test("task notification, peer, coordinator and compaction text yield no correction", async () => {
    const result = await extractDebrief(transcript, "sess-331");
    expect(result.corrections.map((c) => c.correction_phrase)).toEqual([
      "that's wrong, revert it",
      "stop doing that, it is incorrect",
    ]);
  });

  test("detectCorrection ignores a task notification with correction language", async () => {
    const signal = await detectCorrection(
      "<task-notification>\n<result>That's wrong: stop the deploy.</result>\n</task-notification>",
      "",
      "sess-331",
    );
    expect(signal).toBeNull();
    expect(rows("corrections.jsonl")).toHaveLength(0);
  });

  test("detectCorrection still records a typed correction", async () => {
    expect(await detectCorrection("that's wrong, revert it", "", "sess-331")).not.toBeNull();
  });
});
