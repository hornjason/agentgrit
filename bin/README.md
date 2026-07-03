# bin/

CLI entry point and command modules. The CLI dispatches to 13 subcommands, each in its own file.

## Entry Point

`agentgrit.ts` is the main CLI dispatcher. It:

1. Defines a `COMMANDS` map linking command names to their module paths and descriptions
2. Parses `process.argv` to extract the command name and arguments
3. Lazy-loads the command module via dynamic `import()`
4. Calls the exported handler function (`{command}Command` or `default`)

### Global Options

| Flag | Description |
|------|-------------|
| `--help`, `-h` | Show usage with all commands |
| `--version`, `-v` | Print version (currently `0.1.0`) |

## Commands

### `init` — Interactive Setup

Creates the `~/.agentgrit/` directory structure, copies the starter rubric, and writes config.

**Flags:**
- `--quick` — skip prompts, use Quick Start preset
- `--standard` — skip prompts, use Standard preset
- `--full` — skip prompts, use Full Auto preset

**Interactive flow (no flag):**
1. Asks adoption speed (1/2/3)
2. If standard or full: asks for judge API key (or press enter to use env var)
3. Creates directories: `signals/`, `state/`, `rubrics/`
4. Copies `rubrics/starter.json`
5. Writes `config.json` with the selected preset

**Output:**
```
agentgrit init

  directory: /Users/you/.agentgrit

Adoption speed:

  1. quick    — zero API keys, manual review only
  2. standard — one API key, LLM judge + graph
  3. full     — daemon + optimizer + Langfuse

Choose [1/2/3] (default: 1): 1

  ✓ Directory structure created
  ✓ Starter rubric copied
  ✓ Config written (quick mode)

Setup complete. Run 'agentgrit status' to verify.
```

### `inbox` — Review Pending Rule Candidates

Scans signals for patterns (using threshold 3, lower than daemon default) and displays them with routing rationale.

**Output:**
```
agentgrit inbox

  3 pending candidate(s):

─── Candidate 1 ───
  Type:     failure
  Freq:     12 occurrences across 5 sessions
  Severity: 8/10
  Rule:     Recurring correction (12x): stop doing...; that's wrong...
  Tier:     global
  Reason:   Multi-project (3) behavioral pattern: 5 behavioral vs 1 procedural keywords
  First:    2026-06-15T10:00:00Z
  Last:     2026-07-01T14:30:00Z

Use 'agentgrit rules promote' to promote candidates.
Use 'agentgrit undo' to reverse recent promotions.
```

### `status` — System Overview

Shows signal counts, score trends, and rule budget utilization.

### `doctor` — Health Diagnostics

Runs five-section health check (capture, scoring, graph, rules, signals). See `src/daemon/doctor.ts` for details on what each section checks.

### `rules` — Rule Management

Subcommands for listing, rebalancing, and compacting rules across tiers.

### `eval` — Trace Evaluation

Score traces, sessions, or recall accuracy against rubrics.

### `optimize` — Hill-Climbing

Run prompt or skill optimization for a target dimension.

### `graph` — Knowledge Graph

Build, query, or inspect the knowledge graph.

### `review` — Manual Weekly Review

Run the weekly learning review cycle manually (same as what the daemon runs on the configured weekly day).

### `signals` — Signal Management

Check signal file sizes and trigger rotation for oversized files.

### `undo` — Promotion Rollback

Reverse recent rule promotions using the promotion ledger.

### `export` — Portable Export

Export graph, rules, and rubrics for migration to another machine.

### `upgrade` — Switch Adoption Speed

Change between quick, standard, and full auto modes.

## Command Module Convention

Each command file exports a handler function named `{command}Command`:

```typescript
// bin/commands/status.ts
export async function statusCommand(args: string[]): Promise<void> {
  // ...
}
```

The dispatcher resolves the handler by checking for `mod[handlerName]` first, falling back to `mod.default`.

## Data Flow

```
User runs CLI
    │
    └→ bin/agentgrit.ts (dispatcher)
        │
        ├→ bin/commands/init.ts     → creates ~/.agentgrit/ + config.json
        ├→ bin/commands/inbox.ts    → reads signals → detect/failures + detect/patterns → display
        ├→ bin/commands/status.ts   → reads signals + state → summary
        ├→ bin/commands/doctor.ts   → daemon/doctor.ts → report
        ├→ bin/commands/rules.ts    → promote/router + promote/budget → management
        ├→ bin/commands/eval.ts     → evaluate/judge + evaluate/rubric → scores
        ├→ bin/commands/optimize.ts → optimize/hill-climb + optimize/prompt-tuner → results
        ├→ bin/commands/graph.ts    → graph/builder + graph/query → graph ops
        ├→ bin/commands/review.ts   → promote/review → synthesis
        ├→ bin/commands/signals.ts  → adapters/jsonl → rotation
        ├→ bin/commands/undo.ts     → promote/ledger → rollback
        ├→ bin/commands/export.ts   → state + rules + rubrics → portable JSON
        └→ bin/commands/upgrade.ts  → config.json → speed switch
```
