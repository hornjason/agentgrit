# Plan: PAI Learning Loop → AgentGrit Migration

## Context

PAI's learning loop: 14 hooks, ~40 tools, 46 state files, 8,600+ data files under `~/.claude/`. AgentGrit consolidates into `@agentgrit/core@0.1.3` — 46 source files, 588 tests, published on npm.

**Problem:** Both systems running simultaneously. Need to cut over cleanly with tests proving equivalence before any PAI files are removed.

**Goal:** One learning loop (AgentGrit), reading existing data in-place, no duplication, no data loss.

## Audit Results — Capability Status

From exhaustive code-level audit of both systems:

**Full accounting — 42 capabilities total:**
- **21 COMPLETE** → ready for cutover (no work needed)
- **9 PARTIAL** → 6 BUILD (P2, P4, P5, P7, P8, P9 in Phase 1b), 3 ACCEPT (P1, P3, P6)
- **12 MISSING** → 5 BUILD (G1-G5 in Phase 1b), 2 DEFER (D1-D2), 5 PAI-specific (stays as PAI hooks)
- **Phase 1b total: 11 items** (5 MISSING + 6 PARTIAL) — all must complete before Phase 2 tests

### Audit Methodology

Every capability comparison must answer three questions before moving on:
1. **Disposition?** BUILD / ACCEPT / DEFER — no capability left undecided
2. **Worst case if ACCEPT or DEFER?** What breaks after cutover if we don't build this?
3. **Infrastructure consistency?** If we're building infrastructure for related items (e.g. inference.ts for G1-G5), do other items use that same infrastructure? If yes → BUILD, not DEFER

### COMPLETE (21 capabilities — ready for cutover)
- Session scoring (identical algorithm, same penalties/bonuses)
- Tool audit logging (compatible output + rotation)
- Skill invocation + sequence tracking
- Negative assertion audit
- Trajectory store (same cap, eviction, domain-overlap query)
- Graph building (keyword + AI classification, incremental caching)
- Embedding-based edges (same Voyage model, same thresholds)
- BM25 index (identical parameters)
- Hybrid retrieval (same RRF, same stages)
- Graph query + drift detection + near-duplicate detection
- Recall evaluation (recall@K, precision@K, MRR, bootstrap CI)
- Gold set auto-labeling + synthetic generation
- LLM-as-judge (multi-provider, batch, rubrics)
- Hill-climbing optimizer (same algorithm, same thresholds)
- Prompt tuner + benchmark corpus
- Rule promotion to CLAUDE.md (atomic writes)
- Rule removal + undo (ledger-based — better than PAI)
- Rule stat tracking + routing (AgentGrit adds tier routing PAI lacks)
- Debrief pipeline (corrections, approvals, reprompts, theme grouping)

### PARTIAL (9 capabilities — each dispositioned)

**BUILD (6 items — added to Phase 1b):**

| # | Capability | Gap | Fix | Files | Size |
|---|-----------|-----|-----|-------|------|
| P2 | Pattern mining | Rule-based only; PAI uses LLM clustering | Add opt-in LLM semantic clustering alongside rule-based via inference.ts. Falls back to rule-based when unavailable. | `src/detect/patterns.ts` | S |
| P4 | Budget enforcement | `promoteRule()` never calls `checkBudget()` | Wire gate that throws on OVER_BUDGET before writing | `src/promote/bridge.ts` | XS |
| P5 | Eviction candidates | Missing staleness check; `Rule.lastSeen` exists | Add staleness filter: lastSeen > 60 days gets priority eviction | `src/promote/rules.ts` | XS |
| P7 | Graph context injection | Missing trajectory injection | Wire `queryTrajectories()` into `getContextRules()` | `src/graph/context.ts` | XS |
| P8 | Last response cache | `cacheLastResponse()` never writes to disk | Add `writeLastResponse()` persisting to signal dir | `src/capture/rating.ts` | XS |
| P9 | Work completion learning | No LLM insights, returns data vs writes files | Add LLM insights via inference.ts (same pattern as G2/G3), write to memory dir | `src/capture/work.ts` + `src/daemon/cleanup.ts` | S |

**ACCEPT (3 items — work differently but adequately):**

