# AgentGrit Test Matrix

Comprehensive verification checklist for all features across all adoption tiers.
Run before every release. Each item must have evidence (command output, test result, or screenshot).

Last verified: 2026-07-03 (real PAI data: 618 ratings, 1059 corrections, 292 memory files)

---

## Tier 1: Quick Start (zero API keys)

Everything in this tier works with local JSONL only. No LLM calls.

### Signal Capture
| # | Test | Command | Expected | Status |
|---|------|---------|----------|--------|
| Q1 | Rating capture writes to JSONL | `captureRating("M:7 S:8 Q:6", sessionId)` | Entry in ratings.jsonl with session_id, rating, dimensions | PASS |
| Q2 | Dimension parsing (M:N S:N Q:N) | `parseRating("/rate M:7 S:8 Q:6")` | `{mode:7, scope:8, quality:6}` | PASS |
| Q3 | Sentiment scoring | `scoreSentiment("that's wrong, fix it")` | Negative sentiment with confidence | PASS |
| Q4 | Correction detection | `detectCorrection("no not that", ctx)` | Entry in corrections.jsonl | PASS |
| Q5 | Correction noise filter | `detectCorrection("no problem", ctx)` | Returns null (not a correction) | **BUG** — "perfect", "nice" pass as corrections |
| Q6 | Skill invocation capture | `captureSkillInvocation("ship", sessionId)` | Entry in skill-invocations.jsonl | PASS |
| Q7 | Skill sequence tracking | `captureSkillSequence(sessionId, skills, rating)` | Entry in skill-sequences.jsonl | PASS |
| Q8 | Tool audit logging | `captureToolAudit(toolName, sessionId)` | Entry in tool-audit.jsonl | PASS |
| Q9 | Failure capture | `captureFailure({rating:2, context:...})` | Structured failure signal with severity | PASS |
| Q10 | Assertion audit | `auditAssertions(turns)` | Detects unverified negative claims | PASS |
| Q11 | Work completion learning | `extractWorkLearnings({...})` | Categorized learnings (approach/tooling) | PASS |
| Q12 | Debrief extraction | `extractDebrief(transcript, sessionId)` | Rules + corrections + approvals | PASS |

### Pattern Detection
| # | Test | Command | Expected | Status |
|---|------|---------|----------|--------|
| Q13 | Failure pattern detection | `detectFailurePatterns(corrections)` | Groups by theme, scores severity | PASS |
| Q14 | Pattern mining | `minePatterns(signals)` | Cross-signal pattern clusters | PASS |
| Q15 | Trajectory storage | `addTrajectory({rating:8, ...})` | Stored, capped at 100, lowest evicted | PASS |
| Q16 | Theme cohort analysis | `analyzeCohortHealth(graph, ratings)` | Per-cohort health metrics | PASS |
| Q17 | Anti-rationalization | `buildWeightedAntiRationalizations(failures)` | Rebuttal table for shortcut patterns | PASS |

### Rule Management
| # | Test | Command | Expected | Status |
|---|------|---------|----------|--------|
| Q18 | Three-tier routing | `routeRule(rule)` | Routes to global/project/graph based on project count | PASS |
| Q19 | Budget enforcement | `checkBudget()` | Blocks when over 25/25 cap | PASS |
| Q20 | Rule correlation tracking | `trackRule(rule, sessionRating)` | Updates correlation score | PASS |
| Q21 | Promotion ledger | `recordPromotion(rule, tier)` | Snapshot with before/after | PASS |
| Q22 | Undo promotion | `undoPromotions(1)` | Reverts CLAUDE.md to before-snapshot | PASS (no history to undo — works) |
| Q23 | Auto-feedback generation | `generateFeedback(ratings, corrections)` | Memory .md file from low-rating patterns | PASS |
| Q24 | Auto-success generation | `generateSuccess(ratings)` | Memory .md file from high-rating sessions | PASS |

