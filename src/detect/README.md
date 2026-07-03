# detect/

Pattern detection module. Scans captured signals for recurring failure patterns, correlates low scores with specific behaviors, and stores successful episodes for contextual retrieval.

## How Failure Patterns Are Detected

`failures.ts` reads `corrections.jsonl` and groups correction signals by keyword similarity.

### Algorithm

1. **Tokenize** each correction's trigger + context: lowercase, strip non-alphanumeric, filter words shorter than 3 characters
2. **Group by similarity** using Jaccard coefficient (intersection / union of token sets). Threshold: 0.3. Each new correction is compared to existing groups; if similarity exceeds the threshold, it joins that group (tokens merge into the group). Otherwise, a new group is created.
3. **Filter by frequency**: only groups with >= `threshold` occurrences (default: 5) become patterns
4. **Build candidate rule text** from the first 3 triggers in each group (80 chars each), prefixed with occurrence count
5. **Sort by frequency** descending

### Output

```typescript
interface Pattern {
  id: string;           // e.g., "fail-abc12345-0"
  type: string;         // "failure"
  frequency: number;    // How many corrections in this group
  sessions: string[];   // Unique session IDs where this pattern appeared
  severity: number;     // Max severity across all corrections in the group
  candidateRule: string; // Generated rule text from triggers
  firstSeen: string;    // Earliest correction timestamp
  lastSeen: string;     // Most recent correction timestamp
}
```

### Configurable Threshold

The threshold (default 5) controls noise filtering. A pattern must appear in at least `threshold` correction signals before it surfaces as a candidate. Lower it for less data (e.g., the inbox command uses threshold 3); raise it for more established systems. Pass as the second argument to `detectFailurePatterns()`.

## Cross-Signal Pattern Mining

`patterns.ts` builds per-session snapshots combining ratings, corrections, and skill invocations, then looks for three pattern types.

### Session Snapshots

For each session ID, the miner collects:
- All rating signals (computes average)
- All correction signals
- All failed skill invocations (`success === false`)

### Pattern Types

**1. Low-rated sessions with corrections**
Sessions with average rating <= 4.0 AND at least one correction signal. If 2+ such sessions exist, a pattern is generated. Severity comes from the max correction severity across all matching sessions.

**2. Skill miss patterns**
Skills that failed (`success === false`) across 2+ sessions. Each unique skill name gets its own pattern with the total failure count and affected session list. Severity is fixed at 5.

**3. Score drops**
Requires at least 4 sessions with ratings. Compares the average rating of the first N sessions against the last N sessions (N = min(sessions/2, 5)). If the drop is >= 1.5 points, a pattern is generated with severity 7.

All patterns are sorted by severity descending.

## Trajectories

`trajectories.ts` stores "what worked" — episodes from high-rated sessions.

### What Gets Stored

```typescript
interface Trajectory {
  id: string;
  task: string;        // What was accomplished
  domains: string[];   // Domain tags for retrieval
  summary: string;     // How it was done
  rating: number;      // Session rating
  steps?: string[];    // Optional step-by-step breakdown
  timestamp: string;
  agentId?: string;    // Which agent executed this
}
```

### Storage and Eviction

Trajectories are stored in `trajectories.json` (full JSON, not JSONL). The store is capped at **100 entries**. When full, trajectories are sorted by rating ascending and the lowest-rated entry is evicted.

### Querying

`queryTrajectories(domains, signalDir, limit)` retrieves the most relevant trajectories:
1. Compute domain overlap (Jaccard) between query domains and each trajectory's domains
2. Filter out trajectories with zero overlap (unless no domains specified — then all match)
3. Sort by overlap score, then by rating as tiebreaker
4. Return top `limit` (default: 5)

### Garbage Collection

`gcTrajectories()` enforces the 100-entry cap by sorting and evicting the lowest-rated entries. Called by the daemon's cleanup cycle.

## Theme Cohorts

`theme-cohorts.ts` groups rules by thematic similarity for ablation testing and shortcut detection. Used by the weekly review to identify rule clusters that may be redundant or conflicting.

## Data Flow

```
signals/corrections.jsonl → detect/failures.ts   → Pattern[] → promote/router.ts
signals/ratings.jsonl     ─┐
signals/corrections.jsonl ─┤→ detect/patterns.ts → Pattern[] → promote/router.ts
signals/skills.jsonl      ─┘
(high-rated sessions)      → detect/trajectories.ts → trajectories.json → graph/context.ts
```
