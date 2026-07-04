# Changelog

## [0.1.0] — 2026-07-03

Initial release. Self-learning loop for AI coding agents that makes them improve over time.

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
