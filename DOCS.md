---
doc-type: reference
status: active
owner: jason
updated: 2026-07-06
---

# AgentGrit — Documentation Index

**Start here.** Find the doc you need by what you're trying to do.

---

## I need to...

| I need to... | Read |
|---|---|
| Understand what AgentGrit is and how to use it | `docs/README.md` |
| See the full PAI → AgentGrit file mapping | `docs/migration-spec.md` |
| Check migration progress and phase status | `docs/migration-plan.md` |
| Understand the consolidation strategy (many→few files) | `docs/consolidation-plan.md` |
| See equivalence test matrix (40 tests) | `docs/TEST-MATRIX.md` |
| Understand bootstrap / init flow | `docs/bootstrap-spec.md` |
| Check what's open, broken, or in progress | [GitHub Issues](https://github.com/hornjason/agentgrit/issues) |
| Run tests | `bun test` (all) or `bun test --isolate test/unit/` (unit only) |
| Run the daemon | `agentgrit daemon run` |
| Check system health | `agentgrit doctor` |
| See rule budget status | `agentgrit rules budget` |
| Optimize prompts or skills | `agentgrit optimize --target prompts` or `--target skills --skill <name>` |

---

## Active docs reference

| Doc | Type | What it covers |
|---|---|---|
| `docs/migration-spec.md` | spec | 221-file mapping from PAI to AgentGrit modules |
| `docs/migration-plan.md` | spec | 8-phase migration plan with equivalence tests |
| `docs/consolidation-plan.md` | spec | How 145 keep/merge files consolidate into ~50 modules |
| `docs/TEST-MATRIX.md` | spec | 40 equivalence tests across 7 tiers |
| `docs/bootstrap-spec.md` | spec | Init wizard and first-run behavior |
| `docs/README.md` | reference | Package overview, CLI commands, architecture |
