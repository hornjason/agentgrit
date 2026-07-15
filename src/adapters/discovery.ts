import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ── Types ──

export interface ClaudeCodeInstall {
  home: string;
  projects: Record<string, unknown>;
  githubRepoPaths: Record<string, string[]>;
}

export interface RuleScanResult {
  totalRules: number;
  files: Array<{ path: string; ruleCount: number; lineCount: number }>;
}

export interface TranscriptSignals {
  ratings: Array<{ score: string; sessionId: string; timestamp: string }>;
  corrections: Array<{ phrase: string; context: string; sessionId: string }>;
  toolUsage: Record<string, number>;
  skillInvocations: Array<{ skill: string; sessionId: string }>;
  sessionsScanned: number;
  sessionsSkipped: number;
}

export interface SignalSourceResult {
  source: "pai" | "agentgrit" | "none";
  signalDir: string;
  counts?: { ratings?: number; corrections?: number };
}

export interface MemoryInventory {
  totalFiles: number;
  byProject: Record<string, number>;
}

export interface HookEntry {
  matcher: string;
  hooks: Array<{ type: string; command: string; timeout?: number }>;
}

// ── Constants ──

const CORRECTION_STARTERS = [
  "no ", "no,", "wrong", "stop", "don't", "dont", "not that",
  "fix", "undo", "revert", "that broke",
];

const NOISE_PHRASES = [
  "no problem", "no worries", "not bad", "no rush", "no issue",
  "no need", "not a problem",
];

const AGENTGRIT_HOOK_MARKER = "npx agentgrit capture";

// ── Discovery functions ──

export function discoverClaudeCode(): ClaudeCodeInstall | null {
  const home = join(homedir(), ".claude");
  const configPath = join(homedir(), ".claude.json");

  if (!existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    return {
      home,
      projects: raw.projects ?? {},
      githubRepoPaths: raw.githubRepoPaths ?? {},
    };
  } catch {
    return null;
  }
}

export function scanRuleFiles(projectPaths: string[]): RuleScanResult {
  const files: RuleScanResult["files"] = [];
  const seen = new Set<string>();

  const globalClaudeMd = join(homedir(), ".claude", "CLAUDE.md");
  const globalRulesDir = join(homedir(), ".claude", "rules");

  scanFile(globalClaudeMd, files, seen);
  scanRulesDir(globalRulesDir, files, seen);

  for (const projectPath of projectPaths) {
    scanFile(join(projectPath, ".claude", "CLAUDE.md"), files, seen);
    scanRulesDir(join(projectPath, ".claude", "rules"), files, seen);
    scanFile(join(projectPath, "CLAUDE.md"), files, seen);
  }

  return {
    totalRules: files.reduce((sum, f) => sum + f.ruleCount, 0),
    files,
  };
}

function scanFile(
  path: string,
  out: RuleScanResult["files"],
  seen: Set<string>,
): void {
  if (!existsSync(path) || seen.has(path)) return;
  seen.add(path);

  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n");
  const ruleCount = countRules(lines);

  if (ruleCount > 0) {
    out.push({ path, ruleCount, lineCount: lines.length });
  }
}

function scanRulesDir(
  dir: string,
  out: RuleScanResult["files"],
  seen: Set<string>,
): void {
  if (!existsSync(dir)) return;
  try {
    const entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
    for (const entry of entries) {
      scanFile(join(dir, entry), out, seen);
    }
  } catch {}
}

function countRules(lines: string[]): number {
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("- **") || trimmed.startsWith("- `")) {
      count++;
    }
  }
  return count;
}

