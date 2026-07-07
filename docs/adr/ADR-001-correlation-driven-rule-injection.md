---
doc-type: adr
status: active
owner: jason
updated: 2026-07-07
---

# ADR-001: Correlation-Driven Rule Injection

**Status:** Proposed
**Date:** 2026-07-07
**Deciders:** Jason Horn, Serena Blackwood (Architect)

---

## Context

PAI currently loads rules from three static files at session start:

| File | Rules | Size |
|---|---|---|
| `CLAUDE.md` | ~41 bullet rules | 16 KB |
| `CLAUDE-LEARNED.md` | 76 learned rules | 23 KB |
| `AISTEERINGRULES.md` | ~16 rules | est. 5 KB |
| **Total** | **~117+ rules** | **~44 KB** |

Every session loads all 117 rules regardless of task domain. This problem is tracked in two existing pai-config issues:

- **#28 "Domain-gated rules"** -- proposed domain tagging (`[domain: ddb]`, `[domain: universal]`) and session-start context injection filtered by domain match. Identified the core problem: a DDB container rule is irrelevant during PAI infrastructure work.
- **#79 "Dynamic learned-rule injection for agent briefs"** -- proposed a `RuleInjector.ts` utility to select 5-10 relevant rules from CLAUDE-LEARNED.md based on task domain keywords, with a 500-token budget cap per brief. Scoped to Marcus briefs only; did not address DA-level injection.

This ADR supersedes both by addressing the problem at the system level -- DA context + agent briefs + correlation-based ranking -- rather than piecemeal solutions.

The current static loading creates three documented failure modes:

1. **Rule competition** -- RHEL scraper session read the runbook (correct rule fired), then bypassed it because competing rules about scope minimization and delegation overrode the domain-specific guidance. More rules = more chances for the wrong rule to win.
2. **Attention dilution** -- AgentGrit migration missed 28 files. The agent had so many rules competing for attention that domain-specific completeness checks lost salience.
3. **Token budget pressure** -- PAI issue #90 measured 91 rules consuming 48 KB of context. At ~4 tokens/word, that is ~12K tokens of rules alone -- roughly 10% of a standard context window, loaded before any task-specific content.

AgentGrit already has the machinery to solve this. The graph retrieval pipeline (`getContextRules()` in `src/graph/context.ts`) uses domain detection + BM25 + RRF reranking to select contextually relevant rules. The correlation scoring system (`trackRule()`, `trackAttributedRules()` in `src/promote/rules.ts`) tracks which rules correlate with high-rated sessions. The three-tier router (`src/promote/router.ts`) classifies rules as Global, Project, or Graph tier. The budget system (`src/promote/budget.ts`) already caps Global and Project at 25 each.

The infrastructure exists. The question is whether to wire it into the session-start path as the primary rule delivery mechanism.

---

## Decision

**Replace bulk static loading with correlation-driven contextual injection.** Keep a small universal set (~10 rules) always loaded. Deliver the remaining ~100 rules through AgentGrit's graph retrieval, filtered by task domain and ranked by correlation score.

### Architecture

```
Session Start
  |
  ├── Universal Rules (always loaded, ~10 rules, ~4 KB)
  │   Hard-wired in CLAUDE.md. Cannot be evicted.
  │
  ├── Domain Detection (detectDomains() in context.ts)
  │   Scans task prompt for domain keywords.
  │   Returns: ["deployment", "ui-testing", "delegation", ...]
  │
  ├── Graph Retrieval (getContextRules() in context.ts)
  │   Queries graph for domain-matched clusters.
  │   BM25 fills gaps. Optional API reranker.
  │   Returns: 10-20 rules ranked by relevance.
  │
  ├── Correlation Filter (rules.ts)
  │   Ranks candidates by avgCorrelatedRating.
  │   Drops rules with low correlation + high injection count.
  │   Evicts stale rules (>60 days unseen).
  │
  └── Session Context (writeSessionContext())
      Records which rules were injected + domains.
      Enables attribution at session end.
```

### Universal Rules (Always Loaded)

