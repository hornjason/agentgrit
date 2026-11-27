/**
 * human-prompt.ts — was this prompt typed by the human? (#331)
 *
 * Capture records the human's signal. `UserPromptSubmit` also fires for prompts
 * no human typed — background task notifications, messages from other
 * sessions, teammate and agent messages, delivery notices, `/loop` and
 * scheduled iterations — and transcripts hold the same text as user-role
 * entries, plus compaction summaries. Every capture read all of it as the
 * human's: on the owner's install 0 of 107 thumbs rows were typed by the human,
 * and 71% of sentiment.jsonl came from task notifications.
 *
 * Every capture that reads user text asks this one question first.
 *
 * Origin first: transcript entries carry `origin.kind` ("human",
 * "task-notification", "peer", "coordinator", ...). The UserPromptSubmit hook
 * payload documents no origin field, so when it is absent the decision falls
 * back to the wrappers machine prompts arrive in. The patterns are the shapes
 * observed at the start of real prompts in sentiment.jsonl and in transcripts.
 */

const MACHINE_PROMPT = new RegExp(
  "^\\s*(?:" +
    [
      // Wrappers as the hook receives them (the tag is the first thing in `prompt`).
      "<(?:task-notification|cross-session-message|teammate-message|agent-message)\\b",
      "\\[Cross-session (?:delivery|idle) notice\\]",
      // A /loop iteration re-submits the /loop line; it is an instruction, never a reaction.
      "/loop\\b",
      // The same messages as transcripts record them.
      "Another Claude session sent a message:",
      "The coordinator sent a message while you were working:",
      "This session is being continued from a previous conversation",
    ].join("|") +
    ")",
);

export function isHumanPrompt(text: string, origin?: unknown): boolean {
  const kind = (origin as { kind?: unknown } | null | undefined)?.kind;
  if (typeof kind === "string") return kind === "human";
  return !MACHINE_PROMPT.test(text);
}
