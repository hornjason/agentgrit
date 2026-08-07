---
doc-type: reference
status: active
owner: jason
updated: 2026-08-07
---

# Changelog

## [0.1.8] — 2026-08-07

Full parity with PAI learning loop. 13 hooks, 44/44 Docker E2E tests, zero gaps remaining. Closes #176, #178, #187.

### New Features
- **Real-time incident detection** — PostToolUse/Bash hook captures errors the moment a command fails, not just at session end (#187). Closes the last parity gap vs PAI's learning loop.
- **Enriched graph context** — `graph context` output now includes Performance Signals (rating trends, averages) and Failure Patterns (recent error types) sections (#184)
- **Work completion capture** — `capture work-completion` subcommand + SessionEnd hook for AI-powered work insight generation (#182)
- **Incident analysis** — `capture incident-analysis` subcommand + SessionEnd hook for pattern analysis across session incidents (#183)
- **Session scoring** — `capture session-score` subcommand for end-of-session composite scoring (#181)
- **Debrief capture** — `capture debrief` subcommand for session-end rule extraction (#180)

### Fixes
- **`installClaudeCodeHooks` parity** — `init --claude-code` now installs all 13 hooks (was 3), matching `installHooks --bootstrap`. Hooks: SessionStart(graph context), 3×UserPromptSubmit(rating/correction/sentiment), 3×PostToolUse(tool/skill/incident), Stop(harvest), 5×SessionEnd(incident/session-score/debrief/incident-analysis/work-completion)
- **`graph context` subcommand** — new CLI command wires `getContextRules()` + `writeSessionContext()`, outputs rules wrapped in `<system-reminder>` tags for Claude Code hook injection
- **`pruneTobudget` stats merge** — prune now reads `rule-stats.json` (recalls→injectionCount, effectivenessRate→avgCorrelatedRating) so eviction uses real effectiveness data instead of positional fallback
- **`init --claude-code` writes `installed-hooks.json`** — manifest with hook count, timestamp, and version for coexistence verification

### E2E (44/44)
- Phase 1 (clean install): 16/16
- Phase 2 (integration with real data): 10/10
- Phase 3b (PAI coexistence): 8/8
- Phase 4 (parity gap features): 10/10

## [0.1.7] — 2026-08-05

Version bump + hardcoded VERSION string fix.

### Fixes
- `bin/agentgrit.ts` VERSION constant now matches package.json (was stuck at 0.1.4)

## [0.1.6] — 2026-08-05

Precision rebalance — retuned hybrid retrieval weights and wired vector search into the context injection pipeline. Closes #173.

### Breaking Changes
- RRF weight defaults changed from `{bm25: 1, graph: 1.5, vector: 1}` → `{bm25: 2, graph: 0.5, vector: 1}`. If you relied on the old defaults without config overrides, retrieval ranking will shift toward BM25 keyword relevance. Set `rrfWeights` in `~/.agentgrit/config.json` to restore old behavior.

### Improvements
- **Vector search wired into getContextRules()** — accepts `vectorCachePath` + `embeddingProvider` params, computes query embeddings via all-MiniLM-L6-v2, feeds ranked vector results into RRF merge (#173)
- **Weight optimizer threading fix** — `optimizeRRFWeights()` now passes candidate weights to `getContextRules()` instead of always using defaults
- **Grid-searched optimal weights** — 100 weight combinations evaluated against 34-session gold set; graph@1.5 was the worst setting, BM25 should dominate

### Stats
- 1367 tests across 112 files

## [0.1.5] — 2026-07-28

Major release — E2E testing infrastructure, retrieval quality improvements, rule lifecycle hardening, and 7 new CLI commands.

### New Features
- **Migration pipeline dashboard** — `agentgrit dashboard` generates HTML dashboard showing pipeline health (#167)
- **Living showcase dashboard** — `agentgrit showcase` generates a system health dashboard (#156)
- **Docker-based E2E test suite** — containerized end-to-end tests for the full capture→promote pipeline (#155)
- **Backfill learned rules** — `agentgrit backfill-learned` imports CLAUDE-LEARNED.md rule files (#154)
- **Claude Code hook generator** — `agentgrit init --claude-code` generates hook templates for settings.json integration (#125)
- **Rule effectiveness tracking** — before/after correction frequency per rule (#127)
- **Hybrid pattern detection** — confidence-gated pattern mining with BM25 agreement (#139)

### Retrieval Quality
- **Per-domain diversity cap** — max 3 rules per domain per source in retrieval results (#144)
- **Domain overlap scoring** — wired into getContextRules() via hybridRetrieve (#133)
- **Auto-generated BM25 patterns** — replace hardcoded keyword regexes with data-driven patterns (#132, #138)
- **Expanded domain taxonomy** — added scoring and pipeline domains
- **RRF weight tuning** — balance weights + include cluster connected nodes (#136)
- **Recall measurement pipeline** — bootstrap + live retrieval evaluation
- **Detect delivery/delegation domains** — detectDomains() expanded for ship queries (#133)

### Rule Lifecycle
- **Critical Rules demotion path** — eviction system can demote critical rules (#165)
- **Shared attribution pipeline** — extracted and wired into daemon (#161, #162)
- **Rule noise elimination** — close 5 feedback loop gaps (#157, #158)
- **Sync rule artifacts on promotion** — .md, rule-domains.json, CLAUDE-LEARNED.md all updated atomically (#140)
- **Auto-generate rule-domains.json** — created on first daemon run (#137)
- **Sync rule-domains.json during graph build** — keeps graph and domain map consistent (#143)
- **Auto-prune stale MEMORY.md entries** — wired as daemon action (#134)
- **Normalize rule IDs for eviction** — fixes matching edge cases (#148)
- **Persist rule stats** — wire eviction pipeline with durable state (#147)
- **Clean up orphaned promotions** — removed 31 orphans (#141)

### Fixes
- Float score parsing in `parseRating` — accepts decimal ratings (#166)
- Resolve rule IDs to human names in showcase
- Filter orphaned `traj-*` entries from trajectories
- Graph-bridge matching + legacy ID cleanup in rule-stats (#153)
- writeRuleFile targets memoryDir not signalDir/../rules
- Doctor checks memoryDir + rulesBase for orphaned nodes
- E2E script reliability (removed set -e, wired hooks manually, fixed pipefail crash)

### Testing
- End-to-end lifecycle tests for rule promotion and eviction (#145)
- `--force` flag for auto-domains command (#142)
- Full spec audit — domain coverage 98%

### Stats
- 1306 tests across 103 files (up from 665)

## [0.1.4] — 2026-07-05

Phase 1b complete — 11 capability gaps closed for PAI learning loop migration.

### New Capabilities (LLM-powered, via inference.ts)
- **Implicit LLM sentiment** — `capture sentiment` subcommand scores every user message via Haiku, writes to `sentiment.jsonl`. Keyword fallback when inference unavailable. (#41)
- **AutoFeedback generation** — daemon extracts behavioral lessons from sessions rated <=4, writes `feedback_*.md` to memory dir (#42)
- **AutoSuccess capture** — daemon captures positive patterns from sessions rated >=8, writes `success_*.md` (#43)
- **Contradiction check** — LLM-based duplicate/conflict detection before rule promotion. Blocks conflicting rules. (#44)
- **Session-context attribution** — writes `session-context.json` at session start with loaded rule IDs; ratings attributed to specific rules for correlation (#45)
- **LLM-powered pattern mining** — opt-in semantic clustering alongside rule-based detection. Falls back to deterministic. (#46)
- **Work completion LLM insights** — enriched learnings from work completions, wired into daemon cycle (#47)

### Pipeline Fixes
- **Budget enforcement blocking** — `promoteRule()` now calls `checkBudget()` and throws on OVER_BUDGET (#40)
- **Eviction staleness check** — rules with `lastSeen > 60 days` get priority eviction (#40)
- **Trajectory context injection** — `queryTrajectories()` wired into context rule assembly (#40)
- **Last response cache persistence** — `writeLastResponse()` persists to signal dir (#40)

### Stats
- 665 tests, 1,351 assertions, 0 failures (up from 596)
- 69 new tests across 11 test files

## [0.1.3] — 2026-07-04

- Bumped version for npm republish

## [0.1.2] — 2026-07-04

- Updated description: "Self-learning engine that makes AI agents smarter over time" (not just coding agents)
- README updated to reflect broader AI agent scope

## [0.1.1] — 2026-07-04

- Fixed npm bin field — `.mjs` extension was stripped by npm, changed to `.js`
- Added Claude Code discovery and signal backfill (`agentgrit init --bootstrap`)
- Added capture CLI subcommands for hook signal capture (`agentgrit capture rating|correction|tool|skill`)
- All CLI commands now read `signalDir` from config (PAI integration works end-to-end)
- Switched from compiled Bun binary (59MB) to transpiled Node bundle (75KB)
- Replaced 28 Bun-specific APIs with Node equivalents
- Re-enabled hook installation in init

## [0.1.0] — 2026-07-03

Initial release. Self-learning engine that makes AI agents smarter over time.

### Core Features

**Signal Capture** — automatic detection and logging of quality signals
- Rating capture with M:N S:N Q:N dimension parsing
- Correction detection with 10-word noise filter (approval words excluded)
- Sentiment scoring, failure capture with severity classification
- Skill invocation + sequence tracking, tool audit logging
- Debrief extraction (rules, corrections, approvals from session transcripts)
- Work completion learning with approach/tooling categorization

**Pattern Detection** — finds recurring failure themes across sessions
- Failure pattern clustering with log2-frequency + recency severity scoring (5-10 range)
- Theme cohort analysis across 6 cohort definitions
- Anti-rationalization rebuttal generation
- Trajectory storage with quality-based eviction (cap: 100)
- Cross-signal pattern mining

**Rule Promotion** — surfaces candidates and manages the rule lifecycle
- Three-tier routing: global CLAUDE.md (25 cap), project CLAUDE.md (25 cap), graph (unlimited)
- Budget enforcement with per-tier caps
- Candidate inbox with severity/frequency ranking
- Rule correlation tracking against session ratings
- Promotion ledger with before/after snapshots + undo
- Auto-feedback and auto-success memory generation
- 7-day promotion gate (candidates must age before promotion)

**Knowledge Graph** — builds a domain-aware rule graph from memory files
- Automatic graph construction from markdown memory files
- Incremental rebuild with content hash caching
- BM25 keyword search + graph-aware hybrid retrieval (RRF fusion)
- Domain detection and domain-scoped querying
- Near-duplicate detection, memory type classification

**Evaluation** — measures how well the system recalls and applies rules
- Recall@K, Precision@K, MRR metrics with bootstrap confidence intervals
- Session recall evaluation against graph rules
- Gold set auto-labeling from sessions + synthetic generation
- Impact analysis and tool audit analysis
- LLM judge with batch scoring and JSONL persistence

**Optimization** — hill-climbing improvement of prompts and skill descriptions
- Hill-climb engine with propose→evaluate→keep/discard loop
- Max 15% change ratio enforcement per iteration
- Prompt tuner and skill tuner
- Fast deterministic evaluation (regex-based, no LLM needed)
- Per-skill criteria registry
- Experiment logging to JSONL

**Daemon** — background orchestration of the full learning cycle
- Single-cycle runner: score→detect→promote→sync→optimize
- CLI: `agentgrit daemon run|start|stop|status`
- LaunchAgent/systemd scheduler installation
- Health doctor with 10+ checks (config, cross-references, budget)
- Session compression and metric count updates

**Adapters** — Claude Code integration layer
- Hook generation for Claude Code settings.json
- CLAUDE.md injection (read + write with atomic temp-then-rename)
- Session transcript parsing
- Memory file discovery and template resolution
- Langfuse integration (optional): connect, sync scores, fetch/cache traces

**LLM Inference** — zero API keys required
- Uses `claude` CLI subprocess (ships with Claude Code)
- Three tiers: fast (haiku), standard (sonnet), smart (opus)
- Strips ANTHROPIC_API_KEY from env to force subscription auth
- Optional: configure alternative providers (Gemini, OpenAI) with API keys

### CLI Commands

13 commands available via `npx agentgrit <command>`:

| Command | Description |
|---------|-------------|
| `init` | Initialize AgentGrit in a project |
| `status` | Signal counts, score trends, budget |
| `doctor` | Health checks with pass/warn/fail |
| `signals` | Signal file sizes and entry counts |
| `review` | Pattern analysis and candidate detection |
| `inbox` | Candidate rules with severity/tier/frequency |
| `rules` | Budget display per tier |
| `rules promote` | Promote inbox candidates to CLAUDE.md |
| `export` | Export graph + rubrics + config as JSON |
| `undo` | Revert last promotion from ledger snapshot |
| `upgrade` | Switch adoption tier (quick→standard→full) |
| `graph build` | Build knowledge graph from memory files |
| `graph query` | Query graph by domain |
| `graph stats` | Node/edge/domain counts |
| `eval traces` | Score traces against rubric |
| `eval recall` | Recall accuracy report |
| `daemon run` | Run one learning cycle |
| `daemon start` | Install and start scheduler |
| `daemon stop` | Stop scheduler |
| `daemon status` | Check daemon health |

### Adoption Tiers

- **Quick Start** (zero API keys) — capture, detect, promote, inbox, undo
- **Standard** (zero API keys with claude CLI) — adds LLM judge, graph, evaluation
- **Full Auto** (zero API keys with claude CLI + daemon) — adds optimization, auto-promotion, scheduled cycles

### Stats

- 46 source files, 25,044 lines of TypeScript
- 543 tests, 1,049 assertions, 0 failures
- 82 of 95 test matrix items pass (6 need Langfuse, 5 deferred to v1.1)

### Known Limitations

- `init --bootstrap` not implemented (auto-seed from existing data) — #32
- `init --import` not implemented (import from export JSON) — #33
- `undo --yes` flag for non-interactive use — #34
- Langfuse integration requires separate Langfuse credentials (optional feature)
