---
doc-type: reference
status: active
updated: 2026-10-19
---

# @agentgrit/core

## Project Identity

> Self-learning engine that makes AI agents smarter over time.
**Tech:** Bun, TypeScript, ESM
- **Repo:** https://github.com/hornjason/agentgrit

## Rules

- Verify before asserting — try it first, report what actually happened
- Never fake results or hide failures — if it fails, report it honestly
- Fix all test failures before reporting done — a green suite is the minimum bar
- Run full test suite (`bun test`) and show real output — no summaries, no skipped files
- Fix the source, not the output — fix generator, not generated files
- Commit all changes before reporting done — uncommitted work is lost work
- Read PROJECT-STATE.md first on session start — it's the session bridge

## Commands

| Action | Command |
|--------|---------|
| Test | `bun test` |
| Type check | `bun run typecheck` |
| Conformity | `bun test test/scaffold-conformity.test.ts` |
| Create spec | `bunx rungate create-spec "title"` |
| Create SC | `bunx rungate create-sc --pattern <name> --params '<json>'` |
| Re-scaffold | `bunx rungate scaffold .` |

## Install / Consume

Published to npm as `rungate`.

```bash
bun add -d rungate
bunx rungate scaffold .
bunx rungate --help
```

Pin the version: re-scaffolding on a newer rungate rewrites generated files.


## Environment

**Dev:**
- Start: `bun run dev`
- Test: `bun test`

## Workflow
- **Repo:** https://github.com/hornjason/agentgrit
- **Test:** `bun test`
