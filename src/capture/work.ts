import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { inference, type InferenceOptions, type InferenceResult } from "../adapters/inference";
import type { WorkLearning } from "./corrections";

export type InferenceFn = (opts: InferenceOptions) => Promise<InferenceResult>;

export interface WorkInsightResult {
  filesWritten: string[];
  errors: string[];
}

function toSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

function alreadyGenerated(memoryDir: string, learningId: string): boolean {
  const markerPath = join(memoryDir, ".generated-sessions.json");
  if (!existsSync(markerPath)) return false;
  try {
    const data = JSON.parse(readFileSync(markerPath, "utf-8")) as Record<string, string[]>;
    return (data["work"] || []).includes(learningId);
  } catch {
    return false;
  }
}

function markGenerated(memoryDir: string, learningId: string): void {
  const markerPath = join(memoryDir, ".generated-sessions.json");
  let data: Record<string, string[]> = {};
  if (existsSync(markerPath)) {
    try {
      data = JSON.parse(readFileSync(markerPath, "utf-8"));
    } catch { /* start fresh */ }
  }
  if (!data["work"]) data["work"] = [];
  if (!data["work"].includes(learningId)) {
    data["work"].push(learningId);
    if (data["work"].length > 500) data["work"] = data["work"].slice(-500);
  }
  writeFileSync(markerPath, JSON.stringify(data, null, 2));
}

export async function generateWorkInsights(
  learnings: WorkLearning[],
  memoryDir: string,
  infer: InferenceFn = inference,
): Promise<WorkInsightResult> {
  const result: WorkInsightResult = { filesWritten: [], errors: [] };

  if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });

  for (const learning of learnings) {
    if (alreadyGenerated(memoryDir, learning.id)) continue;

    const summary = [
      `Task: ${learning.title}`,
      `Category: ${learning.category}`,
      `Files changed: ${learning.filesChanged}`,
      `Tools used: ${learning.toolsUsed.join(", ")}`,
      `Deterministic insights:`,
      ...learning.insights.map((i) => `  - ${i}`),
    ].join("\n");

    if (!summary.trim()) {
      markGenerated(memoryDir, learning.id);
      continue;
    }

    try {
      const inferResult = await infer({
        systemPrompt:
          "Analyze this work completion data and extract a reusable insight. " +
          "Output a JSON object with: " +
          '{"name": "kebab-case-slug", "description": "one-line summary", "insight": "2-3 sentence actionable learning for future sessions"}',
        userPrompt: summary,
        level: "fast",
        expectJson: true,
      });

      if (!inferResult.success || !inferResult.parsed) {
        result.errors.push(`inference failed for ${learning.id}: ${inferResult.error || "no output"}`);
        continue;
      }

      const parsed = inferResult.parsed as { name?: string; description?: string; insight?: string };
      const name = toSlug(parsed.name || learning.id);
      const description = parsed.description || "Work completion insight";
      const insight = parsed.insight || learning.insights.join("; ");

      const filename = `work_${name}.md`;
      const filepath = join(memoryDir, filename);

      const content = [
        "---",
        `name: ${name}`,
        `description: ${description}`,
        "metadata:",
        "  type: work-insight",
        `  category: ${learning.category}`,
        `  files_changed: ${learning.filesChanged}`,
        `  generated: ${new Date().toISOString()}`,
        "---",
        "",
        insight,
        "",
      ].join("\n");

      writeFileSync(filepath, content);
      result.filesWritten.push(filepath);
      markGenerated(memoryDir, learning.id);
    } catch (err) {
      result.errors.push(
        `work insight for ${learning.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}
