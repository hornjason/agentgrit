/**
 * The daemon's score step (#323): grade recent rated replies with the
 * configured judge and append the scores to quality-scores.jsonl, once per trace.
 * The judge sees what the human asked and what the assistant replied, both read
 * from the session transcript (#324) — rating rows carry neither.
 */
import { appendFileSync, existsSync, readFileSync } from "fs";
import { isAbsolute, join } from "path";
import type { AgentGritConfig, RubricConfig, Score } from "../adapters/types";
import { readSignals } from "../adapters/jsonl";
import { expandPath, getBaseDir, hostDir, resolveSignalFile } from "../adapters/paths";
import { judgeTrace, judgeUsable, scoresToJsonl, type JudgeConfig, type Trace } from "../evaluate/judge";
import { findTranscript, ratedExchange } from "../evaluate/rated-exchange";
import { loadRubric } from "../evaluate/rubric";

/** Ratings considered per nightly run, newest first by file order. */
const RATINGS_PER_RUN = 50;

export interface ScoreStepDeps {
  judge?: typeof judgeTrace;
}

/** The judge settings handed to judgeTrace, or undefined when no judge can run. */
export function judgeConfigFrom(config: AgentGritConfig): JudgeConfig | undefined {
  const j = config.judge;
  if (!j || !judgeUsable(j)) return undefined;
  return { provider: j.provider, model: j.model, apiKey: j.apiKey, project: j.project, location: j.location };
}

/**
 * A rubric reference from config is either a path or a name under <base>/rubrics,
 * the same lookup `agentgrit eval` uses. A bare name must not resolve against the
 * process cwd: under launchd that is `/`, and the rubric silently never loaded.
 */
function loadConfiguredRubric(ref: string): { rubric: RubricConfig } | { error: string } {
  const file = ref.endsWith(".json") ? ref : `${ref}.json`;
  const path = isAbsolute(file) ? file : join(getBaseDir(), "rubrics", file);
  try { return { rubric: loadRubric(path) }; } catch (err) { return { error: `rubric ${ref} not loaded: ${err instanceof Error ? err.message : String(err)}` }; }
}

function transcriptRoots(config: AgentGritConfig): string[] {
  const roots = [join(hostDir(), "projects")];
  if (config.transcriptDir) roots.unshift(expandPath(config.transcriptDir));
  return roots;
}

function scoredTraceIds(file: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(file)) return ids;
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { const row = JSON.parse(line) as { traceId?: unknown }; if (typeof row.traceId === "string") ids.add(row.traceId); } catch {}
  }
  return ids;
}

export interface ScoreStepResult {
  scores: Score[];
  /** Failures that would otherwise read as "nothing to grade": a rubric that did not load, a judge that graded none of its traces. */
  warnings: string[];
}

export async function runScoreStep(config: AgentGritConfig, deps: ScoreStepDeps = {}): Promise<ScoreStepResult> {
  const judgeConfig = judgeConfigFrom(config);
  if (!judgeConfig) return { scores: [], warnings: [] };
  const judge = deps.judge ?? judgeTrace;

  const scoresFile = resolveSignalFile(config.signalDir, "quality-scores.jsonl");
  const already = scoredTraceIds(scoresFile);
  // The newest ratings, not readSignals' { limit } — that is the FIRST lines of the file, the oldest (#328).
  const signals = (await readSignals(join(config.signalDir, "ratings.jsonl"))).slice(-RATINGS_PER_RUN);

  const warnings: string[] = [];
  const roots = transcriptRoots(config);
  const traces: Trace[] = [];
  let considered = 0;
  for (const signal of signals) {
    const row = signal as { id?: string; session_id?: string; timestamp?: string };
    if (!row.session_id || !row.timestamp) continue;
    const id = row.id ?? `${row.session_id}@${row.timestamp}`;
    if (already.has(id)) continue;
    considered++;
    try {
      const path = findTranscript(row.session_id, roots);
      const exchange = path ? await ratedExchange(path, row.timestamp) : null;
      if (exchange) traces.push({ id, input: exchange.input, output: exchange.output });
    } catch (err) {
      // One unreadable transcript (a directory, no permission) must not stop the rest being graded.
      warnings.push(`rating ${id}: transcript unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (considered > 0 && traces.length === 0) {
    warnings.push(`no transcript exchange found for any of ${considered} ratings (looked under ${roots.join(", ")})`);
  }

  const graded: Score[] = [];
  let attempted = 0;
  let succeeded = 0;
  for (const ref of config.rubrics) {
    if (traces.length === 0) break;
    const loaded = loadConfiguredRubric(ref);
    if ("error" in loaded) { warnings.push(loaded.error); continue; }
    const { rubric } = loaded;
    for (const trace of traces) {
      attempted++;
      const scores = await judge(trace, rubric, judgeConfig);
      if (scores.length > 0) succeeded++;
      graded.push(...scores);
    }
  }

  if (attempted > 0 && succeeded === 0) {
    warnings.push(`judge ${judgeConfig.provider}/${judgeConfig.model} graded 0 of ${attempted} traces (no credential, HTTP error, or unparseable reply)`);
  }
  if (graded.length > 0) appendFileSync(scoresFile, scoresToJsonl(graded));
  return { scores: graded, warnings };
}