These rules address fundamental constraints that apply regardless of domain. They are the "physics" of PAI -- constraints that cannot be contextually gated without risking systemic failure:

1. Verify before asserting (negative assertions get same evidence bar)
2. Mandatory output format (ALGORITHM / NATIVE / MINIMAL)
3. Extreme concision
4. Surface assumptions before implementing
5. Corrections trigger immediate CLAUDE.md edits
6. Flag memory rule conflicts before executing
7. Delegation matrix (who does what)
8. `mode: "bypassPermissions"` on all agent spawns
9. Never declare done without user flow confirmation
10. Spec-driven work -- read spec at every decision point

Selection criteria: A rule is universal if removing it from ANY session type would cause a documented failure mode. Domain-specific rules (container deployment, Gemini config, Playwright automation) are not universal -- they cause failures only when the domain is active.

### Injected Rules (Contextual, 10-20 per session)

Delivered by `getContextRules()`. Ranked by:
- Domain overlap score (50% weight in `scoreNode()`)
- Edge strength in knowledge graph (30% weight)
- Severity / recency (20% weight)
- Correlation score from `avgCorrelatedRating` (tiebreaker)

The existing `writeSessionContext()` / `readSessionContext()` functions already record which rules were injected and their domains, enabling attribution when Jason rates a session.

### Agent-Specific Scoping

Spawned agents (Marcus, Quinn, Rook) already receive scoped briefs. This decision does not change agent briefs -- it changes the DA's own rule set. Agent brief templates in `BRIEF-TEMPLATES.md` remain the scoping mechanism for spawned agents. The DA's contextual rules inform which brief template sections the DA emphasizes, not what the agent sees.

---

## Consequences

### Benefits

- **Reduced rule competition:** 15-20 contextual rules vs 117 static. Domain-specific rules only compete when the domain is active.
- **Token savings:** ~8-10 KB freed per session (~3K fewer tokens). More room for task context, file content, agent reports.
- **Measurable rule quality:** Every rule accumulates `avgCorrelatedRating` and `injectionCount`. Low-performing rules surface via `getEvictionCandidates()` automatically.
- **Self-pruning:** Stale rules (>60 days unseen via `isStale()`) and low-correlation rules naturally lose rank. No manual curation needed.
- **Domain precision:** Deployment sessions get deployment rules. Browser sessions get browser rules. The existing `detectDomains()` regex map in `context.ts` already covers 13 domain categories.

### Risks

- **Cold start:** New rules have no correlation data. Mitigation: new rules start with `correlationScore: 0` and get a 5-session probation period (already handled by `MIN_INJECTION_COUNT = 5` in `getEvictionCandidates()`).
- **Domain detection miss:** If `detectDomains()` returns `[]`, the system falls back to `DEFAULT_DOMAINS = ["verification", "delivery", "deployment"]`. This is a safe default but may miss niche domains. Mitigation: expand the regex map iteratively; the BM25 fallback catches keyword matches the regex misses.
- **Universal set drift:** If the universal set grows back toward 30+ rules, we are back to the original problem. Mitigation: hard cap the universal set at 12. Any proposed addition must displace an existing universal rule or go to graph tier.
- **Attribution accuracy:** Correlation only works if sessions receive ratings. Unrated sessions contribute no signal. Mitigation: the existing implicit sentiment scoring (`SentimentSignal`) provides a fallback rating for unrated sessions.

### Neutral

- **Agent briefs unchanged.** Marcus, Quinn, and Rook continue to receive per-task briefs. This decision affects only the DA's session-start context.
- **Budget caps unchanged.** Global: 25, Project: 25, Graph: unlimited. The budget system already enforces these.
- **Daemon cycle unchanged.** The daemon (`runDaemonCycle()`) already handles scoring, pattern detection, promotion, pruning, and optimization. No daemon changes needed.

---

## Alternatives Considered

### 1. Keep Static Loading, Just Prune More Aggressively

Already attempted. The count went from ~130 to ~117 via the 2026-06-19 tiering. The problem is structural: static loading cannot adapt to session context. Pruning removes rules permanently; contextual injection keeps them available but only surfaces them when relevant. Pruning also requires human judgment about which rules to remove. Correlation scoring automates this judgment with evidence.

