# Bootstrap Spec — Claude Code Discovery & Signal Backfill

## Problem

AgentGrit needs data to work. New users have zero signal files. But every Claude Code user has session transcripts (JSONL) and possibly auto-memory files (markdown). Some users (PAI) have pre-structured signals. AgentGrit's `init` must discover what exists, extract what it can, install hooks for ongoing capture, and present findings for user confirmation.

## Discovery Chain

### Step 1: Locate Claude Code Installation

Claude Code home is always `~/.claude/`. Hardcoded — no env var override.

Verify by checking for `~/.claude.json` (infrastructure config, created on first run).

### Step 2: Discover All Projects

Read `~/.claude.json`:

```
projects: {
  "/Users/jhorn/.claude": { hasTrustDialogAccepted: true, ... },
  "/path/to/other/project": { ... }
}
```

Each key is a filesystem path where Claude Code has been opened. Also check:

```
githubRepoPaths: {
  "owner/repo": ["/filesystem/path"]
}
```

This maps GitHub repos to local paths — useful for displaying project names.

### Step 3: Scan Rule Files (Budget Baseline)

Claude Code loads rules from 5 locations per project:

| Priority | Path | Scope |
|----------|------|-------|
| 1 | `~/.claude/CLAUDE.md` | Global |
| 2 | `~/.claude/rules/*.md` | Global rules dir |
| 3 | `{project}/.claude/CLAUDE.md` | Project (committed) |
| 4 | `{project}/.claude/rules/*.md` | Project rules dir |
| 5 | `{project}/CLAUDE.md` | Project root |

For each project path from Step 2, check all 5 locations. Count rules (line-based heuristic: lines starting with `- **` or `- ` under a `## Rules` or `### Critical Rules` header).

This establishes the budget baseline — how many rules already exist before AgentGrit starts promoting new ones.

### Step 4: Detect Existing Signal Sources

Check for pre-structured signals (PAI or similar):

```
~/.claude/MEMORY/LEARNING/SIGNALS/    → PAI signals (ratings.jsonl, corrections.jsonl, etc.)
~/.agentgrit/signals/                 → Prior AgentGrit install
```

If PAI signals exist, AgentGrit should read from that location (not copy). Set `signalDir` in config to point there. If no pre-structured signals, AgentGrit creates `~/.agentgrit/signals/` and backfills from transcripts.

### Step 5: Inventory Session Transcripts

Session transcripts live at `~/.claude/projects/<encoded-path>/*.jsonl`.

Path encoding: filesystem path with `/` replaced by `-`, leading `/` becomes leading `-`.
- `/Users/jhorn/.claude` → `-Users-jhorn--claude`
- `/Users/jhorn` → `-Users-jhorn`

Each JSONL file is one session. Line types:
- `type: "user"` — user message, content is text or array of content blocks
- `type: "assistant"` — assistant response, content blocks include `text` and `tool_use`
- `type: "last-prompt"` — session metadata
- `type: "queue-operation"` — prompt queue events

Most transcripts are tiny (≤10 lines = aborted/empty sessions). Only transcripts >50 lines contain meaningful signal data.

### Step 6: Inventory Auto-Memory Files

Auto-memory lives at `~/.claude/projects/<encoded-path>/memory/*.md`.

These are markdown files written by Claude's built-in memory system (v2.1.59+). They contain:
- Feedback memories (user corrections → behavioral rules)
- User context (role, preferences, expertise)
- Project context (architecture, conventions, decisions)
- Reference pointers (external systems, URLs)

Not all projects have memory files. The built-in system writes sparingly.

### Step 7: Check Installed Hooks

Read `~/.claude/settings.json` → `hooks` object. Detect:
- Whether AgentGrit hooks are already installed (idempotent re-init)
- Whether other systems have hooks (ECC, Ruflo, claude-mem, etc.)
- Which hook events are already claimed (avoid conflicts)

## Signal Extraction from Transcripts

For each transcript >50 lines, extract:

### Ratings
Scan user messages for `/rate` or `M:\d S:\d Q:\d` patterns.
Extract: dimensions, composite score, session_id, timestamp.

### Corrections
Scan user messages that start with correction language: "no", "wrong", "stop", "don't", "not that", "fix this", "that broke", "undo", "revert".
Pair with preceding assistant response for context.
Filter noise: skip messages containing approval words ("no problem", "no worries", "not bad").

### Tool Usage
Scan assistant content blocks for `type: "tool_use"`.
Extract: tool name, count per session.
Categorize: Read/Write/Edit (file ops), Bash (shell), Agent (delegation), Skill (workflow), etc.

### Skill Invocations
Filter tool_use blocks where `name === "Skill"`.
Extract: skill name from `input.skill`, args, session_id.

### Skill Sequences
Per session: collect ordered list of Skill invocations.
Pair with session's final rating (if found).

