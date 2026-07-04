import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import type { AgentGritConfig } from "./types";

const ENV_KEY = "AGENTGRIT_DIR";

export function expandPath(path: string): string {
  const home = homedir();
  return path
    .replace(/^\$HOME(?=\/|$)/, home)
    .replace(/^\$\{HOME\}(?=\/|$)/, home)
    .replace(/^~(?=\/|$)/, home);
}

export function getBaseDir(): string {
  const envDir = process.env[ENV_KEY];
  if (envDir) return resolve(expandPath(envDir));
  return join(homedir(), ".agentgrit");
}

export function signalsDir(): string {
  return join(getBaseDir(), "signals");
}

export function loadConfig(): AgentGritConfig {
  const configPath = join(getBaseDir(), "config.json");
  if (!existsSync(configPath)) {
    return { signalDir: join(getBaseDir(), "signals") } as AgentGritConfig;
  }
  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  return raw as AgentGritConfig;
}

export function resolveSignalDir(): string {
  const config = loadConfig();
  return expandPath(config.signalDir ?? join(getBaseDir(), "signals"));
}

export function stateDir(): string {
  return join(getBaseDir(), "state");
}

export function rubricsDir(): string {
  return join(getBaseDir(), "rubrics");
}

export function signalPath(filename: string): string {
  return join(signalsDir(), filename);
}

export function statePath(filename: string): string {
  return join(stateDir(), filename);
}

export function rubricPath(filename: string): string {
  return join(rubricsDir(), filename);
}

export function projectDir(workingDir?: string): string {
  const cwd = workingDir ?? process.cwd();
  const slug = cwd
    .replace(homedir(), "")
    .replace(/^\//, "")
    .replace(/\//g, "-")
    .replace(/[^a-zA-Z0-9_-]/g, "");
  return join(getBaseDir(), "projects", slug);
}

export function projectSignalsDir(workingDir?: string): string {
  return join(projectDir(workingDir), "signals");
}

export function projectStateDir(workingDir?: string): string {
  return join(projectDir(workingDir), "state");
}
