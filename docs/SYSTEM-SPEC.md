---
doc-type: spec
status: active
owner: jason
updated: 2026-07-08
---

# AgentGrit System Spec

**Version:** 1.0 (2026-07-08)
**Package:** @agentgrit/core@0.1.4 on npm
**Tests:** 907 pass, 0 fail across 83 files

## Purpose

AgentGrit is a self-learning engine that makes AI coding agents smarter over time. It captures behavioral signals during sessions, extracts patterns, promotes proven patterns to rules, injects only the relevant rules per session, measures whether the right rules fired, and evicts rules that don't help. The goal: **the user should never have to correct the same mistake twice.** Every correction compounds into permanent improvement.

## The Learning Loop

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   CAPTURE ──→ DETECT ──→ PROMOTE ──→ INJECT                │
│      ↑                                    │                 │
│      │         MEASURE ←──────────────────┘                 │
│      │            │                                         │
│      └──── EVICT ←┘                                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘

Session signals (ratings, corrections, failures)
    → Pattern detection (clustering, trajectories)
    → Rule promotion (with budget + contradiction check)
    → Context injection (domain-filtered, ≤20 rules/session)
    → Recall measurement (did the right rules fire?)
    → Eviction (low-correlation rules retired)
    → Next session is smarter
```

## Components

### 1. Signal Capture (`src/capture/`)

| Signal | Source | Storage |
|--------|--------|---------|
| Ratings | `/rate M:N S:N Q:N` or auto-scored | `signals/ratings.jsonl` |
| Corrections | User correction language detected | `signals/corrections.jsonl` |
| Failures | Sessions rated ≤3 | `signals/failures/` |
| Tool audit | Tool calls logged | `signals/tool-audit.jsonl` |
| Skill invocations | Skill usage tracked | `signals/skill-invocations.jsonl` |
| Work completion | Session learnings extracted | `signals/work-completions.jsonl` |
| Debrief | Manual `/debrief` extraction | `signals/debriefs.jsonl` |

630+ ratings, 1000+ corrections captured to date.

### 2. Pattern Detection (`src/detect/`)

- **Failure pattern mining** — clusters corrections by theme, scores severity. Supports rule-based AND opt-in LLM semantic clustering.
- **Trajectory storage** — high-rated session sequences stored, domain-tagged, capped at 100. Evicts lowest-rated when full.
- **Anti-rationalization** — auto-generates rebuttal table from weighted failure patterns.
- **Theme cohorts** — groups rules into cohorts for per-cohort health analysis.

### 3. Rule Promotion (`src/promote/`)

- **Promotion pipeline** — patterns with 3+ occurrences become rule candidates → appear in `agentgrit inbox`
- **Three-tier routing** — rules route to global (≤12), project (≤25), or graph tier based on project count
- **Budget enforcement** — `checkBudget()` blocks promotion when over cap
- **Contradiction checking** — LLM-powered check before promotion; blocks conflicting rules
- **Undo** — ledger-based promotion history; `agentgrit undo` reverts

### 4. Context Injection (`src/graph/`)

At session start, inject only the rules relevant to the current task:

1. **Domain detection** — classify task into 1-4 domains from 18 canonical categories
2. **Graph query** — knowledge graph (302 nodes, 1081 edges) returns domain-matched clusters, capped at 8
3. **BM25 search** — fill gaps with keyword-matched rules, capped at 7
4. **Trajectory backfill** — proven sequences for matched domains
5. **Per-role filtering** — Marcus gets engineering rules, Quinn gets QA rules, Rook gets security rules

**Domain metadata:** `rule-domains.json` tags each rule with domains. Self-healing adds new rules automatically at session start. Weekly review auto-classifies new rules.

**Architecture decisions:**
- ADR-001 (`docs/adr/ADR-001-correlation-driven-rule-injection.md`) — correlation-driven injection replaces bulk loading
- PAI ADR-004 (`~/.claude/PAI/ADR/ADR-004-domain-gated-rule-injection.md`) — domain detection mechanism, BM25 inference, integration architecture

**Planned: BM25 domain inference (AG #78 / PAI #104)** — replace regex keyword matching with BM25 search against rule corpus for domain detection. Infrastructure exists, not yet wired.

### 5. Recall Measurement (`src/evaluate/`)

| Metric | Current (2026-07-08) | Target |
|--------|---------------------|--------|
| recall@5 | 0.832 | ≥ 0.82 |
| precision@5 | 0.490 | ≥ 0.70 |
| MRR | 0.89 | ≥ 0.90 |
| Universal rules | 11 | ≤ 12 |
| Session rule load | ~19 rules | ≤ 20 |

Measured by `RecallEvaluator` over 34 sessions. `session-context.json` records which rules were loaded and which domain detection method was used (`domain_source: "metadata" | "keyword" | "bm25"`).

**Precision gap:** 0.490 vs 0.70 target. Root cause: keyword-based domain detection produces false positives (5-6 domains when 2-3 is correct). BM25 inference (#104) is the planned fix.

### 6. Rule Lifecycle Management

**What exists:**
- **Correlation tracking** — `trackAttributedRules()` updates per-rule stats after every rated session
- **Staleness detection** — `lastSeen > 60 days` → priority eviction candidate
- **Low-correlation flagging** — `avgCorrelatedRating < 4` after 10+ sessions → eviction candidate
- **Self-healing** — new graph nodes auto-classified into `rule-domains.json` at session start
- **Auto-prune** — `pruneTobudget()` runs when over budget cap

**GAP: Eviction doesn't clean rule-domains.json.** Rules evicted from CLAUDE.md leave stale entries in rule-domains.json. Weekly LearningReview should remove them but doesn't reference rule-domains.json yet. Tracked: AG #81 + PAI #98.

**GAP: No human review of auto-classifications.** 50/71 rules in rule-domains.json are `source: "auto"`, 0 are `source: "reviewed"`. Domain assignments may be wrong.

## Integration: AgentGrit ↔ Claude Code

AgentGrit is a library. Claude Code (via PAI hooks) is the consumer.

```
Claude Code session
    → PAI hook (GraphContext.hook.ts) calls AgentGrit APIs
    → AgentGrit returns domain-filtered rules
    → PAI writes GRAPH-CONTEXT.md files
    → Agent briefs reference per-role context files
