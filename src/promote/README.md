# promote/

Rule management module. Detected patterns become candidate rules. The router determines where each rule lives. The bridge writes rules atomically to CLAUDE.md. The ledger tracks every promotion for undo.

## Three-Tier Routing Logic

`router.ts` classifies each pattern into one of three tiers based on two signals: how many projects the pattern appeared in, and whether the rule text is behavioral or procedural.

### Decision Tree

```
Pattern detected
    │
    ├─ Appeared in 0-1 projects?
    │   └─→ PROJECT tier (that project's CLAUDE.md)
    │
    └─ Appeared in 2+ projects?
        │
        ├─ More behavioral keywords?
        │   └─→ GLOBAL tier (~/.claude/CLAUDE.md)
        │
        └─ More procedural keywords?
            └─→ GRAPH tier (knowledge-graph.json)
```

### Keyword Classification

The router counts keyword matches in two sets:

**Behavioral** (17 keywords): verify, read, check, confirm, validate, test, before, always, never, must, surgical, evidence, ask, first, ensure, review, inspect

**Procedural** (17 keywords): run, spawn, invoke, execute, after, when, trigger, fire, launch, call, deploy, rebuild, use, apply, switch, route, queue

The set with more matches determines the tier. If tied, the pattern goes to GRAPH (procedural default).

### RouteResult

```typescript
interface RouteResult {
  tier: Tier;        // "global" | "project" | "graph"
  rationale: string; // Human-readable explanation
}
```

## Rule Tracking and Correlation

`rules.ts` tracks how each rule correlates with session quality.

### What's Tracked Per Rule

```typescript
interface RuleStats {
  ruleId: string;
  injectionCount: number;        // How many times this rule was injected
  avgCorrelatedRating: number;   // Average rating in sessions where this rule was active
  sessionRatings: number[];      // Sliding window of last 20 session ratings
  highRatingActivations: number; // Sessions with rating >= 7 where this rule was active
  lowRatingActivations: number;  // Sessions with rating <= 4 where this rule was active
  lastSeen: string;              // ISO timestamp of last injection
}
```

### `trackRule(rule, sessionRating)`

Updates a rule's stats after a session:
- Increments `injectionCount`
- Appends to `sessionRatings` (capped at 20 entries)
- Recomputes `avgCorrelatedRating`
- Increments `highRatingActivations` if rating >= 7
- Increments `lowRatingActivations` if rating <= 4

### Eviction Candidates

`getEvictionCandidates(rules, topN)` returns the weakest rules:
1. Filter to rules with at least 5 injections (too few to judge)
2. Sort by `avgCorrelatedRating` ascending (worst first), then by `injectionCount` descending (heavily used but low-performing)
3. Return top N (default: 5)

## Budget Enforcement

`budget.ts` enforces per-tier rule caps.

### Default Caps

| Tier | Cap | Warning At |
|------|-----|-----------|
| Global | 25 | 20 |
| Project | 25 (per project) | 20 |
| Graph | Unlimited | — |

### BudgetStatus

```typescript
type BudgetLevel = "OK" | "WARNING" | "OVER_BUDGET";

interface BudgetStatus {
  level: BudgetLevel;
  ruleCount: number;
  cap: number;
  remaining: number;
}
```

`checkBudget(tier, ruleCount, cap?)` returns the status. Custom caps can override defaults. When `OVER_BUDGET`, the daemon skips promotion for that tier.

## Atomic CLAUDE.md Writes

`bridge.ts` writes rules to CLAUDE.md safely using a write-to-temp-then-rename pattern.

### How `promoteRule()` Works

1. Read the CLAUDE.md file
2. Find the rules section by scanning for `### Rules` or `## Rules` markers
3. Locate the last rule line in that section (lines starting with `- **`)
4. Insert the new rule after that line: `- **{rule.id}:** {rule.text}`
5. Write the modified content to a temp file (`CLAUDE.md.tmp.{pid}`)
6. Rename the temp file over the original (atomic on POSIX)
7. If the rename fails, delete the temp file and throw

### How `removeRule()` Works

1. Read the CLAUDE.md file
2. Filter out lines matching `- **{ruleId}:**`
3. Atomic write via the same temp-then-rename pattern

### Why Atomic Writes

The daemon may be writing rules while a session is reading CLAUDE.md. The rename pattern ensures the file is either the old version or the new version — never a partial write.

## Promotion Ledger and Undo

`ledger.ts` maintains `promotions.jsonl` — a log of every promotion with before/after snapshots.

### PromotionRecord

```typescript
interface PromotionRecord {
  id: string;             // UUID
  ruleId: string;         // Which rule was promoted
  tier: Tier;             // Where it was promoted to
  timestamp: string;      // When
  beforeSnapshot: string; // CLAUDE.md content before the change
  afterSnapshot: string;  // CLAUDE.md content after the change
  approved: boolean;      // Whether it went through inbox review
}
```

### `recordPromotion(record, stateDir)`

Appends the record to `promotions.jsonl` using atomic write.

### `undoPromotions(count, stateDir)`

Removes the last N entries from the ledger and returns them. The caller uses the `beforeSnapshot` to restore CLAUDE.md. Atomic write ensures the ledger itself is consistent.

### `getPromotionHistory(stateDir)`

Reads all records from `promotions.jsonl`. Skips malformed lines.

## The Inbox Approval Flow

`bin/commands/inbox.ts` is the human gate between detected patterns and promoted rules.

### What the Inbox Shows

For each pending candidate:
```
--- Candidate 1 ---
  Type:     failure
  Freq:     12 occurrences across 5 sessions
  Severity: 8/10
  Rule:     Recurring correction (12x): stop doing...; that's wrong...; I didn't ask...
  Tier:     global
  Reason:   Multi-project (3) behavioral pattern: 5 behavioral vs 1 procedural keywords
  First:    2026-06-15T10:00:00Z
  Last:     2026-07-01T14:30:00Z
```

### How Candidates Are Gathered

1. Run `detectFailurePatterns()` with threshold 3 (lower than daemon default for visibility)
2. Run `minePatterns()` for cross-signal patterns
3. Merge results, deduplicate by pattern ID
4. Route each through `routeRule()` to show the proposed tier

The inbox is read-only — it shows candidates. Use `agentgrit rules promote` to actually promote them.

## Weekly Learning Review

`review.ts` runs a synthesis cycle over all rating signals.

### What It Does

1. Reads all entries from `ratings.jsonl`
2. Clusters entries by sentiment summary similarity (word overlap >= 0.4)
3. Identifies clusters of 3+ entries with average rating <= 4.0
4. Derives a rule name from the most frequent words in the cluster's summaries
5. Computes overall score trend (up/down/flat) by comparing first-half vs. second-half averages (delta > 0.5 = up, < -0.5 = down)

### ReviewResult

```typescript
interface ReviewResult {
  patternsFound: number;
  candidatesProposed: number;
  skipped: number;
  candidates: Pattern[];
  scoreTrend: { avg: number; count: number; direction: "up" | "down" | "flat" };
}
```

## Data Flow

```
detect/failures.ts  ─┐
detect/patterns.ts  ─┤→ promote/router.ts → tier assignment
                     │                      │
                     │   promote/budget.ts ←─┘ (cap check)
                     │                      │
                     │   promote/bridge.ts ←─┘ (atomic CLAUDE.md write)
                     │                      │
                     │   promote/ledger.ts ←─┘ (record to promotions.jsonl)
                     │
                     └→ promote/review.ts → weekly synthesis
                     └→ promote/rules.ts  → correlation tracking + eviction
```