export function scanTranscripts(projectDirs: string[]): TranscriptSignals {
  const result: TranscriptSignals = {
    ratings: [],
    corrections: [],
    toolUsage: {},
    skillInvocations: [],
    sessionsScanned: 0,
    sessionsSkipped: 0,
  };

  const transcriptsBase = join(homedir(), ".claude", "projects");
  if (!existsSync(transcriptsBase)) return result;

  let dirs: string[];
  try {
    dirs = readdirSync(transcriptsBase);
  } catch {
    return result;
  }

  for (const dir of dirs) {
    const dirPath = join(transcriptsBase, dir);
    let stat;
    try {
      stat = statSync(dirPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    let files: string[];
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(dirPath, file);
      processTranscript(filePath, dir, result);
    }
  }

  return result;
}

function processTranscript(
  filePath: string,
  encodedProject: string,
  result: TranscriptSignals,
): void {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return;
  }

  const lines = content.split("\n").filter((l) => l.trim());
  if (lines.length <= 50) {
    result.sessionsSkipped++;
    return;
  }

  result.sessionsScanned++;

  let sessionId = extractSessionId(filePath);
  let lastAssistantText = "";

  for (const line of lines) {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed.type === "last-prompt" && parsed.sessionId) {
      sessionId = parsed.sessionId;
    }

    if (parsed.type === "user") {
      const text = extractUserText(parsed);
      if (!text) continue;

      const rating = extractRating(text);
      if (rating) {
        result.ratings.push({
          score: rating,
          sessionId,
          timestamp: parsed.timestamp ?? new Date().toISOString(),
        });
      }

      if (isCorrection(text)) {
        result.corrections.push({
          phrase: text.slice(0, 200),
          context: lastAssistantText.slice(0, 200),
          sessionId,
        });
      }
    }

    if (parsed.type === "assistant") {
      const blocks = Array.isArray(parsed.message?.content)
        ? parsed.message.content
        : Array.isArray(parsed.content)
          ? parsed.content
          : [];

      for (const block of blocks) {
        if (block.type === "text") {
          lastAssistantText = typeof block.text === "string" ? block.text : "";
        }
        if (block.type === "tool_use") {
          const toolName = block.name ?? "unknown";
          result.toolUsage[toolName] = (result.toolUsage[toolName] ?? 0) + 1;

          if (toolName === "Skill" && block.input?.skill) {
            result.skillInvocations.push({
              skill: block.input.skill,
              sessionId,
            });
          }
        }
      }
    }
  }
}

function extractSessionId(filePath: string): string {
  const base = filePath.split("/").pop() ?? "";
  return base.replace(".jsonl", "");
}

function extractUserText(parsed: any): string | null {
  if (typeof parsed.message?.content === "string") return parsed.message.content;
  if (typeof parsed.content === "string") return parsed.content;

  const blocks = Array.isArray(parsed.message?.content)
    ? parsed.message.content
    : Array.isArray(parsed.content)
      ? parsed.content
      : [];

  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return null;
}

function extractRating(text: string): string | null {
  const rateMatch = text.match(/\/rate\s+(M:\d+\s+S:\d+\s+Q:\d+)/i);
  if (rateMatch) return rateMatch[1];

  const bareMatch = text.match(/M:\d+\s+S:\d+\s+Q:\d+/i);
  if (bareMatch) return bareMatch[0];

  return null;
}

function isCorrection(text: string): boolean {
  const lower = text.toLowerCase().trim();

  for (const noise of NOISE_PHRASES) {
    if (lower.startsWith(noise)) return false;
  }

  for (const starter of CORRECTION_STARTERS) {
    if (lower.startsWith(starter)) return true;
  }

  return false;
}

export function detectSignalSources(): SignalSourceResult {
  const paiSignals = join(homedir(), ".claude", "MEMORY", "LEARNING", "SIGNALS");
  if (existsSync(paiSignals)) {
    const counts = countSignalFiles(paiSignals);
    return { source: "pai", signalDir: paiSignals, counts };
  }

  const agentgritSignals = join(
    process.env.AGENTGRIT_DIR ?? join(homedir(), ".agentgrit"),
    "signals",
  );
  if (existsSync(agentgritSignals)) {
    return { source: "agentgrit", signalDir: agentgritSignals };
  }

  return { source: "none", signalDir: agentgritSignals };
}

function countSignalFiles(dir: string): { ratings?: number; corrections?: number } {
  const counts: { ratings?: number; corrections?: number } = {};

  const ratingsPath = join(dir, "ratings.jsonl");
  if (existsSync(ratingsPath)) {
    try {
      counts.ratings = readFileSync(ratingsPath, "utf-8")
        .split("\n")
        .filter((l) => l.trim()).length;
    } catch {}
  }

  const correctionsPath = join(dir, "corrections.jsonl");
  if (existsSync(correctionsPath)) {
    try {
      counts.corrections = readFileSync(correctionsPath, "utf-8")
        .split("\n")
        .filter((l) => l.trim()).length;
    } catch {}
  }

  return counts;
}

export function inventoryMemoryFiles(projectDirs: string[]): MemoryInventory {
  const result: MemoryInventory = { totalFiles: 0, byProject: {} };

  const transcriptsBase = join(homedir(), ".claude", "projects");
  if (!existsSync(transcriptsBase)) return result;

  let dirs: string[];
  try {
    dirs = readdirSync(transcriptsBase);
  } catch {
    return result;
  }

  for (const dir of dirs) {
    const memDir = join(transcriptsBase, dir, "memory");
    if (!existsSync(memDir)) continue;

    try {
      const mdFiles = readdirSync(memDir).filter((f) => f.endsWith(".md"));
      if (mdFiles.length > 0) {
        result.byProject[dir] = mdFiles.length;
        result.totalFiles += mdFiles.length;
      }
    } catch {}
  }

  return result;
}

