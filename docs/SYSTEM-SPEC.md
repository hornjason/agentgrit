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

At session start, inject only the rules relevant to the current task.

**Current pipeline (hybrid BM25+vector, shipped 2026-07-13):**
1. **BM25 primary** — search task text against 383 memory files, retrieve 3x candidates
2. **Vector similarity** — compute query embedding (all-MiniLM-L6-v2 via transformers.js), cosine against 382 pre-computed node vectors
3. **Graph expansion** — 1-hop neighbors via co_occurred + reinforces edges
4. **3-way RRF merge** — BM25 (2x weight) + vector (0.5x) + graph (1x) via `rrfMerge()` in retrieval.ts
5. **Node-type weighting** — feedback/steering 1.0x, success 0.8x, reference 0.5x, project 0.3x
6. **Content sanitization** — `sanitizeRuleText()` strips injection patterns before agent injection
7. **Top-K selection** — return top 10-15 rules
8. **Attribution feedback** — rated sessions update co-occurrence edge weights automatically

**Performance (measured 2026-07-13):** precision@5 = 0.76, MRR = 0.96, recall@5 = 0.37, recall@15 = 0.61.

**Architecture decisions:**
- ADR-001 (`docs/adr/ADR-001-correlation-driven-rule-injection.md`) — correlation-driven injection
- ADR-005 (`docs/adr/ADR-005-bm25-first-retrieval.md`) — BM25-first retrieval, co-occurrence edges

### 4b. Multi-Layer Context Gating (planned — #102)

**Problem:** Rules are precision-gated (0.76) but only account for 2.5% of total context. The other 97.5% (~4,876 lines) is bulk-loaded regardless of task type:

| Layer | Lines | Status |
|---|---|---|
| GRAPH-CONTEXT.md (rules) | 93 | ✅ Precision-gated (0.76) |
| Dynamic context | 30 | ✅ Signals-based |
| CLAUDE.md | 177 | ❌ Always loaded |
| CLAUDE-LEARNED.md | 63 | ❌ Always loaded |
| MEMORY.md | 101 | ❌ Always loaded |
| Ship skill files | 1,666 | ❌ Every ship task |
| Project docs (DDB) | 2,869 | ❌ Every project task |

**Design (2 phases):**

**Phase 1: Size-aware loading + learned rules filtering (#103)**
- Ship skill loads ceremony docs (HARNESS-GATES, BRIEF-TEMPLATES) on-demand, not at SCOPE start
- XS/S tasks skip ceremony until BUILD needs them (~626 lines saved)
- CLAUDE-LEARNED.md filtered to top-K relevant rules via BM25+vector (same pipeline as graph rules)
- Measurement harness logs total lines loaded per session

**Phase 2: Section-level project doc retrieval (#104)**
- Embed sections of ARCHITECTURE.md, PRINCIPLES.md at build time (same approach as rule vectors)
- At session start, retrieve only sections relevant to the task (by section heading)
- A config typo fix loads ~200 lines of relevant sections, not 2,869 lines of full docs
- Fallback: load full doc if no section vectors available (graceful degradation)

**Targets:**
- XS task: ≤ 1,000 lines total (from ~5,000)
- M task: ≤ 3,000 lines total (from ~5,000)
- Rules precision: no regression below 0.70

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
1. **Recall@5:** ≥82% of needed rules in top 5 retrieved — **NOT MET (0.37). recall@15 = 0.61.** Top-5 is tight with larger relevant sets; most rules found by rank 15.
2. **Precision@5:** ≥70% of retrieved rules are relevant — **MET (0.76)** ✅ Achieved via hybrid BM25+vector+graph retrieval + node-type weighting.
3. **MRR:** ≥0.90 — **MET (0.96)** ✅ First relevant rule is typically rank 1 or 2.
4. **Rule budget:** ≤12 universal + ≤20 domain-filtered per session — **MET (11 + ~15)**
5. **Zero repeat corrections:** same mistake never rated ≤3 twice — **PARTIALLY MET (some patterns recur)**
6. **Self-maintaining:** rules added, classified, correlated, and evicted without manual intervention — **MET (eviction #85, attribution #99, regression gate #99)**
7. **Self-improving:** rated sessions automatically improve retrieval quality — **MET (attribution feedback → edge weights → better retrieval #99)**

**Measurement note (2026-07-13):** Precision measured on 60-session gold set (34 real + 26 synthetic, all audited for under-labeling). Hybrid retrieval: BM25 (2x weight) + vector similarity (0.5x) + graph expansion (1x). Node-type weighting: feedback/steering 1.0x, success 0.8x, reference 0.5x, project 0.3x. 382 pre-computed vectors via all-MiniLM-L6-v2.