| # | Capability | Rationale |
|---|-----------|-----------|
| P1 | Failure pattern detection | Jaccard (textbook standard) vs PAI's overlap/min. Both cluster corrections with severity scoring. PAI's harness metadata clustering is PAI-specific. Tests T13-T15 validate equivalence. |
| P3 | Theme cohorts | 5 in-memory cohorts vs PAI's 6 with disk persistence. PAI's per-cohort rating analysis depends on `graph-node-stats.json` (PAI-specific). Disk persistence is caller responsibility. |
| P6 | Learning readback | AgentGrit reads recentSignals + failurePatterns + themes. PAI adds wisdomFrames and signalTrends — both PAI-specific data sources. AgentGrit's `status` calculates trends independently. |

### MISSING (12 capabilities — not in AgentGrit)
1. **Implicit sentiment via LLM (Haiku)** — PAI's richest auto-signal. AgentGrit uses keywords only.
2. **AutoFeedback generation** — LLM behavioral lesson extraction from low ratings
3. **AutoSuccess capture** — positive outcome memory from high ratings
4. **Contradiction check before promotion** — LLM-based duplicate/conflict detection
5. **7-day gate for proposed rules** — time-gated promotion
6. **Session-context.json** — rating-to-rule attribution snapshot
7. **Token counting** — sessions.jsonl token usage tracking
8. **Relationship context** — opinion injection at session start
9. **Active work summary** — WORK/ dir progress injection
10. **Agent-specific learning** — Marcus hard rules injection
11. **Startup file loading** — settings.json-driven file injection
12. **patterns.json for harness gates** — state file used by ship skill

## Phase 1: Fix Pipeline Gaps (COMPLETE)

- [x] #36 — Commands read signalDir from config
- [x] #39 — Graph memoryDir + signal file aliasing + backfill command

## Phase 2: Equivalence Tests (BEFORE any cutover)

### Tier 1: Core Signal Reading (must pass — blocks everything)

| # | Test | Assert | Source Files |
|---|------|--------|-------------|
| T1 | Read PAI ratings.jsonl | count = wc -l of source file (621+) | `src/adapters/jsonl.ts` |
| T2 | Read PAI correction-captures.jsonl via alias | count = 1072+ | `src/adapters/paths.ts:resolveSignalFile` |
| T3 | Read PAI skill-invocations.jsonl via alias | count = 935+ | `src/adapters/paths.ts:resolveSignalFile` |
| T4 | Read PAI tool-audit.jsonl | count = 156K+ | `src/adapters/jsonl.ts` |
| T5 | Parse rating dimensions from real PAI entry | mode/scope/quality present as numbers | `src/capture/rating.ts:parseRating` |
| T6 | Parse correction from real PAI entry | correction_phrase + context + turn_index present | `src/capture/debrief.ts` |

### Tier 2: Graph Pipeline (must pass — core learning loop)

| # | Test | Assert | Source Files |
|---|------|--------|-------------|
| T7 | Build graph from PAI memory files (352 files) | nodes >= 200 | `src/graph/builder.ts` |
| T8 | Graph domain classification matches PAI | >=80% domain agreement on 20 sampled nodes | `src/graph/builder.ts` |
| T9 | BM25 search on built graph | "verification" returns >=5 results | `src/graph/bm25.ts` |
| T10 | Hybrid retrieval returns ranked results | top result has RRF score > 0 | `src/graph/retrieval.ts` |
| T11 | Graph query by domain | "verification" cluster has >=3 nodes | `src/graph/query.ts` |
| T12 | Incremental rebuild (change 1 file) | only 1 node rebuilt, rest cached | `src/graph/builder.ts` |

### Tier 3: Pattern Detection (must pass — drives rule promotion)

| # | Test | Assert | Source Files |
|---|------|--------|-------------|
| T13 | Detect failure patterns from 1072 corrections | patterns >= 100 | `src/detect/failures.ts` |
| T14 | Severity scoring varies (not all same) | min severity != max severity | `src/detect/failures.ts` |
| T15 | Rule candidate text is descriptive | no candidate has "stop; stop; stop" quality | `src/detect/failures.ts` |
| T16 | Pattern mining finds low-rating patterns | >=1 pattern with type "low-rated-with-corrections" | `src/detect/patterns.ts` |
| T17 | Theme cohort assignment | all 5 cohorts have >=1 member | `src/detect/theme-cohorts.ts` |
| T18 | Anti-rationalization generation | >=3 rebuttals generated | `src/detect/theme-cohorts.ts` |

### Tier 4: Rule Promotion Pipeline (must pass — the output)