### Sentiment
Classify user messages by tone:
- Negative: correction language, frustration markers
- Positive: approval words ("perfect", "great", "exactly", "yes")
- Neutral: everything else
Compute per-session sentiment score.

### Assertion Violations
Scan assistant text for unverified negative claims: "can't", "impossible", "not possible", "won't work", "doesn't support".

## Hook Installation

AgentGrit installs 7 hooks into `~/.claude/settings.json`:

| Hook | Event | What It Captures |
|------|-------|-----------------|
| Rating capture | UserPromptSubmit | `/rate M:N S:N Q:N` patterns → ratings.jsonl |
| Correction detection | UserPromptSubmit | Correction language → corrections.jsonl |
| Tool audit | PostToolUse | Every tool call → tool-audit.jsonl |
| Skill invocation | PostToolUse (matcher: Skill) | Skill name + args → skill-invocations.jsonl |
| Assertion audit | Stop | Unverified claims in response → assertion-violations.jsonl |
| Session summary | SessionEnd | Session stats → sessions.jsonl |
| Debrief | SessionEnd | Extract learnings → debrief output |

Hook format in settings.json:
```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "npx agentgrit capture rating",
            "timeout": 5000
          }
        ]
      }
    ]
  }
}
```

Hooks must be MERGED into existing settings.json, not overwrite. Read existing hooks, add AgentGrit hooks, write back.

## User Confirmation Flow

After discovery, present findings before acting:

```
agentgrit init

Scanning Claude Code installation...

  Claude Code home:  ~/.claude/
  Projects found:    3
    /Users/jhorn/.claude (2,987 sessions, 351 memory files)
    /Users/jhorn/.claude/PAI/Projects/DailyBriefDashboard (2,482 sessions)
    /Users/jhorn (3,140 sessions)

  Rule files found:
    ~/.claude/CLAUDE.md — 89 rules (253 lines)
    ~/.claude/PAI/Projects/DailyBriefDashboard/CLAUDE.md — 42 rules (256 lines)
    Total: 131 rules across 2 files

  Session transcripts: 8,705 total (71 with >100 messages)
  Auto-memory files:   351 markdown notes
  PAI signals:         DETECTED (618 ratings, 1059 corrections)

  Existing hooks:      16 (PAI system)

Options:
  1. Full bootstrap — backfill from transcripts + memory + PAI signals
  2. Quick start — install hooks only, start fresh
  3. PAI integration — point at existing PAI signals, no copy

Choose [1/2/3]:
```

## PAI Integration Mode

When PAI signals are detected at `~/.claude/MEMORY/LEARNING/SIGNALS/`:

- Set `signalDir` to that path (no copy, no sync problem)
- Skip transcript backfill for signal types that already exist
- Still scan auto-memory for graph building
- Still install AgentGrit hooks (they write to the same location)
- Detect PAI hooks already in settings.json — don't duplicate

## Output

After bootstrap completes:

```
~/.agentgrit/
  config.json          — signalDir, adapter, rules config
  signals/             — (or points to PAI signals)
    ratings.jsonl      — backfilled from transcripts
    corrections.jsonl  — backfilled from transcripts  
    tool-audit.jsonl   — backfilled from transcripts
    ...
  state/
    knowledge-graph.json  — built from memory files
    patterns.json         — detected from corrections
    rule-stats.json       — correlation tracking
  rubrics/
    starter.json       — default evaluation rubric
```

## Edge Cases

1. **No `~/.claude.json`** — Claude Code not installed. Error with install instructions.
2. **No transcripts** — brand new install. Install hooks, start fresh.
3. **Huge transcript directory** — 10K+ files. Show progress bar, skip files <10 lines.
4. **PAI signals exist but different schema** — version check. AgentGrit types.ts defines the schema; PAI signals that don't match get skipped with a warning.
5. **Other hook systems present** — warn but don't block. AgentGrit hooks coexist.
6. **Re-init** — detect existing `~/.agentgrit/`. Offer to merge or replace.
7. **Multiple Claude Code instances** — rare but possible (different user accounts). Scan only `~/.claude/` for current user.

## Success Criteria

- SC-1: `agentgrit init` discovers Claude Code home and all projects without user input
- SC-2: Rule count matches manual count across all CLAUDE.md + rules/ locations
- SC-3: Transcript scanner extracts ratings that match PAI's ratings.jsonl (for PAI users — cross-validation)
- SC-4: Transcript scanner extracts corrections that match PAI's corrections.jsonl
- SC-5: Hooks install into settings.json without breaking existing hooks
- SC-6: PAI integration mode reads signals in-place (no file duplication)
- SC-7: User sees discovery summary before any changes are made
- SC-8: Graph builds from auto-memory files (same as current `agentgrit graph build`)
