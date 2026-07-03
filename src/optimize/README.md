# optimize/

Hill-climbing optimization module. A generic propose-evaluate-keep/discard engine that incrementally improves prompts and skill descriptions based on rubric scores. Every experiment round is logged for reproducibility.

## Hill-Climbing Explained

Hill-climbing is a simple optimization strategy: start with what you have, make a small change, evaluate it, keep the change if it's better, discard it if it's not. Repeat.

It does not explore the full space of possibilities (that would require exponentially more LLM calls). Instead, it makes incremental progress — each round improves the current best by a small amount. Over multiple rounds, the cumulative improvement can be significant.

The "hill" is the score. "Climbing" means always moving upward (keeping improvements, discarding regressions).

## How the Engine Works

`hill-climb.ts` implements the generic loop.

### Configuration

```typescript
interface HillClimbConfig {
  current: string;                              // Starting text to optimize
  evaluate: (text: string) => Promise<number>;  // Scoring function
  propose: (text: string, weakDimension: string) => Promise<string>; // Variation generator
  rounds: number;                               // How many rounds to run
  maxChangeRatio?: number;                      // Max size change per round (default: 0.15)
  stateDir: string;                             // Where to log experiments
  weakDimension?: string;                       // Target dimension name
}
```

### Round-by-Round

For each round (1 to `rounds`):

1. **Propose** — call `config.propose(currentText, weakDimension)` to get a variation
   - If the proposal throws or returns empty/identical text: log as `proposal_failed`, continue
2. **Size check** — compute `|proposed.length - current.length| / current.length`
   - If ratio exceeds `maxChangeRatio` (default 15%): log as `rejected_size`, continue
3. **Evaluate** — call `config.evaluate(proposed)` to score the variation
4. **Compare** — if `proposedScore > currentScore`: keep the change, update current text and score
   - If not: discard the change
5. **Log** — append the round result to `experiments.jsonl`
6. **Flag** — if the delta exceeds 15%, flag the round for human review

### Output

```typescript
interface HillClimbResult {
  initialScore: number;     // Score before optimization
  finalScore: number;       // Score after all rounds
  totalDelta: number;       // finalScore - initialScore
  rounds: RoundResult[];    // Per-round details
  kept: number;             // Rounds where the change improved the score
  discarded: number;        // Rounds where the change was worse
  rejected: number;         // Rounds where the change was too large
  finalText: string;        // The optimized text
  reviewFlagged: RoundResult[]; // Rounds with unusually large improvements
}
```

### Experiment Log

Every round is appended to `{stateDir}/experiments.jsonl`:

```jsonl
{"round":1,"score":3.8,"delta":0.2,"outcome":"kept","summary":"Improved from 3.60 to 3.80","latencyMs":4521,"timestamp":"2026-07-03T10:15:00Z"}
{"round":2,"score":3.8,"delta":-0.1,"outcome":"discarded","summary":"Score 3.70 did not exceed 3.80","latencyMs":3892,"timestamp":"2026-07-03T10:15:10Z"}
{"round":3,"score":3.8,"delta":0,"outcome":"rejected_size","summary":"Change ratio 22.3% exceeds limit 15%","latencyMs":1205,"timestamp":"2026-07-03T10:15:12Z"}
```

## The 15% Change Limit

The `maxChangeRatio` (default: 0.15) prevents the optimizer from making drastic rewrites in a single round. It measures the absolute difference in character count relative to the current text length.

Without this limit, the LLM proposer might rewrite the entire prompt in one shot, which:
- Makes it hard to attribute improvements to specific changes
- Risks introducing regressions that are masked by the aggregate score
- Makes the experiment log less useful for understanding what worked

If a proposal exceeds the limit, it's logged as `rejected_size` and the round continues with the previous text. The proposer gets another chance next round.

## Prompt Tuning

`prompt-tuner.ts` applies hill-climbing to system prompts.

### How It Works Step by Step

1. **Fetch test cases** — use the `TraceFetcher` to get the N lowest-scoring traces for the target dimension
2. **Identify the common system prompt** — find the most frequently used system prompt among the test cases
3. **Baseline** — score the original prompt against all test cases using the rubric judge
4. **Hill-climb** — for each round:
   a. Generate outputs from the worst 3 test cases using the current prompt
   b. Ask the `PromptProposer` to improve the prompt based on these bad outputs
   c. Evaluate the proposed prompt against ALL test cases (weighted average across all rubric dimensions)
   d. Keep only if the weighted average improves
5. **Final evaluation** — score the best prompt against all test cases for the final report

### Interfaces the Caller Provides

```typescript
interface TraceFetcher {
  fetchLowestScoring(dimension: string, count: number): Promise<TraceWithScore[]>;
}

interface PromptProposer {
  propose(currentPrompt: string, targetDimension: Dimension, badOutputs: string[]): Promise<string>;
}

interface ContentGenerator {
  generate(systemPrompt: string, userPrompt: string): Promise<string | null>;
}
```

The engine is agnostic about where traces come from (Langfuse, local JSONL) and how proposals are generated (LLM call, template, manual). The caller wires in the implementations.

### Output

```typescript
interface PromptTuneResult {
  originalPrompt: string;
  bestPrompt: string;
  baselineScores: Record<string, number>;  // Per-dimension averages before
  finalScores: Record<string, number>;     // Per-dimension averages after
  baselineWeighted: number;                // Weighted average before
  finalWeighted: number;                   // Weighted average after
  totalDelta: number;                      // Improvement
  roundsKept: number;                      // How many rounds produced improvements
  hillClimbResult: HillClimbResult;        // Full round-by-round details
}
```

## Skill Tuning

`skill-tuner.ts` applies the same hill-climbing engine to skill description files (SKILL.md trigger descriptions). Evaluated behaviorally — did the skill fire when it should have? — using skill invocation signals rather than rubric dimensions.

## Skill Metrics

`skill-metrics.ts` measures skill effectiveness: accuracy, conversion rates, co-occurrence patterns, and usage trends. Used by the skill tuner to identify which skills need optimization.

## Benchmarks

`benchmark.ts` builds frozen benchmark corpora — fixed sets of test cases that don't change between optimization runs. This ensures improvements are real, not caused by different test data.

## Data Flow

```
evaluate/judge.ts → scores → optimize/prompt-tuner.ts → improved prompts
                             optimize/skill-tuner.ts  → improved skill descriptions
                             optimize/hill-climb.ts   → experiments.jsonl
```