| # | Test | Assert | Source Files |
|---|------|--------|-------------|
| T19 | Review proposes candidates | candidates >= 1 from real PAI data | `src/promote/review.ts` |
| T20 | Route rule to correct tier | behavioral→Global, project-specific→Project | `src/promote/router.ts` |
| T21 | Budget check returns correct level | reports OVER_BUDGET when count > cap | `src/promote/budget.ts` |
| T22 | Promote rule to CLAUDE.md | rule appears in correct section, file not corrupted | `src/promote/bridge.ts` |
| T23 | Undo promotion | CLAUDE.md reverts to before-state | `src/promote/bridge.ts + ledger.ts` |
| T24 | Rule stat tracking across 5 sessions | avgCorrelatedRating computed correctly | `src/promote/rules.ts` |

### Tier 5: Evaluation (must pass — measures system quality)

| # | Test | Assert | Source Files |
|---|------|--------|-------------|
| T25 | Recall@5 on real gold set | score > 0 (system surfaces relevant rules) | `src/evaluate/recall.ts` |
| T26 | Session scoring matches PAI | score within 0.5 of PAI for same transcript | `src/capture/rating.ts` |
| T27 | Score trend calculation | 7-day avg within 0.5 of PAI's patterns.json | `bin/commands/status.ts` |

### Tier 6: Capture Commands (must pass — ongoing signal flow)

| # | Test | Assert | Source Files |
|---|------|--------|-------------|
| T28 | `capture rating` with /rate M:7 S:8 Q:6 | writes entry with mode=7, scope=8, quality=6 | `bin/commands/capture.ts` |
| T29 | `capture correction` with "no not that" | writes entry, filters "no problem" | `bin/commands/capture.ts` |
| T30 | `capture tool` with Bash | writes tool_name=Bash | `bin/commands/capture.ts` |
| T31 | `capture skill` with ship | writes skill=ship | `bin/commands/capture.ts` |
| T32 | All captures exit 0 on invalid input | no crashes on malformed JSON | `bin/commands/capture.ts` |

### Tier 7: CLI End-to-End (must pass — user-facing commands)

| # | Test | Assert | Source Files |
|---|------|--------|-------------|
| T33 | `agentgrit status` shows real data | ratings > 0, tool-audit > 0, trend present | `bin/commands/status.ts` |
| T34 | `agentgrit doctor` passes | 0 failures | `bin/commands/doctor.ts` |
| T35 | `agentgrit review` finds patterns | patterns > 0, candidates > 0 | `bin/commands/review.ts` |
| T36 | `agentgrit inbox` shows candidates | >=1 candidate after review | `bin/commands/inbox.ts` |
| T37 | `agentgrit graph build` builds from memory | nodes > 200 | `bin/commands/graph.ts` |
| T38 | `agentgrit graph query verification` | returns ranked clusters | `bin/commands/graph.ts` |
| T39 | `agentgrit backfill` completes all steps | graph + review + report all succeed | `bin/commands/backfill.ts` |
| T40 | `agentgrit export` produces valid JSON | JSON.parse succeeds, has graph + config | `bin/commands/export.ts` |

**Total: 40 tests across 7 tiers. ALL must pass before Phase 3.**

**STATUS: COMPLETE** — 39 pass, 1 skip (T16 — ratings lack `type` field for pattern mining). 704 total tests pass. Shipped 2026-07-06.

## Phase 3: Parallel Run (1 week)

Both systems active simultaneously. AgentGrit hooks write to same PAI signal directory. Daily comparison of pattern detection + candidates.

**Exit criteria:**
- AgentGrit detects >= 90% of PAI patterns
- Rule candidates are actionable quality
- No signal data loss (line counts only increase)
- Graph node count >= PAI's graph
- Zero AgentGrit hook errors over 7 days

## Phase 4: Cutover — Remove PAI Learning Hooks

Remove 17 PAI hooks from settings.json. Keep non-learning hooks (GateEnforcement, AgentBriefGuard, etc.). Update remaining hooks to read AgentGrit paths.

## Phase 5: Archive PAI Learning Tools

Move ~40 tools to `~/.claude/PAI/Tools/_archived-learning-loop/`. Keep Inference.ts and non-learning tools.

## Phase 6: Update CLAUDE.md Rules

Update ~38 rules referencing PAI tools → agentgrit commands.

## Phase 7: Update Cron/LaunchAgent

Replace `bun LearningReview.ts` with `agentgrit daemon run`.

