/**
 * index.ts - Capture module barrel exports and shared utilities
 *
 * Consolidates:
 * - change-detection.ts: File change detection from transcripts (parseToolUseBlocks,
 *   categorizeChange, isSignificantChange)
 * - learning-utils.ts: Learning categorization helpers (classifyLearning,
 *   isLearningCapture)
 * - Hook registration generator for CLI setup
 */

// ── Re-exports ──

export { captureRating, parseRating, scoreSentiment } from "./rating";
export { computeComposite, truncatePreview, cacheLastResponse } from "./rating";
export { scoreSession, captureSessionSentiment, wordOverlapRatio } from "./rating";
export type { RatingParseResult, Turn, SessionScoreResult } from "./rating";

export { detectCorrection, captureFailure, auditAssertions, extractWorkLearnings } from "./corrections";
export type {
  FailureContext, FailureSignal,
  AssertionViolation, AssertionAuditResult,
  WorkLearning,
} from "./corrections";

export { captureSkillInvocation, classifyOutcome } from "./skills";
export { captureSkillSequence, buildCoOccurrencePairs, analyzeSkillSequence } from "./skills";
export type { SkillOutcome, SkillSequenceEntry, SkillSequenceResult } from "./skills";

export { extractDebrief } from "./debrief";
export type { RuleCandidate, DebriefResult, ApprovalSignal } from "./debrief";

export { captureToolUse, categorizeToolName, buildMinimalAudit } from "./tool-audit";
export type { ToolCategory, ToolAuditEntry, MinimalToolAudit } from "./tool-audit";

// ── File change detection (from change-detection.ts) ──

export type ChangeCategory =
  | "skill"
  | "hook"
  | "workflow"
  | "config"
  | "core-system"
  | "memory-system"
  | "documentation";

export interface FileChange {
  tool: "Write" | "Edit";
  path: string;
  category: ChangeCategory | null;
}

const EXCLUDED_PATHS = [
  "MEMORY/WORK/",
  "MEMORY/LEARNING/",
  "MEMORY/STATE/",
  "Plans/",
  "projects/",
  ".git/",
  "node_modules/",
];

export function categorizeChange(path: string): ChangeCategory | null {
  for (const excluded of EXCLUDED_PATHS) {
    if (path.includes(excluded)) return null;
  }

  if (path.includes("skills/")) {
    if (path.includes("/Workflows/")) return "workflow";
    return "skill";
  }
  if (path.includes("hooks/")) return "hook";
  if (path.endsWith("settings.json")) return "config";
  if (path.includes("MEMORY/")) return "memory-system";
  if (path.endsWith(".md") && !path.includes("WORK/")) return "documentation";

  return null;
}

export function parseToolUseBlocks(
  transcriptLines: string[],
  baseDir?: string,
): FileChange[] {
  const changes: FileChange[] = [];
  const seenPaths = new Set<string>();

  for (const line of transcriptLines) {
    if (!line.trim()) continue;

    try {
      const entry = JSON.parse(line);
      if (entry.type !== "assistant" || !entry.message?.content) continue;

      const blocks = Array.isArray(entry.message.content)
        ? entry.message.content
        : [];

      for (const block of blocks) {
        if (block.type !== "tool_use") continue;

        const toolName = block.name;
        const input = block.input || {};
        let filePath: string | undefined;

        if ((toolName === "Write" || toolName === "Edit") && input.file_path) {
          filePath = input.file_path;
        }

        if (!filePath) continue;

        // Normalize to relative path if baseDir provided
        if (baseDir && filePath.startsWith(baseDir)) {
          filePath = filePath.slice(baseDir.length).replace(/^\//, "");
        }

        if (seenPaths.has(filePath)) continue;
        seenPaths.add(filePath);

        changes.push({
          tool: toolName as "Write" | "Edit",
          path: filePath,
          category: categorizeChange(filePath),
        });
      }
    } catch {
      // skip malformed lines
    }
  }

  return changes;
}

export function isSignificantChange(changes: FileChange[]): boolean {
  const systemChanges = changes.filter((c) => c.category !== null);
  if (systemChanges.length === 0) return false;

  const importantCategories: ChangeCategory[] = [
    "skill", "hook", "core-system", "workflow",
  ];
  if (systemChanges.some((c) => importantCategories.includes(c.category!))) {
    return true;
  }

  if (systemChanges.length >= 2) return true;

  return false;
}

// ── Learning categorization (from learning-utils.ts) ──

export type LearningCategory = "approach" | "tooling";

const APPROACH_INDICATORS: RegExp[] = [
  /over.?engineer/,
  /wrong approach/,
  /should have asked/,
  /didn't follow/,
  /missed the point/,
  /too complex/,
  /didn't understand/,
  /wrong direction/,
  /not what i wanted/,
  /approach|method|strategy|reasoning/,
];

const TOOLING_INDICATORS: RegExp[] = [
  /hook|crash|broken/,
  /tool|config|deploy|path/,
  /import|module|file.*not.*found/,
  /typescript|javascript|npm|bun/,
];

export function classifyLearning(
  content: string,
  comment?: string,
): LearningCategory {
  const text = `${content} ${comment || ""}`.toLowerCase();

  for (const pattern of APPROACH_INDICATORS) {
    if (pattern.test(text)) return "approach";
  }
  for (const pattern of TOOLING_INDICATORS) {
    if (pattern.test(text)) return "tooling";
  }

  // Default: most learnings are about task quality
  return "approach";
}

export function isLearningCapture(
  text: string,
  summary?: string,
): boolean {
  const learningIndicators = [
    /problem|issue|bug|error|failed|broken/i,
    /fixed|solved|resolved|discovered|realized|learned/i,
    /troubleshoot|debug|investigate|root cause/i,
    /lesson|takeaway|now we know|next time/i,
  ];

  const checkText = `${summary || ""} ${text}`;

  let hits = 0;
  for (const pattern of learningIndicators) {
    if (pattern.test(checkText)) hits++;
  }

  return hits >= 2;
}

// ── Hook config generator ──

export interface HookConfig {
  hooks: Record<string, HookEntry[]>;
}

interface HookEntry {
  matcher: string;
  command: string;
}

export function generateHookConfig(): HookConfig {
  const prefix = "npx agentgrit hook";

  return {
    hooks: {
      UserPromptSubmit: [
        {
          matcher: "",
          command: `${prefix} rating`,
        },
        {
          matcher: "",
          command: `${prefix} correction`,
        },
        {
          matcher: "",
          command: `${prefix} sentiment`,
        },
      ],
      PostToolUse: [
        {
          matcher: "Skill",
          command: `${prefix} skill-invocation`,
        },
        {
          matcher: ".*",
          command: `${prefix} tool-audit`,
        },
      ],
      SessionEnd: [
        {
          matcher: "",
          command: `${prefix} debrief`,
        },
      ],
    },
  };
}
