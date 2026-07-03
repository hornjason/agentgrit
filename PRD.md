# AgentGrit — Self-Learning Loop for AI Agents

**Repo:** https://github.com/hornjason/agentgrit (future org: github.com/agentgrit)
**Package:** `@agentgrit/core` on npm

## Overview

AgentGrit is an open-source self-learning engine that makes AI coding agents improve over time. It closes a feedback loop: capture signals from sessions → score output quality against configurable rubrics → detect failure patterns → promote learnings into durable rules → optimize prompts via hill-climbing → build a knowledge graph for contextual recall.

The full system ships as one package. Users choose their adoption speed at install — from zero-API-key manual review to fully automated scoring, optimization, and rule promotion from day one.

It targets Claude Code users initially but is designed to be runtime-agnostic. The scoring, pattern detection, and optimization layers work with any LLM trace source.

## Problem Statement

AI coding agents make the same mistakes repeatedly across sessions. Users correct the same behaviors, but corrections are lost when the session ends. There is no mechanism to:

1. Capture what went wrong (and what went right) in a structured way
2. Score output quality against domain-specific criteria
3. Detect recurring failure patterns across sessions
4. Promote learnings into durable rules that persist
5. Automatically optimize prompts/skills based on score feedback
6. Recall the right rules at the right time based on task context

This system was built organically in PAI as ~50 scattered files with inconsistent naming, no install path, and no way to reproduce on a fresh machine or share with other users. AgentGrit extracts, standardizes, and packages it for anyone to use.

## Goals

1. **One install command** gets the full learning loop running
2. **User chooses adoption speed** — quick start (zero keys, manual review), standard (add LLM judge), or full auto (daemon + optimizer + graph) from day one
3. **Domain-agnostic** — rubrics make it specific; machinery is generic
4. **Tiered rule routing** — rules go to the right level (global, project, graph) automatically
5. **Bootstrap from existing data** — can seed from existing Claude Code session history
6. **Portable** — export/import graph and rules between machines
7. **Observable** — health checks, status commands, self-diagnostics
8. **We eat our own cooking** — PAI migrates to AgentGrit as the first user, validating the install and migration path

## Non-Goals

- This is NOT a coding/shipping loop (that ships separately as `@agentgrit/ship`)
- This is NOT a UI/dashboard — it's CLI + daemon + hooks. Langfuse IS the dashboard if you want one
- This is NOT tied to Langfuse — Langfuse is one adapter; local-only mode is first-class
- This does NOT replace CLAUDE.md — it manages what goes INTO CLAUDE.md

---

## Architecture

### System Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    Skills / Agents                       │
│           (ship, research, security, custom)             │
├─────────────────────────────────────────────────────────┤
│                    agentgrit                             │
│                                                         │
│  ┌─────────┐  ┌──────────┐  ┌────────┐  ┌──────────┐  │
│  │ CAPTURE  │→│ EVALUATE  │→│ DETECT  │→│ PROMOTE   │  │
│  │ (hooks)  │  │ (judge)   │  │(patterns)│ │(rules)   │  │
│  └─────────┘  └──────────┘  └────────┘  └──────────┘  │
│       ↑                                       │         │
│       │            ┌──────────┐               │         │
│       │            │ OPTIMIZE │←──────────────┘         │
│       │            │(hill-climb)│                        │
│       │            └──────────┘                         │
│       │                                       │         │
│       │            ┌──────────┐               │         │
│       └────────────│  GRAPH   │←──────────────┘         │
│                    │(retrieval)│                         │
│                    └──────────┘                         │
├─────────────────────────────────────────────────────────┤
│              Claude Code / LLM Runtime                   │
└─────────────────────────────────────────────────────────┘
```

### Data Flow

```
Session starts
    │
    ├─→ Graph hook fires → queries knowledge-graph.json for current domains
    │   → injects top 10 relevant rules into session context
    │
    ▼
