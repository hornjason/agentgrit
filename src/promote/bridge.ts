import { existsSync, mkdirSync, renameSync, unlinkSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { Rule } from "../adapters/types";
import { checkContradiction, extractExistingRules, type InferenceFn } from "./contradiction";

const RULES_SECTION_MARKER = "### Rules";
const FALLBACK_MARKER = "## Rules";

function findRulesSectionBounds(
  content: string,
): { markerEnd: number; sectionEnd: number; marker: string } | null {
  for (const marker of [RULES_SECTION_MARKER, FALLBACK_MARKER]) {
    const idx = content.indexOf(marker);
    if (idx === -1) continue;

    const markerEnd = idx + marker.length;
    const afterMarker = content.slice(markerEnd);
    const lines = afterMarker.split("\n");

    let sectionEnd = markerEnd;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (i > 0 && (line.startsWith("## ") || line.startsWith("### ") || line.startsWith("---"))) {
        break;
      }
      sectionEnd += line.length + 1;
    }

    return { markerEnd, sectionEnd, marker };
  }
  return null;
}

function findLastRuleLineOffset(sectionContent: string): number {
  const lines = sectionContent.split("\n");
  let lastRuleLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("- **") || lines[i].startsWith("- ")) {
      lastRuleLine = i;
    }
  }
  return lastRuleLine;
}

export async function promoteRule(
  rule: Rule,
  claudeMdPath: string,
  inferenceFn?: InferenceFn,
): Promise<void> {
  if (!existsSync(claudeMdPath)) {
    throw new Error(`CLAUDE.md not found at ${claudeMdPath}`);
  }

  const content = readFileSync(claudeMdPath, "utf-8");

  const existingRules = extractExistingRules(content);
  const contradiction = await checkContradiction(rule.text, existingRules, inferenceFn);
  if (contradiction.hasConflict) {
    throw new Error(`Contradiction detected: ${contradiction.details}`);
  }

  const bounds = findRulesSectionBounds(content);

  if (!bounds) {
    throw new Error(
      `Could not find rules section ("${RULES_SECTION_MARKER}" or "${FALLBACK_MARKER}") in ${claudeMdPath}`,
    );
  }

  const sectionContent = content.slice(bounds.markerEnd, bounds.sectionEnd);
  const lastRuleLine = findLastRuleLineOffset(sectionContent);

  const ruleLine = `- **${rule.id}:** ${rule.text}`;
  let newContent: string;

  if (lastRuleLine === -1) {
    const before = content.slice(0, bounds.markerEnd);
    const after = content.slice(bounds.markerEnd);
    newContent = before + "\n" + ruleLine + "\n" + after;
  } else {
    const sectionLines = sectionContent.split("\n");
    const beforeInsert = content.slice(0, bounds.markerEnd) +
      sectionLines.slice(0, lastRuleLine + 1).join("\n");
    const afterInsert = sectionLines.slice(lastRuleLine + 1).join("\n") +
      content.slice(bounds.sectionEnd);
    newContent = beforeInsert + "\n" + ruleLine + "\n" + afterInsert;
  }

  await atomicWrite(claudeMdPath, newContent);
}

export async function removeRule(
  ruleId: string,
  claudeMdPath: string,
): Promise<void> {
  if (!existsSync(claudeMdPath)) {
    throw new Error(`CLAUDE.md not found at ${claudeMdPath}`);
  }

  const content = readFileSync(claudeMdPath, "utf-8");
  const rulePattern = `- **${ruleId}:**`;
  const lines = content.split("\n");
  const filtered = lines.filter((line) => !line.startsWith(rulePattern));

  if (filtered.length === lines.length) {
    throw new Error(`Rule "${ruleId}" not found in ${claudeMdPath}`);
  }

  await atomicWrite(claudeMdPath, filtered.join("\n"));
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const tmpPath = filePath + ".tmp." + process.pid;
  try {
    writeFileSync(tmpPath, content);
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* cleanup best-effort */ }
    throw new Error(`Failed to atomically write ${filePath}: ${err}`);
  }
}
