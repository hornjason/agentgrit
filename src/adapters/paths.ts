import { existsSync, readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";
import type { AgentGritConfig, AgentGritPaths } from "./types";

const ENV_KEY = "AGENTGRIT_DIR";
const HOST_ENV_KEY = "AGENTGRIT_HOST_DIR";
const REPO_ENV_KEY = "AGENTGRIT_REPO_ROOT";

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

/**
 * Marker that identifies an AgentGrit checkout. Both files must be present:
 * package.json alone matches any npm package, and a lone src/ directory
 * matches half the repos on the machine.
 */
const REPO_MARKERS = ["package.json", join("src", "daemon", "daemon.ts")];

function isRepoRoot(dir: string): boolean {
  return REPO_MARKERS.every((marker) => existsSync(join(dir, marker)));
}

/**
 * The AgentGrit checkout this code is running from.
 *
 * Derived from the module's own location, walking up until the checkout
 * markers are found — so it is correct in a clone, a git worktree, or anywhere
 * else the repo is placed. It is deliberately NOT derived from the home
 * directory: issue #256 was `join(process.env.HOME, "agentgrit")`, a path that
 * does not exist on a machine whose checkout lives in ~/Projects, and every
 * command spawned there failed in a way the caller never saw.
 *
 * Throws when no checkout can be found, rather than returning a plausible
 * directory. Callers spawn commands in this path; a wrong answer there is an
 * unmeasured run reported as a measurement.
 */
export function agentgritRepoRoot(): string {
  const override = process.env[REPO_ENV_KEY];
  if (override) {
    const resolved = resolve(expandPath(override));
    if (!isRepoRoot(resolved)) {
      throw new Error(
        `${REPO_ENV_KEY}=${override} is not an AgentGrit checkout ` +
          `(expected ${REPO_MARKERS.join(" and ")} under ${resolved})`,
      );
    }
    return resolved;
  }

  let dir = resolve(import.meta.dir);
  for (;;) {
    if (isRepoRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    `could not locate an AgentGrit checkout above ${import.meta.dir} ` +
      `(looked for ${REPO_MARKERS.join(" and ")}); set ${REPO_ENV_KEY} to point at one`,
  );
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

export function resolveMemoryDir(): string {
  const config = loadConfig();
  return expandPath(config.memoryDir ?? join(getBaseDir(), "memory"));
}

export function resolveTranscriptDir(): string | null {
  const config = loadConfig();
  if (config.transcriptDir) return expandPath(config.transcriptDir);
  if (config.memoryDir) {
    const memDir = expandPath(config.memoryDir);
    const parent = join(memDir, "..");
    const candidate = resolve(parent);
    if (existsSync(candidate)) {
      const hasJsonl = readdirSync(candidate).some((f) => f.endsWith(".jsonl"));
      if (hasJsonl) return candidate;
    }
  }
  return null;
}

const SIGNAL_ALIASES: Record<string, string> = {
  "corrections.jsonl": "correction-captures.jsonl",
  "skills.jsonl": "skill-invocations.jsonl",
  "scores.jsonl": "quality-scores.jsonl",
};

export function resolveSignalFile(dir: string, name: string): string {
  const primary = join(dir, name);
  if (existsSync(primary)) return primary;

  const alias = SIGNAL_ALIASES[name];
  if (alias) {
    const aliasPath = join(dir, alias);
    if (existsSync(aliasPath)) return aliasPath;
  }

  return primary;
}

export function stateDir(): string {
  return join(getBaseDir(), "state");
}

export function rubricsDir(): string {
  return join(getBaseDir(), "rubrics");
}

export function signalPath(filename: string): string {
  return join(resolveSignalDir(), filename);
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

// ─── Host integration ────────────────────────────────────────────────────────
// Where the coding agent keeps its own configuration. Claude Code by default,
// but nothing below assumes that: point hostDir somewhere else and every host
// file moves with it. These are the only paths AgentGrit reads from or writes
// to outside its own base dir.

type PathKey = {
  [K in keyof AgentGritPaths]-?: AgentGritPaths[K] extends string | undefined ? K : never;
}[keyof AgentGritPaths];

/** Resolve a configured path, expanding ~ / $HOME, or fall back. */
function configured(key: PathKey, fallback: string): string {
  const value = loadConfig().paths?.[key];
  return value ? expandPath(value) : fallback;
}

export function hostDir(): string {
  const env = process.env[HOST_ENV_KEY];
  if (env) return resolve(expandPath(env));
  return configured("hostDir", join(homedir(), ".claude"));
}

/** The host's global rules file — AgentGrit reads and prunes it. */
export function hostRulesFile(): string {
  return configured("hostRulesFile", join(hostDir(), "CLAUDE.md"));
}

export function hostRulesDir(): string {
  return join(hostDir(), "rules");
}

export function hostSettingsFile(): string {
  return join(hostDir(), "settings.json");
}

/**
 * The host's own registry of known projects (~/.claude.json for Claude Code).
 *
 * The host keeps this as a sibling of its config dir, not inside it, so the
 * default is derived from hostDir rather than from homedir — otherwise this
 * one path stays pinned to the real host while every other path relocates.
 */
export function hostRegistryFile(): string {
  const dir = hostDir();
  return configured("hostRegistryFile", join(dirname(dir), `${basename(dir)}.json`));
}

export function hostTranscriptsDir(): string {
  return configured("hostTranscriptsDir", join(hostDir(), "projects"));
}

/**
 * The folder the host looks for inside a repo. This is a fixed convention of
 * the host tool, so it does NOT follow hostDir — relocating someone's global
 * config dir must not rename the `.claude` folder inside every project.
 */
function hostProjectDirName(): string {
  return loadConfig().paths?.hostProjectDirName ?? ".claude";
}

/** Rules the host loads from inside a project. */
export function hostProjectRulesFile(projectPath: string): string {
  return join(projectPath, hostProjectDirName(), "CLAUDE.md");
}

export function hostProjectRulesDir(projectPath: string): string {
  return join(projectPath, hostProjectDirName(), "rules");
}

/**
 * Generated rules file. Owned by AgentGrit but read by the host, so it has to
 * sit where the host looks — hence hostDir, not the base dir.
 */
export function learnedRulesFile(): string {
  return configured("learnedRulesFile", join(hostDir(), "CLAUDE-LEARNED.md"));
}

// ─── AgentGrit-owned artifacts ───────────────────────────────────────────────
// Internal state. Defaults stay inside the base dir so a fresh install is
// self-contained and a relocated install moves in one piece.

export function ruleDomainsFile(): string {
  return configured("ruleDomainsFile", statePath("rule-domains.json"));
}

export function rulesDir(): string {
  return configured("rulesDir", join(getBaseDir(), "rules"));
}

export function pendingRulesFile(): string {
  return configured("pendingRulesFile", join(getBaseDir(), "PENDING-RULES.md"));
}

export function pendingRulesArchiveFile(): string {
  return configured("pendingRulesArchiveFile", join(getBaseDir(), "PENDING-RULES-ARCHIVE.md"));
}

/** Pre-computed context the host injects at session start. */
export function graphContextFile(): string {
  return configured("graphContextFile", join(getBaseDir(), "context", "GRAPH-CONTEXT.md"));
}

export function patternsFile(): string {
  return configured("patternsFile", statePath("patterns.json"));
}

export function recallScoresFile(): string {
  return configured("recallScoresFile", statePath("recall-scores.json"));
}

export function ratingsFile(): string {
  return signalPath("ratings.jsonl");
}

export function toolAuditFile(): string {
  return signalPath("tool-audit.jsonl");
}

/**
 * Path fragments whose file changes are bookkeeping, not work worth capturing.
 *
 * Knowing that `MEMORY/LEARNING/` is a host directory is host-layout
 * knowledge, so it lives here rather than in the capture module.
 */
const DEFAULT_UNCAPTURED_FRAGMENTS = [
  "MEMORY/WORK/",
  "MEMORY/LEARNING/",
  "MEMORY/STATE/",
  "Plans/",
  "projects/",
  ".git/",
  "node_modules/",
];

export function uncapturedPathFragments(): string[] {
  return loadConfig().paths?.uncapturedFragments ?? DEFAULT_UNCAPTURED_FRAGMENTS;
}

/**
 * A prior learning system's signal directory to read alongside our own.
 * Opt-in: unset means AgentGrit reads only what it owns.
 */
export function legacySignalDir(): string | null {
  const value = loadConfig().paths?.legacySignalDir;
  return value ? expandPath(value) : null;
}
