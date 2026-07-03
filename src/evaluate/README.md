# evaluate/

Quality scoring module. Two independent channels assess output quality: human signals (automatic, zero cost) and LLM-as-judge (opt-in, rubric-driven). The judge supports Gemini, Claude, and OpenAI as scoring providers.

## Two Scoring Channels

**Channel 1: Human signals (always on)**
Ratings, corrections, and sentiment captured by `capture/` flow directly into `detect/` and `promote/`. No LLM calls, no API keys, no cost. Available in all adoption speeds.

**Channel 2: LLM judge (Standard and Full Auto)**
Reads a trace (input + output pair), scores it against each dimension in a rubric, and returns per-dimension scores (1-5) with reasoning. Requires one API key.

## How the LLM Judge Works

### Step by Step

1. **Build the prompt** — `buildPrompt()` constructs a structured evaluation prompt:
   - Truncates trace input to 2,000 characters and output to 4,000 characters
   - Lists each rubric dimension with its scoring criteria
   - Requests JSON output with per-dimension `score` (1-5) and `reasoning`

2. **Call the provider** — `callInference()` sends the prompt to the configured LLM:
   - **Gemini**: `generativelanguage.googleapis.com` with `responseMimeType: "application/json"`
   - **Claude**: `api.anthropic.com/v1/messages` with `anthropic-version: 2023-06-01`
   - **OpenAI**: `api.openai.com/v1/chat/completions` with `response_format: { type: "json_object" }`
   - Temperature defaults to 0.1 for consistency
   - Retries on 429 (rate limit) with exponential backoff: `min(30 * (attempt + 1), 120)` seconds
   - Max retries: 2 (configurable via `maxRetries`)

3. **Extract scores** — `extractScores()` parses the provider-specific response format:
   - Extracts the text content from the provider's response structure
   - Finds the JSON block via regex (`/\{[\s\S]*\}/`)
   - Validates each dimension: score must be 1-5, accepts both `{score, reasoning}` objects and bare numbers
   - Returns `null` on any parse failure (graceful degradation)

4. **Return Score array** — one `Score` object per rubric dimension that was successfully scored

### Score Schema

```typescript
interface Score {
  traceId: string;      // Links to the evaluated trace
  dimension: string;    // e.g., "task-completion"
  value: number;        // 1-5
  rubric: string;       // The scoring criteria text
  judgeModel: string;   // e.g., "gemini-2.5-flash"
  reasoning?: string;   // Judge's explanation
  timestamp: string;    // ISO 8601
  schemaVersion: number; // Currently 1
}
```

## Rubrics

### What a Rubric Is

A rubric is a JSON file defining weighted scoring dimensions. Each dimension has a name, description, weight, and scoring criteria text. The judge evaluates each dimension independently.

### Rubric Schema

```typescript
interface RubricConfig {
  version: string;        // e.g., "1.0"
  schemaVersion: number;  // Must be present (currently 1)
  dimensions: Dimension[];
  judgeModel: string;     // e.g., "gemini-2.5-flash"
}

interface Dimension {
  name: string;          // Unique identifier
  description: string;   // What this dimension measures
  weight: number;        // 0 < weight <= 1, all weights must sum to ~1.0
  rubric: string;        // Scoring criteria for the judge
}
```

### Validation Rules

`validateRubric()` enforces:
- `version` and `judgeModel` must be non-empty strings
- `schemaVersion` must be a number
- `dimensions` must be a non-empty array
- Each dimension needs a `name` (string), `weight` (0 < w <= 1), and `rubric` (string)
- Dimension names must be unique
- Weights must sum to 1.0 (tolerance: 0.01)

### Loading and Composing Rubrics

```typescript
import { loadRubric, composeRubrics } from "./rubric";

// Load a single rubric (throws on validation failure)
const rubric = loadRubric("/path/to/rubric.json");

// Compose multiple rubrics (later overrides earlier for same dimension name)
const combined = composeRubrics(starter, custom);
// Weights are renormalized to sum to 1.0
// judgeModel comes from the last rubric
```

### Full Custom Rubric Example

```json
{
  "version": "1.0",
  "schemaVersion": 1,
  "dimensions": [
    {
      "name": "intent-match",
      "description": "Does the response address the actual user intent, not just the literal words?",
      "weight": 0.35,
      "rubric": "Score 1-5. 1=completely misread the intent. 3=addressed part of it. 5=nailed the underlying need."
    },
    {
      "name": "evidence-based",
      "description": "Are claims backed by tool use, code reads, or verifiable data?",
      "weight": 0.35,
      "rubric": "Score 1-5. 1=pure assertion with no evidence. 3=some evidence but gaps. 5=every claim verified."
    },
    {
      "name": "minimal-disruption",
      "description": "Does it avoid unnecessary changes beyond what was asked?",
      "weight": 0.30,
      "rubric": "Score 1-5. 1=rewrote everything. 3=some extra changes. 5=surgical, only what was needed."
    }
  ],
  "judgeModel": "gemini-2.5-flash"
}
```

## Session Quality Scoring

`session.ts` aggregates all signals from a session into a composite quality score. It combines explicit ratings, correction count, sentiment balance, and skill recall accuracy into a single number.

## Recall Evaluation

`recall.ts` answers: "Did the right rules surface for this domain? Did the right skills fire?" It logs hits and misses as feedback signals, which feed back into the graph's activation statistics and the skill tuner.

## Score Aggregation

`analysis.ts` aggregates scores across traces and produces trend reports. Used by the daemon's weekly review cycle and the `agentgrit status` command.

## Data Flow

```
capture/ signals → evaluate/judge.ts → scores.jsonl → daemon/daemon.ts
                                                     → optimize/prompt-tuner.ts
                                                     → bin/commands/status.ts

rubrics/*.json → evaluate/rubric.ts → evaluate/judge.ts
                                    → optimize/prompt-tuner.ts
```
