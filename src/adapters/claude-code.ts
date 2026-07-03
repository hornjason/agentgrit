import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { basename, join, resolve } from "path";
import { Tier } from "./types";

export interface HookRegistration {
  type: string;
  event: string;
  command: string;
  timeout?: number;
}

export function generateHookConfig(hooks: HookRegistration[]): object {
  const entries: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>> = {};

  for (const hook of hooks) {
    if (!entries[hook.event]) entries[hook.event] = [];

    const existing = entries[hook.event].find((e) => e.matcher === "");
    const hookDef: { type: string; command: string; timeout?: number } = {
      type: hook.type,
      command: hook.command,
    };
    if (hook.timeout) hookDef.timeout = hook.timeout;

    if (existing) {
      existing.hooks.push(hookDef);
    } else {
      entries[hook.event].push({ matcher: "", hooks: [hookDef] });
    }
  }

  return entries;
}

export function readClaudeMd(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

export function detectTier(filePath: string): Tier {
  const resolved = resolve(filePath);
  const globalPath = join(homedir(), ".claude", "CLAUDE.md");

  if (resolved === globalPath) return Tier.Global;
  return Tier.Project;
}

export function detectProject(workingDir?: string): string {
  const cwd = workingDir ?? process.cwd();

  const packageJsonPath = join(cwd, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
      if (pkg.name) return pkg.name;
    } catch {}
  }

  return basename(cwd);
}

export function findClaudeMdPath(workingDir?: string): string {
  const cwd = workingDir ?? process.cwd();
  const projectPath = join(cwd, "CLAUDE.md");
  if (existsSync(projectPath)) return projectPath;

  const globalPath = join(homedir(), ".claude", "CLAUDE.md");
  if (existsSync(globalPath)) return globalPath;

  return globalPath;
}