### 2. Manual Domain Tagging (No Graph)

Tag each rule with domains manually, load only matching tags. Simpler than graph retrieval but requires manual maintenance. New rules need domain tags. Domain boundaries shift. The graph already handles this automatically via `same_domain` edges and embedding-based clustering. Manual tagging duplicates what the graph does with worse accuracy.

### 3. LLM-Based Rule Selection

Use an LLM call at session start to select relevant rules from the full set. Adds latency (~2-5 seconds), costs tokens, and introduces nondeterminism into rule selection. The existing deterministic pipeline (domain regex + graph query + BM25) is faster, cheaper, and reproducible. LLM reranking is available as an optional final pass via `getContextRulesWithReranking()` but should not be the primary selector.

---

## Additional Decision Points

### 1. Document Types and Templates

**Minimum document set for the rule management lifecycle:**

| Document | Purpose | Template needed? |
|---|---|---|
| ADR | Architectural decisions | Yes -- this document establishes the format |
| Spec | Feature specifications (WHAT/WHY) | Yes -- M/L features need a spec before implementation |
| Brief | Agent task assignments | Already templated in `BRIEF-TEMPLATES.md` |
| PRINCIPLES.md | Immutable architectural constraints | No template -- curated manually |
| CONTEXT.md | Domain vocabulary and project state | No template -- grows organically |

**Spec template recommendation:** Yes, specs should have a template. The minimum viable spec template:

```markdown
# Spec: [Title]
**Status:** Draft | Approved | Implemented
**Issue:** #NNN

## Problem
[What pain exists today]

## Success Criteria
[Measurable outcomes -- must pass the garbage test]

## Approach
[How we solve it -- links to ADRs if architectural]

## Out of Scope
[What this does NOT do]
```

The template enforces the garbage test (AC measurability) mechanically -- if a spec has no Success Criteria section, the ship skill's SCOPE gate rejects it.

### 2. Council Challenge for DROP/DEFER Dispositions

When a rule review recommends DROP or DEFER for a rule, the disposition should be challenged before execution. The council pattern (3 parallel agents debating) is too heavy for individual rule dispositions. Instead:

**Proposed gate:** Before any DROP, the system must show:
- The rule's `avgCorrelatedRating` (evidence of harm or irrelevance)
- The rule's `injectionCount` (evidence of sufficient data)
- At least one session where the rule was active and the rating was low
- Whether any other rule in the graph has a `reinforces` or `sibling` edge to the dropped rule

If the dropped rule has `reinforces` edges to high-performing rules, the DROP is blocked and escalated to human review. This uses the existing graph edge data without requiring a council debate.

Council challenge IS appropriate for bulk dispositions (e.g., "drop all rules with avgCorrelatedRating < 3.0") -- those affect multiple rules simultaneously and warrant adversarial review.

### 3. M/L Spec Requirement in Scope Gate

The ship skill's SCOPE step should enforce:
- **XS/S sizing:** No spec required. ACs in the issue body are sufficient.
- **M sizing:** Spec required if the change touches >3 files or introduces a new module. Spec can be a section in the issue body.
- **L sizing:** Full spec document required in `docs/specs/`. Must be approved before BUILD step begins.

Enforcement mechanism: The SCOPE step already reads issue metadata. Add a check: if declared size is M or L and no spec link exists in the issue, SCOPE returns a blocking error with a link to the spec template. This is a bash gate, not a rule -- it cannot be bypassed by rule competition.

### 4. Mis-Size Detection in Verify Gate

After BUILD completes, the verify gate should compare actual scope against declared size:

| Declared | Actual files changed | Verdict |
|---|---|---|
| XS | >3 files | WARNING: may be undersized |
| S | >5 files | WARNING: may be undersized |
| M | >15 files | WARNING: may be undersized, needs spec |
| L | <3 files | INFO: may be oversized (not a problem) |

