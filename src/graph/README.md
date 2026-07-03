# graph/

Knowledge graph and retrieval module. Stores rules as domain-tagged nodes connected by relationship edges. At session start, queries the graph to inject the most relevant rules based on the current task's domain.

## What the Knowledge Graph Represents

The graph is a JSON file (`knowledge-graph.json`) where:
- **Nodes** are rules (from memory files, CLAUDE.md entries, or promoted patterns)
- **Edges** connect rules that share domains, reinforce each other, or co-occurred in failures
- **Domains** are keyword-based classifications (13 categories) that describe what area a rule applies to

### Graph Schema

```typescript
interface Graph {
  version: string;                    // "1.0"
  builtAt: string;                    // ISO timestamp of last build
  nodeCount: number;
  edgeCount: number;
  nodes: Record<string, GraphNode>;   // Keyed by node ID
  edges: GraphEdge[];
}

interface GraphNode {
  id: string;
  name: string;
  domains: string[];       // e.g., ["verification", "delivery"]
  ruleText?: string;       // First 500 chars of the rule content
  hash?: string;           // MD5 of content for change detection
  stats: {
    injectionCount: number;
    avgRating: number;
    highRatingActivations: number;
    lowRatingActivations: number;
    sessionRatings: number[];
    lastSeen: string;
  };
}

interface GraphEdge {
  source: string;          // Node ID
  target: string;          // Node ID
  type: EdgeType;          // "same_domain", "reinforces", "sibling", etc.
  strength: number;        // 0-1
  edgeSource?: EdgeSource; // "inferred", "explicit", "embedding"
}
```

### Edge Types

| Type | Meaning |
|------|---------|
| `same_domain` | Both nodes share a primary domain |
| `reinforces` | One rule strengthens another |
| `sibling` | Rules that address the same concern differently |
| `caused_by_same_root` | Rules that emerged from the same root cause |
| `applies_when` | Conditional relationship |
| `conflicts_with` | Rules that contradict each other |
| `supersedes` | Newer rule replaces an older one |
| `co_occurred_in_failure` | Both rules were active when failures happened |
| `contradicts` | Rules with opposing guidance |
| `caused_by` | Causal relationship |

## How the Graph Is Built

`builder.ts` constructs the graph incrementally.

### Build Process

1. **Discover rule files** — scan the rules directory for `.md` files (excluding MEMORY.md and README.md)
2. **Parse frontmatter** — extract `name` and `description` from YAML frontmatter
3. **Classify domains** — assign each rule to 1+ of 13 domains using keyword regex patterns
4. **Check for changes** — compute MD5 hash of rule content. If the hash matches the cached version, reuse the cached domain classification (skip re-classification)
5. **Build nodes** — create a `GraphNode` for each rule, preserving stats from the existing graph
6. **Restore cached edges** — keep edges from the previous graph where both endpoints are unchanged
7. **Build same-domain edges** — connect rules that share a primary domain (max 4 edges per node, connecting to nearest neighbors in alphabetical order within each domain group)
8. **Write graph** — save to `knowledge-graph.json`

### Domain Taxonomy

13 domains, classified by keyword regex on `name + description + ruleText`:

| Domain | Keyword Patterns |
|--------|-----------------|
| `deployment` | makefile, make rebuild, docker, podman, deploy |
| `ui-testing` | quinn, playwright, visual test, screenshot |
| `browser` | iframe, page.fill, sso, login flow, scraper |
| `security` | security scan, vulnerability, destructive, force push |
| `delegation` | spawn agent, worktree, pre-brief, handoff |
| `escalation` | escalat, specialist, wrong approach, stuck |
| `algorithm` | prd, isc, algorithm phase, effort level |
| `memory` | feedback_.md, ratings.jsonl, learning capture |
| `scope` | minimal scope, only asked, unrequested |
| `delivery` | false complet, incomplete, not done, self audit |
| `communication` | response format, output format, terse response |
| `data` | actual data, live data, measure before |
| `verification` | read before, check before, verify before (fallback default) |

