---
doc-type: reference
status: active
owner: jason
updated: 2026-08-24
---

# Scoring Mechanism Redesign

**Issue:** #252
**Status:** Sprint 1 — Define + Instrument
**Council debate:** 2026-08-23, 4 agents (Serena, Marcus, Ava, Rook), 3 rounds
**Decision date:** 2026-08-23

## Problem Statement

The current scoring mechanism uses keyword proxies (counting "perfect", "wrong", "stop") to auto-score sessions 1-10. This is structurally biased:

| Flaw | Impact |
|------|--------|
| Silence = 6.0 | Great quiet work = doing nothing |
| Corrections penalize iteration | Bold work looks bad |
| 99% auto-scored via keywords | 11/833 ratings are from the user |
| Session-end only | Long sessions with context clears are unscored |
| Global rule attribution | Correction at turn 26 blames ALL rules |

**Key insight (ACL 2026):** "The precision of the evaluation module determines the ceiling of self-improvement — a noisy scorer produces a noisy gradient, and the agent's policy converges to the wrong optimum."

## Council Decisions (unanimous)

1. **Define success programmatically before building the scorer.** "Define the oracle before building the judge."
2. **Forward-only scoring.** Turn-level rule snapshots don't exist in historical data. Backfill is statistical approximation, not attribution.
3. **Signal quality determines the ceiling.** Keyword proxy must be replaced with outcome-based scoring.
4. **Start narrow, expand based on evidence.** One task type first, measure delta, iterate.

## Architecture

### What "success" means programmatically

For **ship tasks** (most common, most measurable):

| Signal | Type | Weight | Source |
|--------|------|--------|--------|
| Commit merged to main | Positive | 1.0 | git hooks |
| Tests pass after changes | Positive | 0.8 | test runner |
| Issue closed | Positive | 1.0 | gh API |
| PR merged | Positive | 0.8 | gh API |
| No regressions | Positive | 0.5 | test diff |
| User correction | Negative | -0.3 | correction capture |
| User reprompt (>60% overlap) | Negative | -0.5 | reprompt detection |
| Correction + fix in one turn | Neutral | 0.0 | healthy iteration, NOT penalty |

### Scoring boundaries

Context clears and compaction events define mini-session boundaries. Each mini-session gets its own score. Mini-sessions roll up to session score weighted by outcome (not averaged).

### Turn-level rule snapshots

Each context refresh writes a snapshot: `{ turn: N, activeRules: [...], timestamp: T }`. This enables per-turn attribution — corrections at turn 26 only blame rules active at turn 26.

### Historical data handling

- Historical data: pattern mining with +-30% confidence bands
- No backfill pretending to be ground truth
- Forward-only scoring from Sprint 1 ship date
- Historical keyword scores preserved for trend comparison

## Sprint Plan

### Sprint 1: Define + Instrument (current)

1. Define `OutcomeEvent` type with task completion signals
2. Outcome capture hook fires on commit/merge/close events
3. Turn-level rule snapshots (active rules at each turn)
4. Mini-session boundaries at context clears/compaction
5. Baseline comparison: keyword score vs outcome score on 20 sessions

### Sprint 2: Replace keyword scoring for ship tasks

1. Outcome-based scorer computes score from actual events
2. A/B compare lift under both scorers
3. differentialLift recomputed with outcome scores
4. Forward-only from Sprint 1 ship date

### Sprint 3: Expand + per-turn attribution

1. Additional task types (research, design, debugging)
2. Per-turn rule attribution (blame only active rules)
3. Aggregation: weighted by outcome, not averaged
4. Historical confidence bands

## Adversarial attacks to address

| Attack | Status | Mitigation |
|--------|--------|------------|
| Programmatic success undefined | Sprint 1 | Concrete signals above |
| Circular measurement (self-scoring) | Sprint 2 | External validation via test results |
| False negative blindness | Deferred | Can't measure rules that should fire but don't |
| Aggregation corruption | Sprint 3 | Outcome-weighted rollup, not averaging |
| Context clear gaming | Low risk | Boundaries are detection, not input |

## Research References

- Langfuse: span-level scoring (per tool call, not per session)
- Braintrust: async LLM-as-judge with 0.87 correlation to human judgment
- Hermes: per-invocation skill improvement from correction frequency
- ACL 2026: Inference-Time Feedback for Tool-Calling Agents
- Self-Improving Agent Survey 2026: evaluation precision = improvement ceiling