User works in Claude Code session
    │
    ├─→ RatingCapture hook → writes to signals/ratings.jsonl
    ├─→ CorrectionCapture hook → writes to signals/corrections.jsonl
    ├─→ SentimentScorer hook → writes to signals/sentiment.jsonl
    ├─→ SkillInvocation hook → writes to signals/skills.jsonl
    │
    ▼
Session ends
    │
    ├─→ Debrief hook (if triggered) → extracts rules from session
    ├─→ TrajectoryStore (if rating >= 7) → saves "what worked" episode
    │
    ▼
Daemon cycle (every 30 minutes)
    │
    ├─→ SCORE: Judge evaluates new traces against rubric → scores.jsonl
    ├─→ DETECT: Pattern detector scans signals for recurring failures
    ├─→ PROMOTE: If pattern crosses threshold → route to correct tier
    ├─→ SYNC: Push scores to Langfuse (if configured)
    ├─→ OPTIMIZE: If dimension below threshold → queue hill-climb
    │
    ▼
Weekly cycle (Sunday)
    │
    ├─→ REVIEW: Full learning review, synthesize patterns
    ├─→ GRAPH REBUILD: Incremental graph update with new rules
    ├─→ RULE BUDGET: Check each tier against cap, flag eviction candidates
    ├─→ REPORT: Write summary to loop-summary.log
