import type { CorrectionSignal, RatingSignal, SentimentSignal } from "../adapters/types";

export interface SessionSignals { ratings: RatingSignal[]; corrections: CorrectionSignal[]; sentiment: SentimentSignal[]; }

const W_R = 0.4, W_C = 0.3, W_S = 0.3;
function normRating(ratings: RatingSignal[]): number { return ratings.length === 0 ? 0.5 : Math.max(0, Math.min(1, ratings.reduce((s, r) => s + r.rating, 0) / ratings.length / 10)); }
function corrPenalty(corrections: CorrectionSignal[]): number { return corrections.length === 0 ? 1.0 : Math.max(0, 1.0 - corrections.length * 5 * 0.1); }
function normSentiment(sentiment: SentimentSignal[]): number { return sentiment.length === 0 ? 0.5 : Math.max(0, Math.min(1, sentiment.reduce((s, sig) => s + sig.rating, 0) / sentiment.length / 10)); }

export function scoreSession(signals: SessionSignals): number {
  return Math.round((W_R * normRating(signals.ratings) + W_C * corrPenalty(signals.corrections) + W_S * normSentiment(signals.sentiment)) * 1000) / 1000;
}

// ── Transcript-Based Quality Scoring ──
export interface QualityDimension { name: string; score: number; }
export interface TranscriptQualityResult { sessionId: string; sessionLengthChars: number; dimensions: QualityDimension[]; overall: number; notes?: string; scoredAt: string; error?: string; }

export const DEFAULT_QUALITY_DIMENSIONS = ["task_completion", "tool_correctness", "rule_adherence", "coherence", "conciseness"] as const;
export type DefaultQualityDimension = typeof DEFAULT_QUALITY_DIMENSIONS[number];

export function buildQualityJudgePrompt(dimensionNames: readonly string[] = DEFAULT_QUALITY_DIMENSIONS): string {
  const fields = dimensionNames.map((d) => `"${d}": <1-5>`).join(",\n  ");
  return `You are a quality evaluator for an AI assistant session. Rate the assistant's performance on ${dimensionNames.length} dimensions (1-5). Return ONLY valid JSON with this exact structure:\n{\n  ${fields},\n  "overall": <mean of above, rounded to 1 decimal>,\n  "notes": "<one sentence on the most notable quality issue>"\n}\n\nScoring guide:\n5 = excellent, 4 = good with minor issues, 3 = acceptable but problems, 2 = significant issues, 1 = failure`;
}

export interface TranscriptScoreConfig { judge: (systemPrompt: string, userPrompt: string) => Promise<Record<string, unknown> | null>; dimensions?: readonly string[]; tailChars?: number; }

export async function scoreTranscript(sessionId: string, transcript: string, config: TranscriptScoreConfig): Promise<TranscriptQualityResult> {
  const dims = config.dimensions ?? DEFAULT_QUALITY_DIMENSIONS;
  const tailChars = config.tailChars ?? 4000;
  const tail = transcript.length > tailChars ? transcript.slice(-tailChars) : transcript;
  const scoredAt = new Date().toISOString();
  try {
    const parsed = await config.judge(buildQualityJudgePrompt(dims), `Session transcript (last ${tailChars} chars):\n${tail}`);
    if (!parsed) return { sessionId, sessionLengthChars: transcript.length, dimensions: [], overall: 0, scoredAt, error: "judge returned null" };
    const scoredDims: QualityDimension[] = [];
    for (const name of dims) { const v = parsed[name]; if (typeof v === "number" && v >= 1 && v <= 5) scoredDims.push({ name, score: v }); }
    const overall = typeof parsed.overall === "number" ? Math.round(parsed.overall * 10) / 10 : scoredDims.length > 0 ? Math.round(scoredDims.reduce((s, d) => s + d.score, 0) / scoredDims.length * 10) / 10 : 0;
    return { sessionId, sessionLengthChars: transcript.length, dimensions: scoredDims, overall, notes: typeof parsed.notes === "string" ? parsed.notes : undefined, scoredAt };
  } catch (err) { return { sessionId, sessionLengthChars: transcript.length, dimensions: [], overall: 0, scoredAt, error: err instanceof Error ? err.message : String(err) }; }
}

export function compositeQuality(signals: SessionSignals, tr?: TranscriptQualityResult): number {
  const sig = scoreSession(signals);
  if (!tr || tr.dimensions.length === 0 || tr.error) return sig;
  return Math.round((0.6 * sig + 0.4 * Math.max(0, Math.min(1, tr.overall / 5))) * 1000) / 1000;
}

export async function scoreTranscriptBatch(
  sessions: Array<{ sessionId: string; transcript: string }>, config: TranscriptScoreConfig,
  opts?: { onProgress?: (done: number, total: number) => void },
): Promise<TranscriptQualityResult[]> {
  const results: TranscriptQualityResult[] = [];
  for (let i = 0; i < sessions.length; i++) {
    results.push(await scoreTranscript(sessions[i].sessionId, sessions[i].transcript, config));
    opts?.onProgress?.(i + 1, sessions.length);
  }
  return results;
}