Enforcement mechanism: `git diff --stat` after Marcus reports, count files changed. If file count exceeds the threshold for declared size, the verify gate emits a warning and asks the DA: "Marcus changed N files on an XS task. Re-evaluate sizing?" This is informational, not blocking -- some XS tasks legitimately touch many files (e.g., a rename). But the signal surfaces scope creep before it compounds.

### 5. Rules That Should Become Mechanical Bash Gates

Rules that encode procedural steps (not behavioral judgment) should be converted from CLAUDE.md text into executable gates. Text rules can be ignored under attention pressure. Bash gates cannot.

**Candidates for mechanical conversion:**

| Current rule | Mechanical gate |
|---|---|
| "Marcus must commit before reporting done" | Post-agent hook: `git log --oneline -1` in worktree; fail if no new commits |
| "Log bug, ask can we test, add test, THEN fix" | Ship SCOPE step: require `test_file` field before BUILD proceeds |
| "Use Makefile targets for containers" | Pre-commit hook: reject raw `docker`/`podman` commands in shell history |
| "Hedge-grep gate after Marcus report" | Post-agent hook: `grep -ciE "(probably\|should work\|might\|likely)"` on agent output |
| "Never bypass ship scope" | Already mechanical: ship skill enforces SCOPE before BUILD |
| "Read templates before ACs" | Ship SCOPE step: verify template hash was read before AC generation |

**Selection criteria:** If a rule says "always do X before Y" or "never do X without Y" -- and both X and Y are observable shell events -- the rule is a candidate for a bash gate. If a rule requires judgment ("surface assumptions"), it must remain a text rule.

---

## PRINCIPLES.md Update

AgentGrit does not currently have a PRINCIPLES.md. When one is created, it should include:

1. **Universal rules are capped at 12.** Any addition must displace an existing universal rule or be routed to graph tier. This prevents the universal set from growing back to bulk-load size.

2. **Correlation score is the arbiter of rule value.** Rules without sufficient injection data (< 5 sessions) are in probation. Rules with high injection count and low correlation are eviction candidates. Human override is available but must cite evidence.

3. **Mechanical gates over text rules for procedural constraints.** If a rule can be enforced by a bash gate or hook, it should be. Text rules are for behavioral judgment that requires context.

4. **Domain detection is additive, never subtractive.** New domain regex patterns can be added to `detectDomains()` without removing existing ones. Removing a domain pattern requires an ADR.

5. **Attribution is mandatory for learning.** Every session must record which rules were injected (`writeSessionContext()`). Without attribution, correlation scoring has no data. Unrated sessions use implicit sentiment scoring as fallback.

---

## Implementation Roadmap

### Phase 1: Classify and Separate (1-2 issues)
- Audit all 117 rules; classify each as Universal or Graph-tier
- Extract ~10 universal rules into a clearly marked CLAUDE.md section
- Move remaining rules into memory files with domain tags (already partially done via CLAUDE-LEARNED.md tiering)

### Phase 2: Wire Graph Retrieval to Session Start (2-3 issues)
- Add a session-start hook that calls `getContextRules()` with detected domains
- Inject retrieved rules into the session context (CLAUDE.md system section or equivalent injection point)
- Implement `writeSessionContext()` call to record what was injected

### Phase 3: Mechanical Gates (2-3 issues)
- Convert 4-6 procedural rules into bash gates (hooks, pre-commit, post-agent)
- Remove the text versions from CLAUDE.md once the gates are verified
- Add gate verification tests

### Phase 4: Feedback Loop (1-2 issues)
- Wire `trackAttributedRules()` into the rating/debrief flow
- Dashboard or CLI command to view rule correlation scores (`agentgrit rules budget` already exists; extend with correlation view)
- Set up the eviction pipeline: low-correlation rules surface for review weekly

### Phase 5: Spec and Size Gates (1-2 issues)
- Add spec requirement check to ship SCOPE step for M/L sizing
- Add file-count mis-size detection to verify gate
- Add spec template to `docs/specs/`

**Total: 7-12 issues across 5 phases. Phases 1-2 are sequential. Phases 3-5 can run in parallel after Phase 2.**