```

---

## Package Structure

```
agentgrit/
├── package.json
├── bin/
│   └── agentgrit.ts                  ← CLI entry point
├── src/
│   ├── capture/                      ← SIGNAL CAPTURE
│   │   ├── rating.ts                     Captures user ratings (/rate M:N S:N Q:N)
│   │   ├── correction.ts                Detects correction language ("no", "stop", "not like that")
│   │   ├── sentiment.ts                 Scores each response positive/negative/neutral
│   │   ├── skill-invocation.ts          Logs which skills fired and which should have
│   │   ├── debrief.ts                   End-of-session rule extraction
│   │   └── index.ts                     Registers all captures as Claude Code hooks
│   │
│   ├── evaluate/                     ← SCORING / JUDGING
│   │   ├── judge.ts                     LLM-as-judge core (Gemini, Claude, OpenAI)
│   │   │                                - Reads a trace (input + output)
│   │   │                                - Scores against each rubric dimension
│   │   │                                - Returns per-dimension scores + reasoning
│   │   ├── session.ts                   Session-level quality scoring
│   │   │                                - Aggregates signals from a session
│   │   │                                - Computes composite quality score
│   │   ├── recall.ts                    Recall accuracy evaluation
│   │   │                                - Did the right rules surface for this domain?
│   │   │                                - Did the right skills fire?
│   │   │                                - Logs hits/misses for feedback
│   │   ├── content.ts                   Trace content evaluator
│   │   │                                - Fetches traces (from Langfuse or local JSONL)
│   │   │                                - Sends to judge with rubric
│   │   │                                - Writes scores back to source
│   │   └── rubric.ts                    Rubric loader and validator
│   │                                    - Loads JSON rubric configs
│   │                                    - Validates dimension structure
│   │                                    - Supports rubric composition (base + domain)
│   │
│   ├── detect/                       ← PATTERN DETECTION
│   │   ├── failures.ts                  Failure pattern detector
│   │   │                                - Scans correction signals for recurring themes
│   │   │                                - Groups by domain, frequency, severity
│   │   │                                - Outputs candidate patterns for promotion
│   │   ├── patterns.ts                  General pattern mining
│   │   │                                - Cross-signal pattern analysis
│   │   │                                - Correlates low scores with specific behaviors
│   │   │                                - Identifies "what changed" when scores drop
│   │   └── trajectories.ts             Trajectory store
│   │                                    - Stores "what worked" episodes from high-rated sessions
│   │                                    - Domain-tagged for contextual retrieval
│   │                                    - Capped at 100 entries, lowest-rated evicted
│   │
│   ├── promote/                      ← RULE MANAGEMENT
│   │   ├── router.ts                    RULE ROUTING (three-tier)
│   │   │                                - Analyzes rule: which projects did it appear in?
│   │   │                                - Single project → PROJECT tier
│   │   │                                - Multi-project behavioral → GLOBAL tier
│   │   │                                - Multi-project procedural → GRAPH tier
│   │   │                                - Respects per-tier budget caps
│   │   ├── rules.ts                     Rule lifecycle manager
│   │   │                                - Tracks rule correlation with session ratings
│   │   │                                - Identifies eviction candidates (low correlation)
│   │   │                                - Manages promotion queue (pending → active)
│   │   │                                - Handles archival (active → archived, searchable)
│   │   ├── budget.ts                    Rule budget enforcement
│   │   │                                - Global: 25 rules max
│   │   │                                - Per-project: 25 rules max
│   │   │                                - Graph: unlimited (not file-injected)
│   │   │                                - Blocks promotion when over budget
│   │   ├── review.ts                    Weekly learning review
│   │   │                                - Synthesizes all signals from the week
│   │   │                                - Produces pending rule candidates
│   │   │                                - Reports on score trends and pattern changes
│   │   └── bridge.ts                    Memory bridge
│   │                                    - Writes feedback memory files for promoted rules
│   │                                    - Updates CLAUDE.md for the correct tier
│   │                                    - Handles rebalancing between tiers
│   │
│   ├── optimize/                     ← HILL-CLIMBING OPTIMIZATION
│   │   ├── hill-climb.ts                Shared optimization engine
│   │   │                                - Generic: propose change → evaluate → keep/discard
│   │   │                                - Max 15% content change per round
│   │   │                                - Logs every round to experiments.jsonl
│   │   │                                - Flags large improvements for human review
│   │   ├── prompt-tuner.ts              Prompt optimizer
│   │   │                                - Pulls N lowest-scoring traces for a dimension
│   │   │                                - Extracts system prompt (what we control)
│   │   │                                - Proposes targeted improvements
│   │   │                                - Re-runs all N user prompts with new system prompt
│   │   │                                - Keeps if weighted average improves
│   │   └── skill-tuner.ts              Skill description optimizer
│   │                                    - Same hill-climbing engine
│   │                                    - Target: skill SKILL.md trigger descriptions
│   │                                    - Evaluated behaviorally (not text-matching)
│   │                                    - Uses SkillEvaluator for scoring
│   │
│   ├── graph/                        ← KNOWLEDGE GRAPH
│   │   ├── builder.ts                   Graph construction
│   │   │                                - Reads all rule/feedback/success memory files
│   │   │                                - AI-assigns domain tags to each rule
│   │   │                                - Detects edges between rules sharing domains
│   │   │                                - Incremental: only re-tags changed rules
│   │   │                                - Outputs knowledge-graph.json
│   │   ├── query.ts                     Graph query engine
│   │   │                                - Input: current session domain tags
│   │   │                                - Traverses graph for relevant rule clusters
│   │   │                                - Ranks by domain match + edge connectivity
│   │   │                                - Returns top N clusters for context injection
│   │   ├── retrieval.ts                 Hybrid retrieval (BM25 + graph + RRF)
│   │   │                                - BM25 keyword search over memory files (list A)
│   │   │                                - Graph domain traversal (list B)
│   │   │                                - Reciprocal Rank Fusion merge → top candidates
│   │   │                                - Optional reranking via Voyage AI
│   │   └── embedder.ts                 Vector embeddings
│   │                                    - Generates embeddings for semantic search
│   │                                    - BM25 index for keyword matching
│   │                                    - Supports Voyage AI or local embeddings
│   │
│   ├── adapters/                     ← DATA SOURCE ADAPTERS
│   │   ├── langfuse.ts                  Langfuse integration
│   │   │                                - Fetch traces and scores
│   │   │                                - Push scores back to Langfuse
│   │   │                                - Batch sync via ingestion API
│   │   ├── jsonl.ts                     Local JSONL storage
│   │   │                                - Read/write/append signals
│   │   │                                - Signal rotation when files get large
│   │   │                                - Atomic writes for daemon safety
│   │   ├── claude-code.ts               Claude Code integration
│   │   │                                - Hook registration in settings.json
│   │   │                                - CLAUDE.md read/write for rule management
│   │   │                                - Session transcript parsing
│   │   │                                - Project detection and tier routing
│   │   └── types.ts                     Shared interfaces
│   │                                    - Trace, Score, Signal, Rule, Pattern
│   │                                    - RubricConfig, Dimension, GraphNode, GraphEdge
│   │
│   └── daemon/                       ← AUTOMATION
│       ├── daemon.ts                    Main daemon loop
│       │                                - Runs every 30 minutes via LaunchAgent/systemd
│       │                                - Executes: score → detect → promote → sync → optimize
│       │                                - Weekly: review → graph rebuild → budget check
│       ├── doctor.ts                    Health check / self-diagnostic
│       │                                - Checks every link in the chain
│       │                                - Flags broken hooks, dead daemon, stale graph
│       │                                - Reports signal growth and rotation needs
│       │                                - Validates API keys and judge connectivity
│       └── scheduler.ts                LaunchAgent/systemd installer
│                                        - Generates plist (macOS) or timer (Linux)
│                                        - Handles start/stop/restart
│
├── rubrics/
│   ├── starter.json                  ← Universal starter rubric
│   │   dimensions: task-completion, accuracy, conciseness, safety
│   └── examples/
│       ├── sales.json                ← Example: sales content quality
│       ├── coding.json               ← Example: code generation quality
│       └── support.json              ← Example: support response quality
│
├── templates/
│   └── hooks.json                    ← Hook registrations to inject into settings.json
│
└── agentgrit.config.ts               ← User configuration
    - signalDir: where signals are stored
    - adapter: "local" | "langfuse" | "both"
    - langfuse: { publicKey, secretKey, baseUrl }
    - judge: { provider: "gemini" | "claude" | "openai", model, apiKey }
    - rubrics: ["starter.json", "custom.json"]
    - rules: { globalBudget: 25, projectBudget: 25, autoPromote: false }
    - daemon: { interval: "30m", weeklyDay: "sunday" }
