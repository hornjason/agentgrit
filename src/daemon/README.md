# daemon/

Background automation module. Runs the scoring, detection, promotion, and optimization pipeline on a schedule. Includes health diagnostics, cross-platform scheduler installation, and session lifecycle cleanup.

## Daemon Cycle

`daemon.ts` orchestrates two cycles: a 30-minute cycle for scoring and detection, and a weekly cycle for synthesis and graph maintenance.

### 30-Minute Cycle (`runDaemonCycle`)

Runs in sequence:

1. **Score** — If a judge API key is configured, loads each rubric, reads recent rating signals (up to 50), and scores any that have a `responsePreview` field against the rubric using the LLM judge. Results are collected as `Score[]`.

2. **Detect failures** — Runs `detectFailurePatterns()` from `detect/failures.ts` on the signals directory. Finds recurring correction patterns.

3. **Detect patterns** — Runs `minePatterns()` from `detect/patterns.ts`. Finds low-rated sessions with corrections, skill miss patterns, and score drops.

4. **Auto-reflection** — Reads `ratings.jsonl`, groups the scored signals by
   `session_id`, and appends one entry per session to
   `algorithm-reflections.jsonl` under `config.signalDir` via
   `auto-reflection.ts`. No LLM is involved and no API key is needed:
   `implied_sentiment` is the measured mean of the session's ratings. The
   session id is the idempotency key — any session already named in the file,
   whether by an earlier cycle or by an external LEARN phase, is skipped, so
   re-running the cycle over unchanged ratings appends nothing. The count of
   entries written this cycle lands on `CycleResult.reflectionsGenerated`.

   Ordered before **Optimize** on purpose: that step reads
   `algorithm-reflections.jsonl` for traces, so entries written here are
   visible to it within the same cycle.

5. **Promote** — For each detected pattern with frequency >= 3 and a candidate rule:
   - Routes through `routeRule()` to determine the tier
   - Checks budget via `checkBudget()`
   - If `autoPromote` is enabled and budget allows, counts the promotion
   - Skips if `OVER_BUDGET`

6. **Sync** — If the adapter is `"langfuse"` or `"both"`, dynamically imports the Langfuse adapter and pushes scores.

7. **Optimize** — Checks if any scores are <= 2 (critically low). If so, flags for hill-climbing optimization.

### CycleResult

```typescript
interface CycleResult {
  timestamp: string;
  scores: Score[];       // Scores produced this cycle
  patterns: Pattern[];   // Patterns detected this cycle
  promoted: number;      // Rules promoted (if autoPromote)
  reflectionsGenerated: number; // Reflection entries appended this cycle
  synced: boolean;       // Whether Langfuse sync succeeded
  optimized: boolean;    // Whether optimization was flagged
  errors: string[];      // Any errors (non-fatal, cycle continues)
}
```

Each step is wrapped in try/catch — a failure in one step doesn't prevent subsequent steps from running. Errors are collected and reported.

### Weekly Cycle (`runWeeklyReview`)

Runs on the configured day (default: Sunday). Checked via `isWeeklyDay()` which compares `new Date().getDay()` against the config.

1. **Full learning review** — runs `runReview()` from `promote/review.ts`, which clusters rating signals, identifies failure patterns, and proposes candidates
2. **Graph rebuild** — runs `buildGraph()` from `graph/builder.ts` for incremental graph reconstruction
3. **Budget check** — checks global and project tier budgets

### WeeklyReviewResult

```typescript
interface WeeklyReviewResult {
  timestamp: string;
  review: ReviewResult;
  graphRebuilt: boolean;
  budgetStatus: { global: string; project: string };
  errors: string[];
}
```

## Doctor Health Checks

`doctor.ts` inspects five sections of the system and reports status.

### `runDoctor(config)` Returns

```typescript
interface DoctorReport {
  timestamp: string;
  overall: CheckStatus;        // "ok", "warning", or "error"
  sections: DoctorSection[];   // One per subsystem
}
```

### Five Sections

**1. CAPTURE** — For each signal file (`ratings.jsonl`, `corrections.jsonl`, `sentiment.jsonl`, `skills.jsonl`):
- `warning` if file doesn't exist (no signals captured yet)
- `warning` if last modified > 14 days ago (hook may not be firing)
- `ok` if recently active

**2. SCORING** — Checks judge configuration and scores output:
- `warning` if no judge API key configured
- `ok` if key is present, shows provider/model
- `warning` if `scores.jsonl` doesn't exist or last modified > 2 hours ago

**3. GRAPH** — Checks knowledge graph freshness:
- `warning` if `knowledge-graph.json` doesn't exist
- `warning` if last rebuilt > 7 days ago
- Reports graph file size