If no patterns match, the rule defaults to `["verification"]`.

### Incremental Updates

`updateGraph(graph, newRules)` adds rules to an existing graph without a full rebuild:
1. Classify domains for new rules
2. If a rule ID already exists, update domains/text/hash but keep stats
3. For new nodes, connect to up to 4 domain siblings via `same_domain` edges
4. Update counts

### Pruning

`pruneStaleNodes(graph, validIds)` removes nodes whose IDs are no longer in the valid set. Also removes any edges that reference pruned nodes.

## BM25 Full-Text Search

`bm25.ts` implements a standard BM25 index over rule files.

### Index Construction

`buildIndex(files)` or `buildIndexFromDir(dir)`:
1. Read each file, strip YAML frontmatter and markdown formatting
2. Tokenize: lowercase, keep alphanumeric + underscore + hyphen, filter tokens < 2 chars
3. Count term frequencies per document
4. Compute document frequency (DF) per term across all documents
5. Compute IDF using the smooth variant: `log((N - df + 0.5) / (df + 0.5) + 1)`

### Search

`searchIndex(index, query, limit)`:
1. Tokenize the query
2. For each document, compute BM25 score: `sum(IDF * (tf * (k1+1)) / (tf + k1 * (1 - b + b * docLen/avgDocLen)))`
   - k1 = 1.5, b = 0.75
3. Filter to documents with score > 0
4. Sort by score descending, return top `limit` (default: 15)

### BM25Index Schema

```typescript
interface BM25Index {
  builtAt: string;
  docCount: number;
  avgDocLen: number;
  vocabulary: Record<string, { idf: number; df: number }>;
  docs: Array<{ id: string; tokens: Record<string, number>; len: number }>;
}
```

## Hybrid Retrieval

`retrieval.ts` merges BM25 keyword results and graph domain results using Reciprocal Rank Fusion (RRF).

### How RRF Works

1. Get top 50 results from BM25 (keyword match)
2. Get top 50 results from graph query (domain traversal)
3. For each result in each list, compute its contribution: `1 / (k + rank)` where k=60 (standard RRF constant)
4. Results appearing in both lists get their contributions summed
5. Sort by combined RRF score descending
6. Return top `limit` (default: 15)

RRF is preferred over simple score normalization because it handles the scale mismatch between BM25 scores and graph scores gracefully.

### Output

```typescript
interface RetrievalResult {
  id: string;
  rrfScore: number;     // Combined RRF score
  bm25Rank?: number;    // Rank in BM25 list (if present)
  graphRank?: number;   // Rank in graph list (if present)
}
```

## Session-Start Context Injection

`context.ts` is the entry point for injecting relevant rules at session start.

### Domain Detection

`detectDomains(text)` scans the current task description for keyword patterns matching the 13 domains. Returns an array of matched domain strings.

### `getContextRules(graph, index, currentDomains, limit)`

1. Use `currentDomains` (or fall back to `["verification", "delivery", "deployment"]`)
2. Query the graph for domain-matched clusters
3. Query BM25 for keyword-matched results
4. Merge: graph results first, BM25 fills remaining slots (up to `limit`, default: 10)
5. Convert graph nodes to `Rule` objects with `tier: "graph"`

The result is an array of `Rule` objects ready for injection into the session context.

## Embeddings (Optional)

`embedder.ts` generates vector embeddings for semantic similarity search. Supports Voyage AI or compatible embedding APIs. Embedding edges (`edgeSource: "embedding"`) are used by the graph query for 1-hop expansion — finding semantically related rules that don't share keywords.

This module is optional. The system works without embeddings using keyword-based domain classification and BM25 full-text search.

## Data Flow

```
rules/*.md → graph/builder.ts → state/knowledge-graph.json
                                        │
rules/*.md → graph/bm25.ts → BM25Index  │
                                │        │
graph/context.ts ← ─────────────┘────────┘
     │
     └→ Rule[] (injected at session start)

graph/retrieval.ts ← BM25Index + Graph → RetrievalResult[] (hybrid search)
```
