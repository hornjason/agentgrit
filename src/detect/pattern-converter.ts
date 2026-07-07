/**
 * pattern-converter.ts — Convert NEW GAP patterns from reports to memory files
 *
 * Ported from PAI Tools/PatternReportConverter.ts.
 * Reads pattern synthesis reports, finds patterns marked "NEW GAP",
 * converts them to feedback memory files with dedup.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// ── Types ──

export interface NewGapPattern {
  name: string;
  slug: string;
  commonTheme: string;
  suggestedRule: string;
  reportFile: string;
}

export interface ConversionResult {
  found: number;
  written: number;
  skipped: number;
  filesCreated: string[];
}

// ── State management ──

export function readProcessedReports(statePath: string): Record<string, string[]> {
  if (!existsSync(statePath)) return {};
  try {
    return JSON.parse(readFileSync(statePath, "utf-8"));
  } catch {
    return {};
  }
}

export function saveProcessedReports(
  statePath: string,
  state: Record<string, string[]>,
): void {
  const dir = require("path").dirname(statePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
}

// ── Report parsing ──

export function parseNewGapPatterns(
  reportContent: string,
  reportFile: string,
): NewGapPattern[] {
  const patterns: NewGapPattern[] = [];
  const patternBlocks = reportContent.split(/(?=###\s+Pattern\s+\d+:)/);

  for (const block of patternBlocks) {
    if (!block.includes("**Existing feedback memory:** NONE — NEW GAP")) continue;

    const nameMatch = block.match(/###\s+Pattern\s+\d+:\s+(.+)/);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();

    const themeMatch = block.match(
      /\*\*Common theme:\*\*\s+(.+?)(?=\n\n|\n\*\*)/s,
    );
    if (!themeMatch) continue;
    const commonTheme = themeMatch[1].trim().replace(/\n/g, " ");

    const ruleMatch = block.match(
      /\*\*Suggested rule:\*\*\s+(.+?)(?=\n\n###|\n---|\n\*Generated|$)/s,
    );
    if (!ruleMatch) continue;
    const suggestedRule = ruleMatch[1].trim().replace(/\n/g, " ");

    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50);

    patterns.push({ name, slug, commonTheme, suggestedRule, reportFile });
  }

  return patterns;
}

// ── Dedup ──

export function getExistingFeedbackSlugs(memoryDir: string): Set<string> {
  if (!existsSync(memoryDir)) return new Set();
  const files = readdirSync(memoryDir).filter(
    (f) => f.startsWith("feedback_") && f.endsWith(".md"),
  );
  return new Set(
    files.map((f) => f.replace(/^feedback_/, "").replace(/\.md$/, "")),
  );
}

// ── Memory file writer ──

export function writeFeedbackMemory(
  pattern: NewGapPattern,
  memoryDir: string,
): string {
  if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });

  const filename = `feedback_${pattern.slug}.md`;
  const filepath = join(memoryDir, filename);

  const description =
    pattern.commonTheme.length > 120
      ? pattern.commonTheme.slice(0, 117) + "..."
      : pattern.commonTheme;

  const howToApply = pattern.suggestedRule.split(/\.\s+/)[0] + ".";

  const content = [
    "---",
    `name: ${pattern.slug}`,
    `description: ${description}`,
    "type: feedback",
    "---",
    "",
    pattern.suggestedRule,
    "",
    `**Why:** Identified as recurring NEW GAP pattern in pattern synthesis report.`,
    `**How to apply:** ${howToApply}`,
    "",
  ].join("\n");

  writeFileSync(filepath, content, "utf-8");
  return filename;
}

// ── Main conversion pipeline ──

export function convertPatternReports(
  reportsDir: string,
  memoryDir: string,
  statePath: string,
): ConversionResult {
  const result: ConversionResult = {
    found: 0,
    written: 0,
    skipped: 0,
    filesCreated: [],
  };

  if (!existsSync(reportsDir)) return result;

  const reportFiles = readdirSync(reportsDir).filter((f) => f.endsWith(".md"));
  const processedState = readProcessedReports(statePath);
  const existingSlugs = getExistingFeedbackSlugs(memoryDir);

  for (const reportFile of reportFiles) {
    const reportPath = join(reportsDir, reportFile);
    const content = readFileSync(reportPath, "utf-8");
    const patterns = parseNewGapPatterns(content, reportFile);

    result.found += patterns.length;
    const alreadyProcessed = processedState[reportFile] || [];

    for (const pattern of patterns) {
      if (alreadyProcessed.includes(pattern.slug)) {
        result.skipped++;
        continue;
      }

      if (existingSlugs.has(pattern.slug)) {
        if (!alreadyProcessed.includes(pattern.slug)) {
          alreadyProcessed.push(pattern.slug);
        }
        result.skipped++;
        continue;
      }

      const filename = writeFeedbackMemory(pattern, memoryDir);
      alreadyProcessed.push(pattern.slug);
      existingSlugs.add(pattern.slug);
      result.filesCreated.push(filename);
      result.written++;
    }

    processedState[reportFile] = alreadyProcessed;
  }

  saveProcessedReports(statePath, processedState);
  return result;
}
