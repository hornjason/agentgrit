---
doc-type: code-map
status: generated
updated: 2026-10-05
scanned-at-sha: 4dca3b99
generator: rungate/scripts/generate-code-map.ts
---

# Code Map — @agentgrit/core

Auto-generated architecture snapshot. Re-run `bun generate-code-map.ts .` to refresh.
Regenerate when src/ has commits since scanned-at-sha.

## Summary

| Metric | Count |
|--------|-------|
| Source directories | 9 |
| Dependencies | 0 |
| Dev dependencies | 3 |
| API routes | 0 |
| React components | 0 |
| Entry points (fallow) | 145 |
| Unused files | 23 |
| Unused exports | 81 |
| Circular dependencies | 6 |
| Module import mappings | 0 |
| Page-component mappings | 0 |

## Directory Structure

| Directory | Files | Types |
|-----------|-------|-------|
| test/ | 231 | detect, capture, ts, optimize, bin |
| src/ | 111 | detect, capture, optimize, promote, graph |
| bin/ | 31 | md, ts, commands |
| docs/ | 12 | md, adr, png |
| scripts/ | 7 | ts, py |
| .claude/ | 6 | rules, md |
| rubrics/ | 2 | json, md |
| templates/ | 1 | md |
| specs/ | 0 |  |

## Code Health (fallow)

### Circular Dependencies (6)

- src/graph/builder.ts → src/graph/domain-propagation.ts
- src/graph/builder.ts → src/graph/generate-patterns.ts
- src/promote/auto-eviction.ts → src/promote/lifecycle.ts
- src/promote/bridge.ts → src/promote/budget.ts
- src/promote/bridge.ts → src/promote/budget.ts → src/promote/evict.ts
- src/promote/bridge.ts → src/promote/budget.ts → src/promote/evict.ts → src/promote/lifecycle.ts

### Unused Files (23)

- bin/agentgrit.ts
- bin/commands/cleanup-orphans.ts
- bin/commands/context.ts
- bin/commands/daemon.ts
- bin/commands/eval.ts
- bin/commands/evict.ts
- bin/commands/graph.ts
- bin/commands/health.ts
- bin/commands/memory.ts
- bin/commands/optimize.ts
- bin/commands/patterns.ts
- bin/commands/test.ts
- bin/commands/upgrade.ts
- scripts/apply-gold-corrections.ts
- scripts/build-doc-sections.ts
- ... and 8 more

## Package Scripts

- `test`
- `build`
- `prepublishOnly`
- `lint`
- `typecheck`
