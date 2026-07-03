# adapters/

Data layer module. Shared types, JSONL storage with atomic writes, path resolution, and integrations with Claude Code and Langfuse.

## Shared Types Reference

`types.ts` defines every interface used across the system.

### Signals

| Interface | Description |
|-----------|-------------|
| `Signal` | Base: `id`, `timestamp`, `sessionId`, `schemaVersion` |
| `RatingSignal` | Explicit rating with composite score, source, comment, sentiment |
| `CorrectionSignal` | Correction detection with trigger text, context, severity (1-10) |
| `SentimentSignal` | Transcript-level sentiment with corrections/approvals/reprompts counts |
| `SkillInvocationSignal` | Skill name, trigger, duration, success/failure |
| `AnySignal` | Union of all signal types |

### Scoring

| Interface | Description |
|-----------|-------------|
| `Score` | Per-dimension score: traceId, dimension, value (1-5), rubric, judgeModel, reasoning |
| `Dimension` | Rubric dimension: name, description, weight (0-1), rubric criteria text |
| `RubricConfig` | Full rubric: version, schemaVersion, dimensions[], judgeModel |

### Rules

| Interface | Description |
|-----------|-------------|
| `Rule` | Full rule: id, text, tier, tags, created, correlationScore, sourceSignals, plus tracking stats |
| `Tier` | Enum: `Global`, `Project`, `Graph` |

### Patterns

| Interface | Description |
|-----------|-------------|
| `Pattern` | Detected pattern: id, type, frequency, sessions, severity, candidateRule, timestamps |

### Graph

| Interface | Description |
|-----------|-------------|
| `GraphNode` | Node: id, name, domains[], ruleText, hash, stats |
| `GraphNodeStats` | Activation stats: injectionCount, avgRating, high/lowRatingActivations, sessionRatings, lastSeen |
| `GraphEdge` | Edge: source, target, type, strength, edgeSource |
| `EdgeType` | 10 edge types: reinforces, sibling, same_domain, conflicts_with, etc. |
| `EdgeSource` | How the edge was created: inferred, explicit, manual, embedding |

### Trajectories

| Interface | Description |
|-----------|-------------|
| `Trajectory` | Episode: id, task, domains, summary, rating, steps, timestamp, agentId |

### Promotion

| Interface | Description |
|-----------|-------------|
| `PromotionRecord` | Ledger entry: ruleId, tier, timestamp, before/afterSnapshot, approved |

### Configuration

| Interface | Description |
|-----------|-------------|
| `AgentGritConfig` | Full config: signalDir, adapter, langfuse, judge, rubrics, rules (budgets + autoPromote), daemon (interval + weeklyDay) |

### Adapter Interfaces

| Interface | Description |
|-----------|-------------|
| `SignalReader` | `read(file, opts?)` — read signals with offset/limit |
| `SignalWriter` | `append(file, signal)` — append one signal |
| `SignalAdapter` | Combines reader + writer + `rotate(file, maxSizeBytes)` |

### Schema Version

`SCHEMA_VERSION` is exported as a constant (currently `1`). Every persisted record includes it. The CLI refuses to process unrecognized versions.

## JSONL Adapter

`jsonl.ts` handles all local file I/O for signal data.

### `appendSignal(file, signal)`

Appends one JSON line to a JSONL file. Uses atomic write: reads existing content, appends the new line, writes to a temp file (`{file}.tmp.{pid}`), then renames over the original. If the rename fails, the temp file is cleaned up.

The temp file includes the process PID to avoid collisions when multiple processes write simultaneously (e.g., daemon and hooks).

### `readSignals(file, opts?)`

Reads JSONL signals with optional `offset` and `limit` for pagination. Returns an empty array if the file doesn't exist. Skips malformed lines silently.

### `rotateFile(file, maxSizeBytes)`

Checks file size against the threshold. If exceeded:
1. Rename the file to `{file}.{timestamp}.bak`
2. Create a new empty file at the original path
3. Return `{ rotated: true, archivePath }` with the backup path

### `createJsonlAdapter()`

Factory function returning a `SignalAdapter` that wires `append`, `read`, and `rotate` together.

## Path Resolution

`paths.ts` resolves all file paths relative to a base directory.

### Base Directory

Determined by (in order):
1. `AGENTGRIT_DIR` environment variable
2. `~/.agentgrit` (default)

Tilde (`~`), `$HOME`, and `${HOME}` are all expanded to the home directory.

### Path Functions

| Function | Returns |
|----------|---------|
| `getBaseDir()` | Base directory (e.g., `/Users/you/.agentgrit`) |
| `signalsDir()` | `{base}/signals` |
| `stateDir()` | `{base}/state` |
| `rubricsDir()` | `{base}/rubrics` |
| `signalPath(filename)` | `{base}/signals/{filename}` |
| `statePath(filename)` | `{base}/state/{filename}` |
| `rubricPath(filename)` | `{base}/rubrics/{filename}` |
| `projectDir(workingDir?)` | `{base}/projects/{slug}` — slug derived from cwd |
| `projectSignalsDir(workingDir?)` | `{base}/projects/{slug}/signals` |
| `projectStateDir(workingDir?)` | `{base}/projects/{slug}/state` |

### Project Slugs

The working directory is converted to a slug by stripping the home directory prefix, replacing `/` with `-`, and removing non-alphanumeric characters (except `-` and `_`). This gives each project its own isolated signal and state directories.

## Claude Code Integration

`claude-code.ts` provides the integration layer with Claude Code.

### `generateHookConfig(hooks)`

Converts an array of `HookRegistration` objects into the Claude Code `settings.json` hook format, grouping by event type.

### `readClaudeMd(path)`

Reads a CLAUDE.md file. Returns `null` if it doesn't exist.

### `detectTier(filePath)`

Determines whether a CLAUDE.md path is the global file (`~/.claude/CLAUDE.md` = `Global` tier) or a project file (`Project` tier).

### `detectProject(workingDir?)`

Detects the current project name. Tries `package.json` name first, falls back to the directory basename.

### `findClaudeMdPath(workingDir?)`

Finds the nearest CLAUDE.md: checks the working directory first, then falls back to the global path (`~/.claude/CLAUDE.md`).

## Langfuse Adapter

`langfuse.ts` integrates with Langfuse for trace fetching and score syncing. Used when `adapter` is set to `"langfuse"` or `"both"` in config.

## Time Utilities

`time.ts` provides shared time formatting and parsing functions used across the system.

## Data Flow

```
All modules import from adapters/types.ts for interfaces
capture/* uses adapters/jsonl.ts for signal writes
capture/* uses adapters/paths.ts for file locations
promote/bridge.ts uses adapters/claude-code.ts for CLAUDE.md writes
daemon/daemon.ts uses adapters/langfuse.ts for score sync
```