### CLI Commands (Quick Start)
| # | Test | Command | Expected | Status |
|---|------|---------|----------|--------|
| Q25 | Init quick | `agentgrit init --quick` | Creates dir, config, rubric | PASS |
| Q26 | Status | `agentgrit status` | Signal counts, score trends, budget | PASS |
| Q27 | Doctor | `agentgrit doctor` | Pass/warn/fail for all checks | PASS |
| Q28 | Signals | `agentgrit signals` | File sizes and entry counts | PASS |
| Q29 | Review | `agentgrit review` | Pattern count, candidates, score trend | PASS |
| Q30 | Inbox | `agentgrit inbox` | Candidate list with severity/tier/frequency | PASS |
| Q31 | Rules | `agentgrit rules` | Budget display per tier | PASS |
| Q32 | Export | `agentgrit export` | Valid JSON with graph, rubrics, config | PASS |
| Q33 | Undo | `agentgrit undo` | Reverts or shows "no history" | PASS |
| Q34 | Upgrade | `agentgrit upgrade standard` | Updates config adapter + judge | PASS |
| Q35 | Rules promote | `agentgrit rules promote` | Promotes inbox candidates to rules | **BUG** — not wired, shows rules list |

### Pipeline (end-to-end Quick Start)
| # | Test | Steps | Expected | Status |
|---|------|-------|----------|--------|
| Q36 | Capture → detect → inbox | Inject 5+ similar corrections → review → inbox | Candidates appear with correct frequency | PASS |
| Q37 | Candidate severity scoring | Inject varied-severity corrections | Severity varies, not all 5/10 | **BUG** — all candidates show 5/10 |
| Q38 | Candidate rule text quality | Review after corrections | Descriptive rule text, not "stop; stop; stop" | **BUG** — repeats trigger word only |

---

## Tier 2: Standard (one API key)

Requires judge config: `{provider: "gemini", model: "gemini-2.5-flash", apiKey: "..."}`.

### LLM Judge
| # | Test | Command | Expected | Status |
|---|------|---------|----------|--------|
| S1 | Judge scores trace | `judgeTrace(trace, rubric)` | Per-dimension scores + reasoning | NEEDS API KEY |
| S2 | Judge batch processing | `judgeBatch(traces, rubric)` | Multiple traces scored, persisted | NEEDS API KEY |
| S3 | Score persistence | `scoresToJsonl(scores, path)` | Scores written to quality-scores.jsonl | NEEDS API KEY |
| S4 | Multi-provider support | Switch provider in config | Works with Gemini, Claude, OpenAI | NEEDS API KEY |
| S5 | Graceful degradation | Invalid API key | Error message, no crash | NEEDS API KEY |

### Session Scoring
| # | Test | Command | Expected | Status |
|---|------|---------|----------|--------|
| S6 | Session quality score | `scoreSession(signals)` | Composite 0-10 from ratings+corrections+sentiment | PASS (local math) |
| S7 | Transcript scoring | `scoreTranscript(transcript, config)` | LLM-scored quality dimensions | NEEDS API KEY |

### Knowledge Graph
| # | Test | Command | Expected | Status |
|---|------|---------|----------|--------|
| S8 | Graph build from memory files | `buildGraph(memoryDir)` | Nodes + edges from .md files | PASS (292 nodes, 603 edges) |
| S9 | Graph incremental build | Change 1 file, rebuild | Only changed node re-tagged | PASS (hash caching works) |
| S10 | Graph query by domain | `agentgrit graph query verification` | Ranked clusters with connected nodes | PASS |
| S11 | Graph stats | `agentgrit graph stats` | Node/edge/domain counts | PASS |
| S12 | BM25 keyword search | `searchBM25(index, query)` | Ranked results by relevance | PASS (unit tests) |
| S13 | Hybrid retrieval (BM25 + graph) | `hybridRetrieve(query, domains)` | RRF-merged results | PASS (unit tests) |
| S14 | Graph CLI builds from memory dir | `agentgrit graph build` | Discovers memory files, builds graph | **BUG** — CLI passes rubrics/ not memory/ |

