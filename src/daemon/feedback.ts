import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { inference, type InferenceOptions, type InferenceResult } from "../adapters/inference";
import type { RatingSignal } from "../adapters/types";

export type InferenceFn = (opts: InferenceOptions) => Promise<InferenceResult>;

export interface FeedbackResult {
  filesWritten: string[];
  errors: string[];
}

interface SessionGroup {
  sessionId: string;
  ratings: RatingSignal[];
  avgRating: number;
}

function groupBySession(ratings: RatingSignal[]): SessionGroup[] {
  const map = new Map<string, RatingSignal[]>();
  for (const r of ratings) {
    const group = map.get(r.session_id) || [];
    group.push(r);
    map.set(r.session_id, group);
  }

  return [...map.entries()].map(([sessionId, sessionRatings]) => {
    const avg =
      sessionRatings.reduce((sum, r) => sum + r.rating, 0) /
      sessionRatings.length;
    return { sessionId, ratings: sessionRatings, avgRating: avg };
  });
}

function toSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

function alreadyGenerated(memoryDir: string, sessionId: string, prefix: string): boolean {
  const markerPath = join(memoryDir, ".generated-sessions.json");
  if (!existsSync(markerPath)) return false;
  try {
    const data = JSON.parse(readFileSync(markerPath, "utf-8")) as Record<string, string[]>;
    return (data[prefix] || []).includes(sessionId);
  } catch {
    return false;
  }
}

function markGenerated(memoryDir: string, sessionId: string, prefix: string): void {
  const markerPath = join(memoryDir, ".generated-sessions.json");
  let data: Record<string, string[]> = {};
  if (existsSync(markerPath)) {
    try {
      data = JSON.parse(readFileSync(markerPath, "utf-8"));
    } catch { /* start fresh */ }
  }
  if (!data[prefix]) data[prefix] = [];
  if (!data[prefix].includes(sessionId)) {
    data[prefix].push(sessionId);
    // Keep only last 500 entries per prefix
    if (data[prefix].length > 500) data[prefix] = data[prefix].slice(-500);
  }
  writeFileSync(markerPath, JSON.stringify(data, null, 2));
}

export async function generateFeedback(
  ratings: RatingSignal[],
  memoryDir: string,
  infer: InferenceFn = inference,
): Promise<FeedbackResult> {
  const result: FeedbackResult = { filesWritten: [], errors: [] };

  if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });

  const sessions = groupBySession(ratings).filter((s) => s.avgRating <= 4);

  for (const session of sessions) {
    if (alreadyGenerated(memoryDir, session.sessionId, "feedback")) continue;

    const comments = session.ratings
      .filter((r) => r.comment || r.sentimentSummary)
      .map((r) => r.comment || r.sentimentSummary)
      .join("\n");

    if (!comments.trim()) {
      markGenerated(memoryDir, session.sessionId, "feedback");
      continue;
    }

    try {
      const inferResult = await infer({
        systemPrompt:
          "Extract a single behavioral lesson from this low-rated session. " +
          "Output a JSON object with: " +
          '{"name": "kebab-case-slug", "description": "one-line summary", "lesson": "2-3 sentence behavioral rule"}',
        userPrompt: `Session ${session.sessionId} (avg rating: ${session.avgRating.toFixed(1)}):\n${comments}`,
        level: "fast",
        expectJson: true,
      });

      if (!inferResult.success || !inferResult.parsed) {
        result.errors.push(`inference failed for ${session.sessionId}: ${inferResult.error || "no output"}`);
        continue;
      }

      const parsed = inferResult.parsed as { name?: string; description?: string; lesson?: string };
      const name = toSlug(parsed.name || session.sessionId);
      const description = parsed.description || "Behavioral feedback from low-rated session";
      const lesson = parsed.lesson || "No lesson extracted";

      const filename = `feedback_${name}.md`;
      const filepath = join(memoryDir, filename);

      const content = [
        "---",
        `name: ${name}`,
        `description: ${description}`,
        "metadata:",
        "  type: feedback",
        `  source_session: ${session.sessionId}`,
        `  source_rating: ${session.avgRating.toFixed(1)}`,
        `  generated: ${new Date().toISOString()}`,
        "---",
        "",
        lesson,
        "",
      ].join("\n");

      writeFileSync(filepath, content);
      result.filesWritten.push(filepath);
      markGenerated(memoryDir, session.sessionId, "feedback");
    } catch (err) {
      result.errors.push(
        `feedback for ${session.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}

export async function generateSuccess(
  ratings: RatingSignal[],
  memoryDir: string,
  infer: InferenceFn = inference,
): Promise<FeedbackResult> {
  const result: FeedbackResult = { filesWritten: [], errors: [] };

  if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });

  const sessions = groupBySession(ratings).filter((s) => s.avgRating >= 8);

  for (const session of sessions) {
    if (alreadyGenerated(memoryDir, session.sessionId, "success")) continue;

    const comments = session.ratings
      .filter((r) => r.comment || r.sentimentSummary)
      .map((r) => r.comment || r.sentimentSummary)
      .join("\n");

    if (!comments.trim()) {
      markGenerated(memoryDir, session.sessionId, "success");
      continue;
    }

    try {
      const inferResult = await infer({
        systemPrompt:
          "Extract what went well in this high-rated session as a reusable success pattern. " +
          "Output a JSON object with: " +
          '{"name": "kebab-case-slug", "description": "one-line summary", "pattern": "2-3 sentence success pattern to replicate"}',
        userPrompt: `Session ${session.sessionId} (avg rating: ${session.avgRating.toFixed(1)}):\n${comments}`,
        level: "fast",
        expectJson: true,
      });

      if (!inferResult.success || !inferResult.parsed) {
        result.errors.push(`inference failed for ${session.sessionId}: ${inferResult.error || "no output"}`);
        continue;
      }

      const parsed = inferResult.parsed as { name?: string; description?: string; pattern?: string };
      const name = toSlug(parsed.name || session.sessionId);
      const description = parsed.description || "Success pattern from high-rated session";
      const pattern = parsed.pattern || "No pattern extracted";

      const filename = `success_${name}.md`;
      const filepath = join(memoryDir, filename);

      const content = [
        "---",
        `name: ${name}`,
        `description: ${description}`,
        "metadata:",
        "  type: success",
        `  source_session: ${session.sessionId}`,
        `  source_rating: ${session.avgRating.toFixed(1)}`,
        `  generated: ${new Date().toISOString()}`,
        "---",
        "",
        pattern,
        "",
      ].join("\n");

      writeFileSync(filepath, content);
      result.filesWritten.push(filepath);
      markGenerated(memoryDir, session.sessionId, "success");
    } catch (err) {
      result.errors.push(
        `success for ${session.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}
