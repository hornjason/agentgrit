# Naming Convention

## Files

All source files use **kebab-case**:

```
src/capture/rating.ts
src/evaluate/session.ts
src/graph/hybrid-retrieval.ts
src/optimize/hill-climb.ts
```

## Code

| Construct | Convention | Example |
|-----------|-----------|---------|
| Files | kebab-case | `skill-invocation.ts` |
| Classes | PascalCase | `class PatternDetector` |
| Interfaces/Types | PascalCase | `interface GraphNode` |
| Functions | camelCase | `function detectFailures()` |
| Constants | UPPER_SNAKE_CASE | `const MAX_RULES = 25` |
| Variables | camelCase | `let signalCount = 0` |
| Enum members | PascalCase | `enum Tier { Global, Project, Graph }` |

## Directories

All directories use **kebab-case** and match the module name from the architecture:

```
src/capture/       src/evaluate/      src/detect/
src/promote/       src/optimize/      src/graph/
src/adapters/      src/daemon/        bin/
```

## Migration Renaming

When migrating from PAI's PascalCase filenames:

| PAI | AgentGrit |
|-----|-----------|
| `GraphBuilder.ts` | `builder.ts` |
| `FailurePatternDetector.ts` | `failures.ts` |
| `LangfuseContentEvaluator.ts` | `content.ts` |
| `HybridRetrieval.ts` | `hybrid-retrieval.ts` |

The module directory provides the namespace — file names describe the specific concern within that module.