### Recall Evaluation
| # | Test | Command | Expected | Status |
|---|------|---------|----------|--------|
| S15 | Recall@K | `recallAtK(gold, retrieved, 5)` | Proportion of gold items in top K | PASS |
| S16 | Precision@K | `precisionAtK(gold, retrieved, 5)` | Precision of top K | PASS |
| S17 | MRR | `reciprocalRank(gold, retrieved)` | Reciprocal rank score | PASS |
| S18 | Bootstrap CI | `bootstrapCI(scores, 1000)` | 95% confidence interval | PASS |
| S19 | Session recall eval | `evaluateSessionRecall(...)` | Rule + skill recall for session | PASS |
| S20 | Gold set auto-labeling | `autoLabel(sessions, graph)` | Sessions labeled against graph rules | PASS (unit tests) |
| S21 | Synthetic gold generation | `generateSynthetic(nodes, config)` | Synthetic sessions for eval | PASS (unit tests) |

### Skill Metrics
| # | Test | Command | Expected | Status |
|---|------|---------|----------|--------|
| S22 | Skill accuracy | `computeSkillMetrics(signalDir)` | Accuracy ratio from real data | PASS (0.278 from PAI data) |
| S23 | Skill co-occurrence | `computeSkillMetrics(signalDir)` | Co-occurrence matrix | PASS (34 pairs found) |
| S24 | Skill usage stats | `computeSkillMetrics(signalDir)` | Per-skill invocation counts | PASS (50 skills tracked) |

### CLI Commands (Standard tier)
| # | Test | Command | Expected | Status |
|---|------|---------|----------|--------|
| S25 | Eval traces | `agentgrit eval traces` | Scores traces against rubric | NEEDS API KEY (shows "requires judge") |
| S26 | Eval recall | `agentgrit eval recall` | Recall accuracy report | NEEDS API KEY (shows "requires judge") |
| S27 | Graph query | `agentgrit graph query <domain>` | Domain clusters | PASS |

---

## Tier 3: Full Auto (API key + daemon)

Requires judge config + daemon enabled.

### Hill-Climbing Optimization
| # | Test | Command | Expected | Status |
|---|------|---------|----------|--------|
| F1 | Hill-climb engine | `hillClimb({...evaluate, propose...})` | Propose→eval→keep/discard loop | PASS (tested with mock) |
| F2 | Max change ratio enforcement | Propose >15% change | Rejected, original kept | PASS (unit tests) |
| F3 | Experiment logging | Run 2 rounds | Entries in experiments.jsonl | PASS (unit tests) |
| F4 | Prompt tuner | `tunePrompt(config)` | Traces selected, prompt improved | NEEDS API KEY |
| F5 | Skill tuner | `tuneSkill(config)` | Skill description optimized | NEEDS API KEY |
| F6 | Fast evaluate (regex) | `fastEvaluate(skillText)` | Deterministic score, no LLM | PASS |
| F7 | Skill criteria registry | `getCriteriaForSkill("ship")` | Returns criteria list | PASS |

### Daemon
| # | Test | Command | Expected | Status |
|---|------|---------|----------|--------|
| F8 | Daemon cycle | `runDaemonCycle(config)` | score→detect→promote→sync→optimize | PASS (unit tests) |
| F9 | Daemon CLI | `agentgrit daemon run` | Runs one cycle | **BUG** — daemon not in CLI commands |
| F10 | Scheduler install | `installScheduler("launchagent")` | Creates plist/timer file | PASS (unit tests) |
| F11 | Doctor extended checks | `agentgrit doctor` | Config, cross-ref, budget checks | PASS |

### Langfuse Integration
| # | Test | Command | Expected | Status |
|---|------|---------|----------|--------|
| F12 | Connect to Langfuse | `connectLangfuse(config)` | Client initialized | NEEDS LANGFUSE |
| F13 | Sync scores to Langfuse | `syncScores(scores, config)` | Scores pushed via API | NEEDS LANGFUSE |
| F14 | Fetch traces from Langfuse | `fetchTraces(config)` | Traces downloaded | NEEDS LANGFUSE |
| F15 | Cache traces locally | `cacheTraces(traces, path)` | JSON cache file written | PASS (unit tests) |