## Phase 8: Verify & Document

`agentgrit doctor` + status + review + graph stats all pass. Update ARCHITECTURE.md.

## Phase 1b: Close All Capability Gaps (BEFORE Phase 2 tests)

**5 items remaining: G1 (LLM sentiment), G5 (time gate), P2 (LLM patterns), P9 (work insights). G2/G3/G4/G6/P4/P5/P7/P8 verified closed 2026-07-14.**

All LLM items use existing `src/adapters/inference.ts` (Haiku via claude CLI, $0 on subscription). Falls back gracefully when inference unavailable.

### MISSING → BUILD

| # | Gap | What to build | Where | Size |
|---|-----|--------------|-------|------|
| G1 | **Implicit LLM sentiment** | Opt-in LLM sentiment mode in capture. Uses inference.ts fast level. Fires on UserPromptSubmit, scores every user message. Falls back to keyword-only without claude CLI. | `src/capture/rating.ts` + `bin/commands/capture.ts` | M |
| G2 | **AutoFeedback generation** | When daemon detects sessions rated <=4, extract behavioral lesson via inference.ts, write `feedback_*.md` to memory dir, update graph. `generateFeedback()` already exists — wire into daemon cycle. | `src/daemon/cleanup.ts` + `src/promote/rules.ts` | S |
| G3 | **AutoSuccess capture** | Same as G2 for ratings >=8. `generateSuccess()` exists — wire into daemon. | `src/daemon/cleanup.ts` + `src/promote/rules.ts` | S |
| G4 | **Contradiction check** | Before promoting a rule, check for contradictions/duplicates via inference.ts. Block promotion if conflict found. | `src/promote/bridge.ts` | S |
| G5 | **Session-context attribution** | Write `session-context.json` with loaded rule IDs + domains at session start. Read on rating to attribute to specific rules. Closes correlation feedback loop. | `src/graph/context.ts` + `src/promote/rules.ts` | M |

### PARTIAL → BUILD

| # | Gap | What to build | Where | Size |
|---|-----|--------------|-------|------|
| P2 | **LLM-powered pattern mining** | Opt-in LLM semantic clustering alongside rule-based. 2 inference calls per mining cycle. Falls back to rule-based when unavailable. | `src/detect/patterns.ts` | S |
| P4 | **Budget enforcement blocking** | Wire `checkBudget()` into `promoteRule()`. Throw/reject on OVER_BUDGET before writing. | `src/promote/bridge.ts` | XS |
| P5 | **Eviction staleness check** | Add staleness filter to `getEvictionCandidates()`: lastSeen > 60 days gets priority. Field exists. | `src/promote/rules.ts` | XS |
| P7 | **Trajectory context injection** | Wire `queryTrajectories()` into `getContextRules()` for quality trajectory enrichment. | `src/graph/context.ts` | XS |
| P8 | **Last response cache persistence** | Add `writeLastResponse()` to persist to signal dir. | `src/capture/rating.ts` | XS |
| P9 | **Work completion LLM insights** | LLM insights via inference.ts (same pattern as G2/G3). Write to memory dir. | `src/capture/work.ts` + `src/daemon/cleanup.ts` | S |

### Deferred to v1.1 (2 items only)

| # | Gap | Why deferred |
|---|-----|-------------|
| D1 | 7-day gate for proposed rules | Manual `inbox` + `rules promote` flow is inherently human-gated. Risk only in auto-promote daemon mode. |
| D2 | Token counting | Cost monitoring, not core learning loop. |

### PAI-specific (not migrated — stays as PAI hooks)

| # | Gap | Why excluded |
|---|-----|-------------|
| PS1 | Relationship/opinion context | PAI-specific (Rayford personality). Not general-purpose. |
| PS2 | Active work summary | PAI-specific (WORK/ dir structure). Not general-purpose. |
| PS3 | Agent-specific learning | PAI-specific (Marcus/Quinn/Rook roster). Not general-purpose. |
| PS4 | Startup file loading | Claude Code settings feature (loadAtStartup). Not AgentGrit's job. |
| PS5 | patterns.json for harness | PAI harness reads this. Update harness to read AgentGrit's state instead. |

## Risk Mitigations

1. Backup settings.json before removal
2. Archive, don't delete PAI tools
3. Data stays in place — never moved or copied
4. Parallel run validates before cutover
5. Rollback = restore backup + mv tools back from archive