export function installHooks(settingsPath: string): {
  installed: number;
  existing: number;
  skipped: number;
} {
  let settings: any = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      settings = {};
    }
  }

  if (!settings.hooks) settings.hooks = {};

  const hookDefs: Array<{
    event: string;
    matcher: string;
    command: string;
    timeout: number;
  }> = [
    { event: "UserPromptSubmit", matcher: "", command: "npx agentgrit capture rating", timeout: 5000 },
    { event: "UserPromptSubmit", matcher: "", command: "npx agentgrit capture correction", timeout: 5000 },
    { event: "UserPromptSubmit", matcher: "", command: "npx agentgrit capture sentiment", timeout: 5000 },
    { event: "PostToolUse", matcher: "", command: "npx agentgrit capture tool", timeout: 5000 },
    { event: "PostToolUse", matcher: "Skill", command: "npx agentgrit capture skill", timeout: 5000 },
    { event: "Stop", matcher: "", command: "npx agentgrit capture assertions", timeout: 5000 },
    { event: "SessionEnd", matcher: "", command: "npx agentgrit capture session", timeout: 10000 },
    { event: "SessionEnd", matcher: "", command: "npx agentgrit capture debrief", timeout: 10000 },
  ];

  let installed = 0;
  let existing = 0;
  let skipped = 0;

  for (const def of hookDefs) {
    if (!settings.hooks[def.event]) {
      settings.hooks[def.event] = [];
    }

    const eventHooks: HookEntry[] = settings.hooks[def.event];
    const alreadyExists = eventHooks.some((entry) =>
      entry.matcher === def.matcher &&
      entry.hooks?.some((h) => h.command === def.command),
    );

    if (alreadyExists) {
      existing++;
      continue;
    }

    const matchingMatcher = eventHooks.find((entry) => entry.matcher === def.matcher);
    if (matchingMatcher) {
      matchingMatcher.hooks.push({
        type: "command",
        command: def.command,
        timeout: def.timeout,
      });
    } else {
      eventHooks.push({
        matcher: def.matcher,
        hooks: [{ type: "command", command: def.command, timeout: def.timeout }],
      });
    }
    installed++;
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");

  return { installed, existing, skipped };
}

export function countExistingHooks(settingsPath: string): number {
  if (!existsSync(settingsPath)) return 0;

  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!settings.hooks) return 0;

    let count = 0;
    for (const event of Object.keys(settings.hooks)) {
      const entries: HookEntry[] = settings.hooks[event];
      for (const entry of entries) {
        count += entry.hooks?.length ?? 0;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Install Claude Code integration hooks into settings.json.
 * Generates hook registrations for:
 *   - SessionStart: context injection (graph context)
 *   - SessionEnd: session scoring (sentiment capture)
 *   - PostToolUse: tool audit capture
 *
 * Merges with existing config — never overwrites non-hook settings.
 */
export function installClaudeCodeHooks(settingsPath: string): {
  installed: number;
  existing: number;
  skipped: number;
} {
  let settings: any = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      settings = {};
    }
  }

  if (!settings.hooks) settings.hooks = {};

  const hookDefs: Array<{
    event: string;
    matcher: string;
    command: string;
    timeout: number;
  }> = [
    { event: "SessionStart", matcher: "", command: "npx agentgrit graph context", timeout: 10000 },
    { event: "SessionEnd", matcher: "", command: "npx agentgrit capture sentiment", timeout: 10000 },
    { event: "PostToolUse", matcher: ".*", command: "npx agentgrit capture tool", timeout: 5000 },
  ];

  let installed = 0;
  let existing = 0;
  let skipped = 0;

  for (const def of hookDefs) {
    if (!settings.hooks[def.event]) {
      settings.hooks[def.event] = [];
    }

    const eventHooks: HookEntry[] = settings.hooks[def.event];
    const alreadyExists = eventHooks.some((entry) =>
      entry.matcher === def.matcher &&
      entry.hooks?.some((h) => h.command === def.command),
    );

    if (alreadyExists) {
      existing++;
      continue;
    }

    const matchingMatcher = eventHooks.find((entry) => entry.matcher === def.matcher);
    if (matchingMatcher) {
      matchingMatcher.hooks.push({
        type: "command",
        command: def.command,
        timeout: def.timeout,
      });
    } else {
      eventHooks.push({
        matcher: def.matcher,
        hooks: [{ type: "command", command: def.command, timeout: def.timeout }],
      });
    }
    installed++;
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");

  return { installed, existing, skipped };
}
