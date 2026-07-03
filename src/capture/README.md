# capture/

Signal capture module. Hooks fire during Claude Code sessions to collect structured signals about session quality into JSONL files. No manual intervention required — signals flow in automatically from user interactions.

## What Signals Are Captured

| Signal | File | Source | Module |
|--------|------|--------|--------|
| Explicit rating | `ratings.jsonl` | User types `/rate M:N S:N Q:N` | `rating.ts` |
| Keyword sentiment | (embedded in rating) | Positive/negative keyword scan of rating comment | `rating.ts` |
| Correction | `corrections.jsonl` | Regex detects correction language in user messages | `corrections.ts` |
| Skill invocation | `skills.jsonl` | Logged when a skill fires (or should have) | `skills.ts` |
| Tool usage | `tool-audit.jsonl` | Logged on every tool call | `tool-audit.ts` |
| Debrief | (triggers rule extraction) | Session-end rule extraction | `debrief.ts` |

## How Each Hook Works

### rating.ts — Explicit Ratings + Sentiment

**When it fires:** On every `UserPromptSubmit` event. The hook checks if the user message matches `/rate M:N S:N Q:N` (case-insensitive, with optional trailing comment).

**What it writes:** A `RatingSignal` to `ratings.jsonl`:

```jsonl
{"id":"550e8400-...","type":"rating","timestamp":"2026-07-03T10:15:00Z","sessionId":"abc-123","schemaVersion":1,"rating":7.3,"source":"explicit","comment":"good session","sentimentSummary":"Positive sentiment (1 positive keyword)","confidence":0.65}
```

**Rating composite:** `mode * 0.34 + scope * 0.33 + quality * 0.33`, rounded to one decimal.

**Sentiment scoring:** The comment (if provided) is scanned against two keyword sets:
- **Positive** (19 keywords): "excellent", "amazing", "brilliant", "fantastic", "perfect", "great", "nailed it", "well done", etc.
- **Negative** (16 keywords): "wrong", "broken", "terrible", "frustrated", "useless", "disappointed", "fail", etc.

Two-word phrases are also checked ("love it", "good job"). If positive keywords outnumber negative, sentiment is positive. Confidence scales with keyword count: `min(0.5 + count * 0.15, 0.95)`. If no keywords match, sentiment is `null` (not stored).

All values (mode, scope, quality) must be 1-10 or the signal is discarded.

### corrections.ts — Correction Language Detection

**When it fires:** On every `UserPromptSubmit` event.

**What it writes:** A `CorrectionSignal` to `corrections.jsonl`:

```jsonl
{"id":"...","type":"correction","timestamp":"...","sessionId":"...","schemaVersion":1,"trigger":"stop doing that","context":"User: stop doing that\nAssistant: I'll adjust...","severity":7}
```

**12 regex patterns with assigned severities:**

| Pattern | Severity | Example |
|---------|----------|---------|
| `no, not like that` | 7 | "No, not like that — use the other approach" |
| `stop doing` | 8 | "Stop doing unnecessary refactoring" |
| `stop` (standalone) | 6 | "Stop" |
| `that's wrong` / `that's not what` | 7 | "That's not what I asked for" |
| `I didn't ask` | 8 | "I didn't ask for a full rewrite" |
| `don't do that` | 7 | "Don't do that again" |
| `wrong` (standalone) | 6 | "That's wrong" |
| `incorrect` | 6 | "That's incorrect" |
| `not right` / `not correct` | 5 | "That's not right" |
| `you missed` | 5 | "You missed a step" |
| `too much` | 4 | "Too much output" |
| `bad approach` | 7 | "That's a bad approach" |

**Noise filtering** prevents false positives. 10 patterns are excluded: "no problem", "no worries", "no rush", "no need", "no thanks", "no big deal", "not yet", "not now", "stop by" (as in visit), "don't worry", "don't forget". If any noise pattern matches, the message is skipped entirely before checking correction patterns.

**Context:** Stores the first 300 characters of the user message as `trigger` and the first 200 characters each of user + assistant messages as `context`.

### skills.ts — Skill Invocation Logging

**When it fires:** On `PostToolUse` events matching the `Skill` tool.

**What it writes:** A `SkillInvocationSignal` to `skills.jsonl` with skill name, trigger text, duration, and success/failure status.

### debrief.ts — Session-End Rule Extraction

**When it fires:** On `SessionEnd` events.

**What it does:** Extracts candidate rules from session corrections and patterns. These become inputs for the detect and promote pipelines.

### tool-audit.ts — Tool Usage Recording

**When it fires:** On every `PostToolUse` event (matcher: `.*`).

**What it writes:** Tool name, timing, and outcome to `tool-audit.jsonl`. This is the highest-volume signal file and may need rotation first.

## Hook Registration

`index.ts` exports `generateHookConfig()` which produces the Claude Code hook configuration to inject into `settings.json`:

```typescript
{
  hooks: {
    UserPromptSubmit: [
      { matcher: "", command: "npx agentgrit hook rating" },
      { matcher: "", command: "npx agentgrit hook correction" }
    ],
    PostToolUse: [
      { matcher: "Skill", command: "npx agentgrit hook skill-invocation" },
      { matcher: ".*", command: "npx agentgrit hook tool-audit" }
    ],
    SessionEnd: [
      { matcher: "", command: "npx agentgrit hook debrief" }
    ]
  }
}
```

## Signal Schema

Every signal extends the base `Signal` interface:

```typescript
interface Signal {
  id: string;           // UUID v4
  timestamp: string;    // ISO 8601
  sessionId: string;    // Claude Code session identifier
  schemaVersion: number; // Currently 1
}
```

Downstream consumers (detect, evaluate, daemon) filter by `type` field to cast to the correct signal subtype.

## Implicit vs. Explicit Signals

**Explicit:** The user actively rates (`/rate M:3 S:4 Q:5`). Optional — the system works without explicit ratings.

**Implicit:** Corrections and sentiment are detected from natural conversation. The user doesn't need to do anything special. Every user message is passively scanned for correction language.

Both signal types feed into the same detection and scoring pipelines. Explicit ratings provide stronger signal (numeric precision); implicit signals provide higher volume (every interaction).

## Data Flow

```
UserPromptSubmit → rating.ts      → signals/ratings.jsonl
UserPromptSubmit → corrections.ts → signals/corrections.jsonl
PostToolUse      → skills.ts      → signals/skills.jsonl
PostToolUse      → tool-audit.ts  → signals/tool-audit.jsonl
SessionEnd       → debrief.ts     → (rule extraction pipeline)
```
