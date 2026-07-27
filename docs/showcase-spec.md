---
doc-type: spec
status: active
owner: jason
updated: 2026-07-27
---

# Showcase Dashboard Spec

**Version:** 1.0 (2026-07-27)
**Generator:** `agentgrit showcase`
**Output:** `~/.agentgrit/state/showcase.html` (generated, not committed)
**Spec:** `docs/showcase-spec.md` (committed, governs the generator)

## Data Contract

Every dynamic value in the showcase is a metric token. The generator reads live data and fills these tokens.

| Token | Source File/Command | Type | Label |
|---|---|---|---|
| `RATING_COUNT` | `wc -l {signalDir}/ratings.jsonl` | number | Ratings Captured |
| `CORRECTION_COUNT` | `wc -l {signalDir}/correction-captures.jsonl` | number | Corrections Tracked |
| `NODE_COUNT` | `{stateDir}/knowledge-graph.json → nodeCount` | number | Knowledge Graph Nodes |
| `EDGE_COUNT` | `{stateDir}/knowledge-graph.json → edgeCount` | number | Graph Edges |
| `DOMAIN_COUNT` | `{stateDir}/knowledge-graph.json → unique domains` | number | Domains |
| `EFFECTIVENESS` | `{stateDir}/rule-stats.json → % with avgCorrelatedRating >= 5` | percent | Rule Effectiveness |
| `RULES_PER_SESSION` | `{stateDir}/rule-stats.json → avg injectionCount` | number | Avg Rules/Session |
| `SCORE_TREND` | `{stateDir}/rule-stats.json → overall avg rating` | decimal | Avg Correlated Rating |
| `RECALL_AT_15` | `{stateDir}/recall-eval.json → meanRecall15` | decimal | Recall@15 |
| `PRECISION_AT_5` | `{stateDir}/recall-eval.json → meanPrecision5` | decimal | Precision@5 |
| `MRR` | `{stateDir}/recall-eval.json → meanMrr` | decimal | Mean Reciprocal Rank |
| `BUDGET_GLOBAL` | `config.json → rules.globalBudget` | string | Global Budget |

Path resolution uses `getBaseDir()`, `stateDir()`, `signalsDir()` from `src/adapters/paths.ts`. Signal files use `resolveSignalFile()` for alias resolution (e.g., `corrections.jsonl` → `correction-captures.jsonl`).

## Section Contract

| Section | Content | Static/Dynamic | Regeneration Trigger |
|---|---|---|---|
| Hero | Title, tagline, generated timestamp | Dynamic (timestamp) | Every regeneration |
| Loop Diagram | 6-stage circular SVG with per-stage metrics | Dynamic | Graph build, daemon cycle |
| Metrics Dashboard | 12 metric cards with large numbers | Dynamic | Any data source change |
| How It Learns | 3-panel explainer (correction → pattern → rule) | Static | Never (structural) |
| Domain Taxonomy | Domain names with node counts | Dynamic | Graph build |
| Top/Bottom Performers | 5 best + 5 worst correlated rules | Dynamic | Daemon cycle (attribution) |
| Health Status | Green/amber/red indicators | Dynamic | Doctor output |
| Technical Footer | Package version, test count | Semi-static | Version bump |

## Regeneration Gates

The showcase regenerates in these contexts:

1. **Manual:** `agentgrit showcase` — always regenerates
2. **Daemon cycle:** After `runDaemonCycle()` completes — captures post-cycle state
3. **Graph build:** After `agentgrit graph build` — captures node/edge changes
4. **Flags:**
   - `--open` — regenerate and open in default browser
   - `--stdout` — print HTML to stdout (for piping)

Regeneration is idempotent and fast (reads JSON files, fills template). No side effects.

## Visual Standards

- **Layout:** Single-column, max-width 1200px, centered
- **Typography:** System font stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`)
- **Colors:**
  - Accent: `#2563eb` (deep blue) — loop arrows, active states
  - Success: `#16a34a` (green) — passing metrics, healthy indicators
  - Warning: `#d97706` (amber) — near-threshold metrics
  - Danger: `#dc2626` (red) — failing metrics, unhealthy indicators
  - Background: `#ffffff` (white)
  - Text: `#111827` (near-black)
  - Muted: `#6b7280` (gray)
  - Card background: `#f9fafb`
  - Card border: `#e5e7eb`
- **Metric cards:** Large numbers (48px+), label below (14px), subtle card with border
- **SVG:** Inline, circular loop with 6 labeled stages, 3 feedback arrows in accent blue
- **Print:** `@media print` rules — no page breaks mid-section, accent colors preserved, footer visible
- **Responsive:** Fluid grid, min 320px, max 1200px
