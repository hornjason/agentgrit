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
function loadConfiguredRubric(ref: string): RubricConfig | null {
  const file = ref.endsWith(".json") ? ref : `${ref}.json`;
  const path = isAbsolute(file) ? file : join(getBaseDir(), "rubrics", file);
  try { return loadRubric(path); } catch { return null; }
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

export async function runScoreStep(config: AgentGritConfig, deps: ScoreStepDeps = {}): Promise<Score[]> {
  const judgeConfig = judgeConfigFrom(config);
  if (!judgeConfig) return [];
  const judge = deps.judge ?? judgeTrace;

  const scoresFile = resolveSignalFile(config.signalDir, "quality-scores.jsonl");
  const already = scoredTraceIds(scoresFile);
  const signals = await readSignals(join(config.signalDir, "ratings.jsonl"), { limit: 50 });

  const graded: Score[] = [];
  for (const ref of config.rubrics) {
    const rubric = loadConfiguredRubric(ref);
    if (!rubric) continue;
    for (const signal of signals) {
      if (!("response_preview" in signal) || !signal.response_preview) continue;
      const row = signal as { id?: string; session_id: string; timestamp: string; response_preview: string };
      const id = row.id ?? `${row.session_id}@${row.timestamp}`;
      if (already.has(id)) continue;
      const scores = await judge({ id, input: row.session_id, output: row.response_preview }, rubric, judgeConfig);
      if (scores.length > 0) already.add(id);
      graded.push(...scores);
    }
  }

  if (graded.length > 0) appendFileSync(scoresFile, scoresToJsonl(graded));
  return graded;
}
