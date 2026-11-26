/**
 * The daemon's score step (#323): grade recent rated replies with the
 * configured judge and append the scores to quality-scores.jsonl, once per trace.
 */
import { appendFileSync, existsSync, readFileSync } from "fs";
import { isAbsolute, join } from "path";
import type { AgentGritConfig, RubricConfig, Score } from "../adapters/types";
import { readSignals } from "../adapters/jsonl";
import { getBaseDir, resolveSignalFile } from "../adapters/paths";
import { judgeTrace, judgeUsable, scoresToJsonl, type JudgeConfig } from "../evaluate/judge";
import { loadRubric } from "../evaluate/rubric";

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
  const signals = await readSignals(join(config.signalDir, "ratings.jsonl"), { limit: 50 });

  const graded: Score[] = [];
  const warnings: string[] = [];
  let attempted = 0;
  let succeeded = 0;
  for (const ref of config.rubrics) {
    const loaded = loadConfiguredRubric(ref);
    if ("error" in loaded) { warnings.push(loaded.error); continue; }
    const { rubric } = loaded;
    for (const signal of signals) {
      if (!("response_preview" in signal) || !signal.response_preview) continue;
      const row = signal as { id?: string; session_id: string; timestamp: string; response_preview: string };
      const id = row.id ?? `${row.session_id}@${row.timestamp}`;
      if (already.has(id)) continue;
      attempted++;
      const scores = await judge({ id, input: row.session_id, output: row.response_preview }, rubric, judgeConfig);
      if (scores.length > 0) { already.add(id); succeeded++; }
      graded.push(...scores);
    }
  }

  if (attempted > 0 && succeeded === 0) {
    warnings.push(`judge ${judgeConfig.provider}/${judgeConfig.model} graded 0 of ${attempted} traces (no credential, HTTP error, or unparseable reply)`);
  }
  if (graded.length > 0) appendFileSync(scoresFile, scoresToJsonl(graded));
  return { scores: graded, warnings };
}