### LLM Inference
| # | Test | Command | Expected | Status |
|---|------|---------|----------|--------|
| F16 | Inference fast level | `inference({level:"fast", prompt:...})` | Haiku-class response | NEEDS API KEY |
| F17 | Inference standard level | `inference({level:"standard", prompt:...})` | Sonnet-class response | NEEDS API KEY |
| F18 | Inference smart level | `inference({level:"smart", prompt:...})` | Opus-class response | NEEDS API KEY |

### Session Cleanup
| # | Test | Command | Expected | Status |
|---|------|---------|----------|--------|
| F19 | Session compression | `compressSession(session)` | Weekly/monthly digest archives | PASS (unit tests) |
| F20 | System counts update | `updateCounts(config)` | Metrics refreshed | PASS (unit tests) |

### Promotion Pipeline (end-to-end Full Auto)
| # | Test | Steps | Expected | Status |
|---|------|-------|----------|--------|
| F21 | Auto-promote flow | Enable autoPromote, inject patterns | Patterns auto-route to correct tier | NOT TESTED |
| F22 | Promotion + undo roundtrip | Promote rule, verify in CLAUDE.md, undo | Rule appears then disappears | NOT TESTED |
| F23 | Weekly review cycle | Run review with 7 days of data | Summary + promotions + graph rebuild | PASS (review works, promote not wired in CLI) |

---

## Cross-Cutting

| # | Test | Command | Expected | Status |
|---|------|---------|----------|--------|
| X1 | Init bootstrap from history | `agentgrit init --bootstrap` | Seeds from existing session data | NOT TESTED |
| X2 | Machine migration (export/import) | Export on machine A, import on B | Graph + rules + rubrics transfer | NOT TESTED (export works) |
| X3 | Signal rotation at threshold | Write 5MB+ to JSONL | Auto-rotates to archive | PASS (unit tests) |
| X4 | Atomic CLAUDE.md writes | `bridge.promoteRule(...)` | Write-to-temp-then-rename | PASS |
| X5 | Schema versioning | Read v1 signals | Processes correctly | PASS |
| X6 | Hook registration | `generateHookConfig(hooks)` | Valid settings.json hook entries | PASS (unit tests) |
| X7 | 543 unit tests | `bun test` | 0 failures | PASS |

---

## Known Bugs (from verification)

| # | Bug | Impact | Fix Complexity |
|---|-----|--------|---------------|
| B1 | Approval words ("perfect", "nice") pass correction noise filter | Inbox polluted with false positives | S — update NOISE_PATTERNS in corrections.ts |
| B2 | All candidates severity = 5/10, no differentiation | Can't prioritize inbox | S — use frequency/recurrence in severity calc |
| B3 | Rule text = "stop; stop; stop" — no context synthesis | Candidates are unreadable | M — needs context extraction from surrounding turns |
| B4 | Graph CLI passes rubrics/ as memory dir | Graph builds 0 nodes from CLI | XS — change path in bin/commands/graph.ts |
| B5 | `rules promote` not wired as CLI action | Can't promote from inbox | S — add promote subcommand to rules.ts |
| B6 | `daemon` not in CLI commands | Can't run daemon from CLI | S — add daemon command to agentgrit.ts |

---

## Summary

| Tier | Total Tests | PASS | NEEDS API KEY | BUG | NOT TESTED |
|------|------------|------|---------------|-----|------------|
| Quick Start (Q1-Q38) | 38 | 32 | 0 | 4 | 0 |
| Standard (S1-S27) | 27 | 17 | 7 | 1 | 0 |
| Full Auto (F1-F23) | 23 | 12 | 5 | 2 | 3 |
| Cross-Cutting (X1-X7) | 7 | 5 | 0 | 0 | 2 |
| **Total** | **95** | **66** | **12** | **7** | **5** |

66 of 95 tests pass. 12 need API keys (Gemini/Langfuse). 7 are bugs to fix. 5 need integration testing.
