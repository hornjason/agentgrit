/**
 * Path authority tests.
 *
 * Every filesystem location AgentGrit touches must resolve through
 * src/adapters/paths.ts, with env > config > default precedence. The defaults
 * are deliberately host-agnostic: a fresh install must not assume Claude Code,
 * PAI, or this machine's directory layout.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

const ENV_KEYS = ["AGENTGRIT_DIR", "AGENTGRIT_HOST_DIR"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const scratch: string[] = [];

/** A base dir containing the given config, isolated in the OS temp dir. */
function withConfig(config: Record<string, unknown>): string {
  const dir = join(tmpdir(), `agentgrit-paths-${Date.now()}-${scratch.length}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  scratch.push(dir);
  process.env.AGENTGRIT_DIR = dir;
  return dir;
}

/** A base dir with no config file at all — the fresh-install case. */
function withoutConfig(): string {
  const dir = join(tmpdir(), `agentgrit-paths-bare-${Date.now()}-${scratch.length}`);
  mkdirSync(dir, { recursive: true });
  scratch.push(dir);
  process.env.AGENTGRIT_DIR = dir;
  return dir;
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  while (scratch.length) {
    try { rmSync(scratch.pop()!, { recursive: true, force: true }); } catch {}
  }
});

describe("hostDir", () => {
  test("defaults to ~/.claude", async () => {
    withoutConfig();
    delete process.env.AGENTGRIT_HOST_DIR;
    const { hostDir } = await import("../../src/adapters/paths");
    expect(hostDir()).toBe(join(homedir(), ".claude"));
  });

  test("config paths.hostDir overrides the default", async () => {
    withConfig({ paths: { hostDir: "/opt/other-host" } });
    delete process.env.AGENTGRIT_HOST_DIR;
    const { hostDir } = await import("../../src/adapters/paths");
    expect(hostDir()).toBe("/opt/other-host");
  });

  test("env beats config", async () => {
    withConfig({ paths: { hostDir: "/opt/from-config" } });
    process.env.AGENTGRIT_HOST_DIR = "/opt/from-env";
    const { hostDir } = await import("../../src/adapters/paths");
    expect(hostDir()).toBe("/opt/from-env");
  });

  test("expands a tilde in the config value", async () => {
    withConfig({ paths: { hostDir: "~/elsewhere" } });
    delete process.env.AGENTGRIT_HOST_DIR;
    const { hostDir } = await import("../../src/adapters/paths");
    expect(hostDir()).toBe(join(homedir(), "elsewhere"));
  });
});

describe("host files follow hostDir", () => {
  test("rules file, rules dir, settings, transcripts all relocate together", async () => {
    withConfig({ paths: { hostDir: "/opt/host" } });
    delete process.env.AGENTGRIT_HOST_DIR;
    const p = await import("../../src/adapters/paths");
    expect(p.hostRulesFile()).toBe("/opt/host/CLAUDE.md");
    expect(p.hostRulesDir()).toBe("/opt/host/rules");
    expect(p.hostSettingsFile()).toBe("/opt/host/settings.json");
    expect(p.hostTranscriptsDir()).toBe("/opt/host/projects");
  });

  test("learned rules file lives in the host dir, since the host reads it", async () => {
    withConfig({ paths: { hostDir: "/opt/host" } });
    delete process.env.AGENTGRIT_HOST_DIR;
    const { learnedRulesFile } = await import("../../src/adapters/paths");
    expect(learnedRulesFile()).toBe("/opt/host/CLAUDE-LEARNED.md");
  });

  test("learned rules file can be pinned independently of hostDir", async () => {
    withConfig({ paths: { hostDir: "/opt/host", learnedRulesFile: "/elsewhere/LEARNED.md" } });
    delete process.env.AGENTGRIT_HOST_DIR;
    const { learnedRulesFile } = await import("../../src/adapters/paths");
    expect(learnedRulesFile()).toBe("/elsewhere/LEARNED.md");
  });

  test("project rules resolve under the project, not the host dir", async () => {
    withoutConfig();
    const p = await import("../../src/adapters/paths");
    expect(p.hostProjectRulesFile("/work/thing")).toBe("/work/thing/.claude/CLAUDE.md");
    expect(p.hostProjectRulesDir("/work/thing")).toBe("/work/thing/.claude/rules");
  });
});

describe("AgentGrit-owned artifacts default inside the base dir", () => {
  test("none of them reach into the host dir on a fresh install", async () => {
    const base = withoutConfig();
    delete process.env.AGENTGRIT_HOST_DIR;
    const p = await import("../../src/adapters/paths");

    const owned = {
      ruleDomainsFile: p.ruleDomainsFile(),
      rulesDir: p.rulesDir(),
      pendingRulesFile: p.pendingRulesFile(),
      pendingRulesArchiveFile: p.pendingRulesArchiveFile(),
      graphContextFile: p.graphContextFile(),
      patternsFile: p.patternsFile(),
      recallScoresFile: p.recallScoresFile(),
      ratingsFile: p.ratingsFile(),
      toolAuditFile: p.toolAuditFile(),
    };

    for (const [name, value] of Object.entries(owned)) {
      expect(`${name}=${value}`).toBe(`${name}=${value}`); // keeps the name in the failure message
      expect(value.startsWith(base)).toBe(true);
    }
  });

  test("state artifacts land in the state dir", async () => {
    const base = withoutConfig();
    const p = await import("../../src/adapters/paths");
    expect(p.ruleDomainsFile()).toBe(join(base, "state", "rule-domains.json"));
    expect(p.patternsFile()).toBe(join(base, "state", "patterns.json"));
    expect(p.recallScoresFile()).toBe(join(base, "state", "recall-scores.json"));
  });

  test("signal artifacts land in the signal dir", async () => {
    const base = withoutConfig();
    const p = await import("../../src/adapters/paths");
    expect(p.ratingsFile()).toBe(join(base, "signals", "ratings.jsonl"));
    expect(p.toolAuditFile()).toBe(join(base, "signals", "tool-audit.jsonl"));
  });

  test("each artifact is individually overridable by config", async () => {
    withConfig({
      paths: {
        ruleDomainsFile: "/pin/domains.json",
        rulesDir: "/pin/rules",
        pendingRulesFile: "/pin/pending.md",
        graphContextFile: "/pin/context.md",
      },
    });
    const p = await import("../../src/adapters/paths");
    expect(p.ruleDomainsFile()).toBe("/pin/domains.json");
    expect(p.rulesDir()).toBe("/pin/rules");
    expect(p.pendingRulesFile()).toBe("/pin/pending.md");
    expect(p.graphContextFile()).toBe("/pin/context.md");
  });

  test("signalDir config still steers the signal artifacts", async () => {
    withConfig({ signalDir: "/pin/signals" });
    const p = await import("../../src/adapters/paths");
    expect(p.ratingsFile()).toBe("/pin/signals/ratings.jsonl");
  });
});

describe("legacy signal import", () => {
  test("returns null when no legacy source is configured", async () => {
    withoutConfig();
    const { legacySignalDir } = await import("../../src/adapters/paths");
    expect(legacySignalDir()).toBeNull();
  });

  test("returns the configured source, expanded", async () => {
    withConfig({ paths: { legacySignalDir: "~/.claude/MEMORY/LEARNING/SIGNALS" } });
    const { legacySignalDir } = await import("../../src/adapters/paths");
    expect(legacySignalDir()).toBe(join(homedir(), ".claude/MEMORY/LEARNING/SIGNALS"));
  });
});

describe("isolation", () => {
  test("a relocated install puts every owned artifact under the new base", async () => {
    const base = withoutConfig();
    const p = await import("../../src/adapters/paths");
    const everything = [
      p.getBaseDir(), p.stateDir(), p.signalsDir(), p.rubricsDir(),
      p.ruleDomainsFile(), p.rulesDir(), p.pendingRulesFile(),
      p.pendingRulesArchiveFile(), p.graphContextFile(), p.patternsFile(),
      p.recallScoresFile(), p.ratingsFile(), p.toolAuditFile(),
      p.projectDir("/work/thing"),
    ];
    for (const path of everything) expect(path.startsWith(base)).toBe(true);
  });
});
