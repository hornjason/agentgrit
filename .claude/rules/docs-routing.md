---
description: Documentation routing and file creation conventions
---

## Documentation Routing

| I need to understand... | Read |
|------------------------|------|
| Codebase structure (routes, components, modules, health) | `CODE-MAP.md` |
| Current project state, priorities, and session history | `PROJECT-STATE.md` |
| Specs — success criteria, constraints, requirements (1 files) | `specs/` |
| ADRs — architecture decisions (1 files) | `docs/adr/` |
| Research — findings, evaluations, competitive analysis | `docs/research/` |
| Council — synthesis, design debates | `docs/council/` |
| Guides — setup, onboarding, reference | `docs/guides/` |
| Reference — historical and inactive docs (0 files) | `reference/` |

## Where to Create Things

| Type | Location | Frontmatter | Notes |
|------|----------|-------------|-------|
| Specs | `specs/` | `doc-type: spec`, `testable`, `governs` | SCs auto-generate tests |
| ADRs | `docs/adr/` | `doc-type: adr`, `status`, `created` | Architecture decisions |
| Research | `docs/research/` | `doc-type: research`, `governs` | Tool evaluations, competitive analysis, findings |
| Council | `docs/council/` | `doc-type: council` | Council synthesis, design debates |
| Guides | `docs/guides/` | `doc-type: guide` | Setup, onboarding, reference |
| Reference | `reference/` | — | Historical reference |
| Source code | `src/` | — | Follow existing module structure |
| Tests | `test/` | — | Mirror source structure |