```

**PAI owns:** Hooks, agent roster (Marcus/Quinn/Rook), personality (Rayford), ship workflow gates, CLAUDE.md
**AgentGrit owns:** Learning loop engine, graph, BM25, rule management, daemon, CLI

AgentGrit is imported at runtime via dynamic `import()`. If unavailable, PAI falls back to local graph queries. AgentGrit availability never blocks session start.

## Current State (2026-07-13)

| Area | Status | Reference |
|------|--------|-----------|
| Signal capture | COMPLETE | 216 tests pass |
| Pattern detection | COMPLETE | 47 tests pass |
| Rule promotion | COMPLETE | 108 tests pass |
| Graph + injection | SHIPPED (hybrid) | BM25 + vector + graph 3-way RRF (#97, #98). sanitizeRuleText. |
| Recall measurement | FIXED | Evaluator decontaminated. 60-session gold set with negatives. Regression gate. |
| Eviction pipeline | COMPLETE | #85 shipped — correlation-based, duplicate detection, budget cap |
| Co-occurrence edges | SHIPPED | Rating-weighted (#97). Attribution feedback updates weights per session (#99). |
| Embedding support | SHIPPED | transformers.js optional peerDep, vector-cache.json, EmbeddingProvider interface (#98) |
| Feedback loop | CLOSED | Attribution → edge weights → retrieval → session → attribution (#99) |
| Eval regression gate | SHIPPED | Blocks buildGraph on precision drop >= 0.05 (#99) |
| Skill optimization | COMPLETE | 75 tests pass |
| Track 1 ports (#63-74) | ALL CLOSED | 12/12 verified 2026-07-08 |
| Track 1 cutover (#75) | OPEN | Prerequisites met |
| Package exports | MISSING | No programmatic API surface |
| Claude Code hook templates | MISSING | `agentgrit init --claude-code` not built |
| Multi-layer context | GAP | Only retrieves feedback rules. Project docs, skills not precision-gated. |

## Specs & ADRs

| Doc | Location | Covers |
|-----|----------|--------|
| This spec | `docs/SYSTEM-SPEC.md` | Full system overview (authoritative) |
| ADR-001 | `docs/adr/ADR-001-correlation-driven-rule-injection.md` | Rule injection architecture |
| ADR-004 | `~/.claude/PAI/ADR/ADR-004-domain-gated-rule-injection.md` | Domain detection, BM25, integration (SD-2 superseded by ADR-005) |
| ADR-005 | `docs/adr/ADR-005-bm25-first-retrieval.md` | BM25-first retrieval, co-occurrence edges, gold set rebuild |
| Migration plan | `docs/migration-plan.md` | 42-capability audit, phase plan |
| Migration spec | `docs/migration-spec.md` | 221-file PAI→AgentGrit mapping |
| Test matrix | `docs/TEST-MATRIX.md` | 89-item verification checklist |
| SELFLEARNING.md | `~/.claude/PAI/SELFLEARNING.md` | Original four-tier vision |
| MEMORY-LOOP.md | `~/.claude/PAI/MEMORY-LOOP.md` | Nightly pipeline steps |

## Success Metrics

The system succeeds when:
1. **Recall:** ≥82% of needed rules in top 5 retrieved — **MEASURING (0.17 before hybrid, re-measure with vectors)**
2. **Precision:** ≥70% of retrieved rules are relevant — **MEASURING (0.24 before hybrid, re-measure with vectors)**
3. **Rule budget:** ≤12 universal + ≤20 domain-filtered per session — **MET (11 + ~15)**
4. **Zero repeat corrections:** same mistake never rated ≤3 twice — **PARTIALLY MET (some patterns recur)**
5. **Self-maintaining:** rules added, classified, correlated, and evicted without manual intervention — **MET (eviction #85, attribution #99, regression gate #99)**
6. **Self-improving:** rated sessions automatically improve retrieval quality — **SHIPPED (attribution feedback → edge weights → better retrieval)**

**Note (2026-07-13):** All infrastructure is shipped. Precision measurement pending — need to run `agentgrit embed` to pre-compute vectors, then run RecallEvaluator against expanded 60-session gold set. Expected jump: 0.24 → 0.40-0.50 from vocabulary gap bridging.