```

---

## Three-Tier Rule Routing

Rules have a lifecycle and a location. agentgrit routes rules to the correct tier automatically based on where they were learned.

### Tier 1: GLOBAL (~/.claude/CLAUDE.md)

**What goes here:** Behavioral rules that apply to all projects in all domains.

**Budget:** 25 rules max.

**Examples:**
- "Verify before asserting — never claim something without checking with a tool"
- "Surgical fixes only — never remove components as a fix"
- "Read before modifying — understand existing code first"

**Routing signal:** Rule appeared across 2+ projects AND is behavioral (how to work, not what to do).

### Tier 2: PROJECT (<project>/CLAUDE.md)

**What goes here:** Rules specific to one project's codebase, tooling, or workflow.

**Budget:** 25 rules per project.

**Examples:**
- "Always use `make rebuild` — never raw docker/podman commands" (DailyBriefDashboard)
- "L4 scrapes run on Mac Mini only" (DailyBriefDashboard)
- "Use bun test, not npm test" (pai-config)

**Routing signal:** 100% of occurrences in one project.

### Tier 3: GRAPH (knowledge-graph.json, injected at session start)

**What goes here:** Domain-specific procedural rules that only matter when working in that domain. Not stored in any CLAUDE.md file. Surfaced by the graph query at session start based on the current task's domain.

**Budget:** Unlimited in graph. Top 10 injected per session by domain relevance.

**Examples:**
- domain:testing → "Run Quinn after every UI change"
- domain:architecture → "Council debate before structural changes"
- domain:scraping → "Visual scan of target page before writing scraper code"

**Routing signal:** Multi-project rule that is procedural (what to do in specific situations).

### Rule Lifecycle

```
Signal captured (correction, low score, failure pattern)
        │
        ▼
Pattern detected (recurring across 3+ sessions)
        │
        ▼
Candidate rule proposed
        │
        ▼
Router determines tier:
  ├─→ 1 project only → PROJECT CLAUDE.md
  ├─→ multi-project + behavioral → GLOBAL CLAUDE.md
  └─→ multi-project + procedural → GRAPH (domain-tagged)
        │
        ▼
