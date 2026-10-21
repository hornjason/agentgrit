---
description: Key files and documentation routing for this project
generated-sha: 6a810da7a263b89c
---

## Key Files

| File | What | When to Read |
|------|------|--------------|
| AGENTS.md | Project entry point | Always first |
| PROJECT-STATE.md | Live status + handoff. DA-owned (#296) — nothing in this project reads project-state.json, so this file is maintained directly and regenerating it would destroy its contents | Session start, always first after AGENTS.md |
| project-state.json | Source of truth for project status | When editing state |
| .claude/rungate/ | Harness project config (directory) | Shipping through harness |
| package.json | Dependencies and scripts | Adding deps or scripts |
| tsconfig.json | TypeScript configuration | Changing TS settings |
| src/ | Src directory | Working on src |

| `CODE-MAP.md` | Auto-generated codebase map | Understanding codebase structure |