**4. RULES** — Checks rule count against budget:
- `error` if count exceeds global budget
- `warning` if within 5 of the limit
- `ok` otherwise

**5. SIGNALS** — Checks JSONL file sizes:
- `error` if any file > 20MB (rotation needed urgently)
- `warning` if > 5MB (rotation recommended)
- `ok` otherwise

Overall status is the worst status across all sections.

## Scheduler

`scheduler.ts` generates and installs platform-specific daemon configuration.

### macOS (LaunchAgent)

Generates a plist at `~/Library/LaunchAgents/com.agentgrit.daemon.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.agentgrit.daemon</string>
    <key>ProgramArguments</key>
    <array>
      <string>agentgrit</string>
      <string>daemon</string>
      <string>run</string>
    </array>
    <key>StartInterval</key>
    <integer>1800</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>~/.agentgrit/daemon.log</string>
    <key>StandardErrorPath</key>
    <string>~/.agentgrit/daemon.err</string>
</dict>
</plist>
```

### Linux (systemd)

Generates two files in `~/.config/systemd/user/`:

**Service** (`com.agentgrit.daemon.service`):
```ini
[Unit]
Description=AgentGrit daemon cycle
After=network.target

[Service]
Type=oneshot
ExecStart=agentgrit daemon run

[Install]
WantedBy=default.target
```

**Timer** (`com.agentgrit.daemon.timer`):
```ini
[Unit]
Description=AgentGrit daemon timer

[Timer]
OnBootSec=30min
OnUnitActiveSec=30min
Persistent=true

[Install]
WantedBy=timers.target
```

### Interval Parsing

`parseIntervalSeconds()` handles `s` (seconds), `m` (minutes), `h` (hours). Default: 1800 seconds (30 minutes).

### Status Detection

`getSchedulerStatus()` reports `installed` from the filesystem and `registered`
from the platform scheduler. The two are separate readings and are allowed to
disagree — a unit or plist file on disk is not a scheduled job (#259, #275).

- **macOS**: `installed` is "the plist exists"; `registered` is `launchctl list <label>`
- **Linux**: `installed` is "both the `.service` and `.timer` exist";
  `registered` is `systemctl --user is-enabled <label>.timer`

`checkSchedulerRegistered()` names the disagreement:

| State | Status |
|---|---|
| Nothing on disk, nothing registered | `missing-scheduler` |
| Plist on disk, launchd has not loaded it | `plist-not-loaded` |
| Unit files on disk, timer not enabled | `timer-not-enabled` |
| Registered, but the log has gone stale | `stale` |
| The registry could not be reached at all | `probe-failed` |

`probe-failed` is what a container with no systemd user session gets: the
probe reads the state word `systemctl is-enabled` prints, and a D-Bus failure
prints none, so "cannot tell" is reported as a failure rather than guessed
either way. `agentgrit daemon status` exits non-zero there, deliberately.

Paths are overridable per call (`launchAgentDir`, `systemdDir`, `logDir`,
`label`); under `NODE_ENV=test` every one left at its real value is refused,
because each reaches the host on its own.

## Session Cleanup

`cleanup.ts` handles housekeeping.

### `cleanupSession(signalDir, stateDir)`

Removes stale files:
- **Session state files** (`current-work-*`): deleted if > 30 days old
- **Temporary/backup files** (`.tmp`, `.bak`): deleted if > 7 days old

### `rotateSignals(signalDir, maxSizeMB?)`

Scans all `.jsonl` files in the signals directory. Rotates any that exceed the size threshold (default: 10MB) using `rotateFile()` from the JSONL adapter.

Returns the count of files rotated.

## Data Flow

```
daemon/daemon.ts orchestrates:
  → evaluate/judge.ts (score)
  → detect/failures.ts + detect/patterns.ts (detect)
  → daemon/auto-reflection.ts (signals/algorithm-reflections.jsonl)
  → promote/router.ts + promote/budget.ts (promote)
  → adapters/langfuse.ts (sync)
  → optimize/* (flag for optimization)

daemon/doctor.ts reads:
  → signals/*.jsonl (file ages and sizes)
  → state/knowledge-graph.json (freshness)
  → state/scores.jsonl (scoring activity)

daemon/scheduler.ts writes:
  → ~/Library/LaunchAgents/com.agentgrit.daemon.plist (macOS)
  → ~/.config/systemd/user/com.agentgrit.daemon.{service,timer} (Linux)

daemon/cleanup.ts manages:
  → state/current-work-* (stale session state)
  → state/*.tmp, *.bak (temporary files)
  → signals/*.jsonl (rotation)
```
