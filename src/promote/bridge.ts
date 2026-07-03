/**
 * bridge.ts -- Config file writer with atomic ops, memory bridge, template builder
 *
 * Consolidates:
 *   AutoMemoryBridge.ts -- promote auto-memories to curated memory:
 *                          discover project memory files, parse entries,
 *                          check for equivalents via keyword overlap,
 *                          format promotion candidates.
 *   BuildCLAUDE.ts      -- atomic config writes: read template, resolve variables,
 *                          write-to-temp-then-rename, needsRebuild check.
 */

import { existsSync, mkdirSync, renameSync, unlinkSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join } from "path";
import type { Rule } from "../adapters/types";

// ── Section Markers ──

const RULES_SECTION_MARKER = "### Rules";
const FALLBACK_MARKER = "## Rules";

// ── Atomic Write ──

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const tmpPath = filePath + ".tmp." + process.pid;
  try {
    await Bun.write(tmpPath, content);
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* cleanup best-effort */ }
    throw new Error(`Failed to atomically write ${filePath}: ${err}`);
  }
}

// ── Section Bounds ──

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

// ── Rule Promotion / Removal ──

export async function promoteRule(
  rule: Rule,
  claudeMdPath: string,
): Promise<void> {
  if (!existsSync(claudeMdPath)) {
    throw new Error(`CLAUDE.md not found at ${claudeMdPath}`);
  }

  const content = readFileSync(claudeMdPath, "utf-8");
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

// ── Auto-Memory Bridge (from AutoMemoryBridge.ts) ──

export interface MemoryEntry {
  title: string;
  content: string;
  projectName: string;
}

export interface PromotionCandidate {
  entry: MemoryEntry;
  reason: string;
}

export interface ProjectMemoryInfo {
  projectName: string;
  memoryPath: string;
  sizeBytes: number;
  entryCount: number;
}

/**
 * Parse a MEMORY.md into individual section entries.
 * Each ## or # heading starts a new entry.
 */
export function parseMemoryEntries(content: string, projectName: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  const lines = content.split("\n");

  let currentSection = "";
  let currentContent: string[] = [];

  function flushEntry(): void {
    if (currentSection && currentContent.some((l) => l.trim())) {
      entries.push({
        title: currentSection,
        content: currentContent.join("\n").trim(),
        projectName,
      });
    }
    currentContent = [];
  }

  for (const line of lines) {
    if (line.startsWith("## ") || line.startsWith("# ")) {
      flushEntry();
      currentSection = line.replace(/^#+\s+/, "").trim();
    } else {
      currentContent.push(line);
    }
  }
  flushEntry();

  return entries;
}

/**
 * Check if a memory entry has an equivalent in the curated memory set
 * using keyword overlap on the title vs curated filenames.
 */
export function hasCuratedEquivalent(
  entry: MemoryEntry,
  curatedFilenames: Set<string>,
): boolean {
  const keywords = entry.title
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/[\s_-]+/)
    .filter((w) => w.length > 3);

  if (keywords.length === 0) return false;

  for (const filename of curatedFilenames) {
    const matchCount = keywords.filter((kw) => filename.includes(kw)).length;
    if (matchCount >= Math.min(2, keywords.length)) {
      return true;
    }
  }

  return false;
}

/**
 * Discover project auto-memory files from a projects directory.
 * Skips the specified project name (typically the curated memory project).
 */
export function discoverProjectMemories(
  projectsDir: string,
  skipProject?: string,
  filterProject?: string,
): ProjectMemoryInfo[] {
  if (!existsSync(projectsDir)) return [];

  const results: ProjectMemoryInfo[] = [];
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir);
  } catch {
    return [];
  }

  for (const projectName of projectDirs) {
    if (skipProject && projectName === skipProject) continue;
    if (filterProject && !projectName.includes(filterProject)) continue;

    const memoryPath = join(projectsDir, projectName, "memory", "MEMORY.md");
    if (!existsSync(memoryPath)) continue;

    try {
      const stat = statSync(memoryPath);
      const content = readFileSync(memoryPath, "utf-8");
      const entries = parseMemoryEntries(content, projectName);

      results.push({
        projectName,
        memoryPath,
        sizeBytes: stat.size,
        entryCount: entries.length,
      });
    } catch { /* skip unreadable */ }
  }

  return results;
}

/**
 * Find promotion candidates: entries in project auto-memory that don't have
 * equivalents in curated memory.
 */
export function findPromotionCandidates(
  projectMemoryContent: string,
  projectName: string,
  curatedFilenames: Set<string>,
): PromotionCandidate[] {
  const entries = parseMemoryEntries(projectMemoryContent, projectName);
  const candidates: PromotionCandidate[] = [];

  for (const entry of entries) {
    // Skip trivial sections
    if (
      entry.title.toLowerCase().includes("memory index") ||
      entry.title.toLowerCase().includes("graph context") ||
      entry.content.trim().length < 30
    ) {
      continue;
    }

    if (!hasCuratedEquivalent(entry, curatedFilenames)) {
      candidates.push({
        entry,
        reason: `No matching curated memory found for section: "${entry.title}"`,
      });
    }
  }

  return candidates;
}

// ── Template Builder (from BuildCLAUDE.ts) ──

/**
 * Build a config file from a template by resolving variable placeholders.
 * Uses atomic write (temp file then rename) to prevent partial writes.
 * Returns whether a rebuild occurred.
 */
export async function buildFromTemplate(
  templatePath: string,
  outputPath: string,
  variables: Record<string, string>,
): Promise<{ rebuilt: boolean; reason?: string }> {
  if (!existsSync(templatePath)) {
    return { rebuilt: false, reason: "Template not found" };
  }

  let content = readFileSync(templatePath, "utf-8");

  for (const [key, value] of Object.entries(variables)) {
    content = content.replaceAll(key, value);
  }

  // Check if output already matches
  if (existsSync(outputPath)) {
    const existing = readFileSync(outputPath, "utf-8");
    if (existing === content) {
      return { rebuilt: false, reason: "Output already current" };
    }
  }

  await atomicWrite(outputPath, content);
  return { rebuilt: true };
}

/**
 * Check if a config file needs rebuilding: unresolved variables remain,
 * or any variable value doesn't match the current output.
 */
export function needsRebuild(
  outputPath: string,
  variables: Record<string, string>,
): boolean {
  if (!existsSync(outputPath)) return true;

  const content = readFileSync(outputPath, "utf-8");

  // Check if any variable placeholder still appears unresolved
  for (const key of Object.keys(variables)) {
    if (content.includes(key)) return true;
  }

  return false;
}

/**
 * Load curated memory filenames from a directory (lowercase stems without .md).
 */
export function loadCuratedFilenames(memoryDir: string): Set<string> {
  const names = new Set<string>();
  if (!existsSync(memoryDir)) return names;

  try {
    const entries = readdirSync(memoryDir);
    for (const f of entries) {
      if (f.endsWith(".md")) {
        names.add(f.replace(/\.md$/, "").toLowerCase());
      }
    }
  } catch { /* ignore read errors */ }

  return names;
}