Rule is active (injected into relevant sessions)
        │
        ▼
Tracked across sessions (RuleTracker correlates with ratings)
        │
   ┌────┴────┐
   │         │
High corr.  Low corr. (present in sessions but
   │         │          ratings don't improve)
   │         ▼
   │     Archive (removed from active injection,
   │              still searchable in graph)
   ▼
Stays active
```

### Rebalancing

For existing installations where rules accumulated without tiering:

```bash
agentgrit rules rebalance

  Analyzing 89 global rules...
  
  KEEP GLOBAL (26): behavioral, cross-project
  MOVE TO PROJECT (34): project-specific
  MOVE TO GRAPH (19): domain-specific, procedural
  ARCHIVE (10): low correlation with good outcomes
  
  Apply? [Y/n]
```

---

## Scoring System

### Two Scoring Channels

**Channel 1: Human signals (automatic, no rubric needed)**

| Signal | Trigger | Type | Storage |
|--------|---------|------|---------|
| Rating | User types `/rate M:N S:N Q:N` | 1-10 numeric | ratings.jsonl |
| Correction | User says "no", "stop", "not like that" | Binary + context | corrections.jsonl |
| Sentiment | Every assistant response | Pos/neg/neutral | sentiment.jsonl |
| Skill recall | Skill fires or should have fired | Hit/miss | skills.jsonl |

**Channel 2: LLM judge (rubric-driven, domain-specific)**

The judge reads an LLM output (a trace) and scores it against dimensions defined in a rubric JSON file.

```json
{
  "version": "1.0",
  "dimensions": [
    {
      "name": "task-completion",
      "description": "Did the output accomplish what was asked?",
      "weight": 0.30,
      "rubric": "Score 1-5. 1=completely wrong. 3=partially done. 5=fully accomplished."
    },
    {
      "name": "accuracy",
      "description": "Are all claims and code correct?",
      "weight": 0.30,
      "rubric": "Score 1-5. 1=factually wrong. 3=mostly right with errors. 5=all verifiable."
    }
  ],
  "judge_model": "gemini-2.5-flash"
}
```

Users write custom rubrics for their domain. The starter rubric covers universal quality. Multiple rubrics compose — both run, scores are separate.

### Rubric Discovery (Bootstrap)

When bootstrapping from existing session data, agentgrit analyzes correction history to suggest rubric dimensions:

```bash
agentgrit init --bootstrap

  Scanned 2,729 sessions. Correction analysis:
    47% — incomplete delivery (said "done" but wasn't)
    22% — wrong scope (answered the wrong question)
    18% — asserted without verifying
    13% — other
  
  Suggested rubric dimensions:
    - task-completion (weight: 0.35)
    - scope-accuracy (weight: 0.25)
    - verification-discipline (weight: 0.25)
    - conciseness (weight: 0.15)
  
  Save as custom rubric? [Y/n]
```

---

## CLI Commands

### Setup

```bash
agentgrit init                          # Interactive setup
agentgrit init --bootstrap              # Seed from existing Claude Code sessions
agentgrit init --import graph.json      # Import graph from another machine
agentgrit export                        # Export graph + rules for portability
```

### Status & Health

```bash
agentgrit status                        # Signal counts, score trends, rule budget
agentgrit doctor                        # Self-diagnostic — checks every link in chain
```

### Capture (mostly automatic via hooks)

```bash
agentgrit capture rating 7 "good session"   # Manual rating
agentgrit capture debrief                    # Extract rules from session
```

### Evaluate

```bash
agentgrit eval traces                   # Score recent traces against rubric
agentgrit eval traces --backfill        # Re-score all traces
agentgrit eval traces --local           # Score from local JSONL (no Langfuse)
agentgrit eval session                  # Score current session quality
agentgrit eval recall                   # Did the right skills/rules fire?
```

### Optimize

```bash
agentgrit optimize prompts              # Hill-climb lowest-scoring prompt dimension
agentgrit optimize prompts \
  --trace-type news-search \
  --dimension content-actionability \
  --rounds 3                            # Target specific dimension

agentgrit optimize skills \
  --skill ship \
  --rounds 5                            # Hill-climb skill descriptions

agentgrit optimize prompts --auto       # Find worst dimension, climb it
```

### Rules

```bash
agentgrit rules status                  # Show counts per tier
agentgrit rules rebalance               # Route rules to correct tier
agentgrit rules compact                 # Evict low-value rules to archive
agentgrit rules promote                 # Promote pending patterns to rules
agentgrit rules promote --approve       # With human gate
agentgrit rules promote --tier project  # Force to project level
```

### Graph

```bash
agentgrit graph build                   # Rebuild knowledge graph (incremental)
agentgrit graph build --full            # Full rebuild
agentgrit graph query "testing"         # Query graph for domain clusters
agentgrit graph stats                   # Node/edge/domain counts
```

### Learn

```bash
agentgrit review                        # Run weekly learning review manually
agentgrit patterns                      # Show detected failure patterns
agentgrit signals status                # Show signal file sizes
agentgrit signals rotate                # Rotate large signal files
```

### Daemon

```bash
agentgrit daemon start                  # Start background daemon
agentgrit daemon stop                   # Stop daemon
agentgrit daemon status                 # Check daemon state
agentgrit daemon run                    # Run one daemon cycle (for testing)
```

---

## Install Flow

### Fresh Install (No History)

```bash
bun add -g agentgrit              # or: npx agentgrit init

agentgrit init
  # 1. Creates ~/.agentgrit/ directory structure
  # 2. Asks: local-only or Langfuse? (skip = local-only)
  # 3. Asks: judge model? (Gemini Flash recommended, cheapest)
  # 4. Asks: install daemon? (LaunchAgent/systemd)
  # 5. Registers hooks in .claude/settings.json
  # 6. Creates starter rubric
  # 7. Runs agentgrit status to confirm

agentgrit status
  # Signals: 0 (capturing will begin on next Claude Code session)
  # Scores: 0 (daemon will score on next cycle)
  # Rules: 0 global, 0 project, 0 graph
  # Graph: empty (will build after first patterns detected)
```

### Install with Existing Sessions (Bootstrap)

```bash
agentgrit init --bootstrap
  # Same as fresh + scans ~/.claude/projects/*/*.jsonl
  # Extracts signals from session transcripts
  # Runs pattern detection on backfill
  # Builds initial knowledge graph
  # Suggests rubric from correction patterns
```

### Machine Migration

```bash
# On old machine:
agentgrit export > agentgrit-backup.json
  # Includes: graph, rules, rubrics, rule-stats, trajectories
  # Does NOT include: raw signals (too large, not portable)

# On new machine:
agentgrit init --import agentgrit-backup.json
  # Hot start — graph, rules, rubrics all loaded
  # Daemon begins capturing new signals immediately
```

---

## Automation Tiers

| Tier | What runs | When | Cost |
|------|-----------|------|------|
| Passive (hooks) | Signal capture to JSONL | Every Claude Code session | Zero — file writes only |
| Active (daemon) | Score + detect + sync | Every 30min via LaunchAgent | ~$0.01/run (judge calls) |
| Optimize (triggered) | Hill-climb prompts/skills | When dimension drops below threshold | ~$0.50/run (multi-LLM) |
| Review (weekly) | Full pattern synthesis + rule promotion + graph rebuild | Sunday night | ~$0.10/run |

### What requires NO manual intervention after init:

- Signal capture (hooks fire automatically)
- Scoring (daemon runs every 30min)
- Pattern detection (daemon runs every 30min)
- Graph context injection (hook fires at session start)
- Trajectory capture (hook fires at session end if rated >= 7)
- Score sync to Langfuse (daemon, if configured)
- Signal file rotation (daemon, when files exceed threshold)

### What requires manual intervention (or can be set to auto):

- Rule promotion: `agentgrit rules promote --approve` (or `autoPromote: true` in config)
- Optimization: `agentgrit optimize` (or auto-triggered when scores drop)
- Rebalancing: `agentgrit rules rebalance` (one-time migration)

---

## Health Check (agentgrit doctor)

```bash
agentgrit doctor

  CAPTURE
    ✓ RatingCapture hook registered and firing (last: 2h ago)
    ✓ CorrectionCapture hook registered and firing (last: 1h ago)
    ✓ SentimentScorer hook registered and firing (last: 1h ago)
    ✗ SkillInvocation hook registered but NOT firing (last: 14d ago)
      → Action: check if hook is disabled in settings.json

  SCORING
    ✓ Daemon running (PID 4821, last run: 28min ago)
    ✓ Judge API key valid (Gemini Flash responding)
    ✓ 47 traces scored in last 24h
    ⚠ 3 traces failed scoring (timeout) — will retry next cycle

  GRAPH
    ✓ knowledge-graph.json exists (289 nodes, 1091 edges)
    ⚠ Last rebuild: 8 days ago (threshold: 7 days)
      → queuing incremental rebuild

  RULES
    Tier 1 (Global):  18 / 25 budget — OK
    Tier 2 (Project DailyBriefDashboard): 12 / 25 budget — OK
    Tier 3 (Graph):   247 domain rules — no cap
    ✓ No pending promotions stuck > 7 days

  OPTIMIZATION
    ✓ Last prompt optimization: 3 days ago
    ⚠ Dimension "task-completion" trending down (4.2 → 3.8 over 2 weeks)
      → queuing hill-climb run

  SIGNALS
    ✓ ratings.jsonl: 536 entries, 736KB
    ✓ corrections.jsonl: 1847 entries, 270KB
    ⚠ tool-audit.jsonl: 8.8MB — rotation recommended
      → run: agentgrit signals rotate
```

---

## Testing Strategy

### Development Testing

```bash
# Option 1: Isolated config directory (fastest, same machine)
CLAUDE_CONFIG_DIR=/tmp/agentgrit-test claude
# Then: agentgrit init — tests install path without touching real setup

# Option 2: Docker (Linux, CI-friendly)
docker run -it --rm oven/bun:latest bash
# Install claude code CLI + agentgrit, run init

# Option 3: Fresh macOS user account (cleanest e2e test)
# Add "agentgrit-test" user, install from scratch, verify full loop
```

### Automated Tests

```bash
agentgrit test                          # Run full test suite
  # Unit tests: each module in isolation
  # Integration: capture → score → detect → promote pipeline
  # Daemon: mock timer, verify cycle runs correctly
  # Doctor: mock broken states, verify detection
  # Rubric: validate starter + example rubrics parse correctly
```

---

## What This Is NOT

- **Not the coding/shipping loop.** The ship skill (goal → discovery → build → verify → iterate) is a separate open-source candidate. agentgrit is the learning substrate that ship builds on top of.
- **Not a dashboard.** agentgrit is CLI + daemon + hooks. Langfuse IS the dashboard if you want one. Otherwise `agentgrit status` is the interface.
- **Not a framework for building agents.** agentgrit makes existing agents better through feedback. It doesn't help you build the agent in the first place.
- **Not opinionated about your workflow.** It scores what you tell it to score. The rubric is yours. The rules it promotes are based on YOUR correction patterns.

---

## Adoption Speeds (User Chooses at Init)

All code ships in one release. The user picks how much to turn on.

### Quick Start (zero API keys)
- Hooks capture signals (ratings, corrections, sentiment) to JSONL
- Pattern detection runs on session-end hook
- Rule candidates surface in `agentgrit inbox`
- User approves/rejects manually
- No LLM judge, no daemon, no optimizer
- Upgrade anytime with `agentgrit upgrade`

### Standard (one API key)
- Everything in Quick Start, plus:
- LLM judge scores traces against rubrics (Gemini/Claude/OpenAI)
- Simple graph with keyword domain tags
- Contextual rule injection at session start
- Still human-gated promotion via inbox

### Full Auto (API key + daemon)
- Everything in Standard, plus:
- Daemon runs every 30 minutes (LaunchAgent/systemd)
- Hill-climbing optimizer auto-improves lowest-scoring prompts/skills
- Full knowledge graph with hybrid retrieval
- Optional Langfuse sync for dashboard visibility
- Auto-promote option (with promotion ledger + undo for safety)

## Council-Validated Requirements (from 4-agent, 3-round debate)

### Adopted from council:
1. **Credential hardening** — zero plaintext secrets in config. Keychain or env vars only. Signal files get 600 permissions, ~/.agentgrit/ gets 700.
2. **Atomic CLAUDE.md writes** — write-to-temp-then-rename pattern, snapshot before every mutation, promotion ledger (promotions.jsonl) with before/after for full rollback via `agentgrit undo`.
3. **Inbox as trust mechanism** — `agentgrit inbox` shows rule text, source session provenance, tier rationale, and unified diff preview of exact CLAUDE.md change. Accept/reject/reroute per item.
4. **Schema versioning from day one** — every persisted file (signals JSONL, rules, config, graph) includes schema_version. CLI refuses to process unrecognized versions.
5. **Contract tests between layers** — fixture JSONL files with known patterns that MUST produce specific candidates, and noise files that MUST NOT. Golden-file tests for every CLAUDE.md mutation path.
6. **Migration spec before code** — three-column table mapping every PAI tool file to an AgentGrit module with disposition (keep/merge/drop). This mapping IS the feature spec.
7. **Human-gated promotion default** — auto-promote available in Full Auto mode but defaults to off. The inbox is the security boundary between captured signals and the agent's instruction set.

### Overridden from council:
1. **Scope** — Council recommended capture+detect+promote only. Overridden: ship the full system (all 6 subsystems + daemon + graph + optimizer). User chooses adoption speed, not us.
2. **LLM judge** — Council said defer to v2. Overridden: ships in v1 as opt-in (Standard and Full Auto modes). Zero-key mode still works for Quick Start.
3. **Graph** — Council said defer to v2. Overridden: ships in v1 as part of Standard and Full Auto. Simple keyword tags for Standard, full BM25+RRF for Full Auto.
4. **Daemon** — Council said defer to v2. Overridden: ships in v1 as part of Full Auto mode. Session-end hooks available as alternative for Quick Start/Standard.
5. **Bootstrap scanner** — Council said defer to v1.1. Overridden: ships in v1 with credential pre-filter (strips API keys, base64 >40 chars, auth tokens from session transcripts before processing).

## Migration Plan (PAI → AgentGrit)

AgentGrit's first user is PAI itself. The migration validates the install path, bootstrap scanner, and full-auto mode before anyone else tries it.

### Phase 1: Build AgentGrit (Weeks 1-4)
1. Write migration spec mapping all PAI tool files to AgentGrit modules
2. Build test harness with fixture signals and contract tests
3. Build all 6 subsystems + CLI + daemon + adapters
4. Build inbox UX with promotion ledger and undo

### Phase 2: Test in Sandbox (Week 5)
1. Isolated config test: `CLAUDE_CONFIG_DIR=/tmp/agentgrit-test claude`
2. Verify `agentgrit init` in all three modes (quick/standard/full)
3. Verify `agentgrit init --bootstrap` against real PAI session data
4. Verify daemon cycle, inbox, optimization on sandbox data
5. Fresh macOS user account test — full "stranger installs it" experience

### Phase 3: Migrate PAI (Week 6)
1. `agentgrit export-legacy` — reads existing PAI tools, extracts data
2. `agentgrit init --import legacy-export.json` — loads into AgentGrit format
3. Old hooks replaced by AgentGrit hooks in settings.json
4. Run both systems in parallel for 1 week to verify parity
5. Remove old PAI learning loop files, AgentGrit takes over
6. Validate: graph intact (289+ nodes), all signals preserved, rules in correct tiers

### Phase 4: Open Source (Week 7)
1. Clean up repo, write README with the 10-second pitch
2. Add examples (sales rubric, coding rubric, support rubric)
3. Push to npm as `@agentgrit/core`
4. Announce
