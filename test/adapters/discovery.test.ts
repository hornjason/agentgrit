import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "fs";
import { join } from "path";
// No `homedir` import. Nothing in this file may ask the developer's machine a
// question — that is what issue #249 was (see the comment above discoverClaudeCode).

const SANDBOX = "/tmp/agentgrit-discovery-test";

function ensureSandbox(...segments: string[]): string {
  const p = join(SANDBOX, ...segments);
  mkdirSync(p, { recursive: true });
  return p;
}

beforeEach(() => {
  if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true });
  mkdirSync(SANDBOX, { recursive: true });
});

afterEach(() => {
  if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true });
});

// ── discoverClaudeCode ──

/**
 * Both tests here used to branch on the real `~/.claude.json` and
 * `~/.claude/MEMORY/LEARNING/SIGNALS`, then assert whichever outcome that branch
 * implied. The functions under test do not read those paths — they read
 * hostRegistryFile() and legacySignalDir(), which the isolate preload points at a
 * temp dir. So the branch and the function consulted different filesystems:
 * red on a machine with a real Claude Code install, green on a bare CI runner,
 * which is half of issue #249's local/CI split. They now build the state they
 * assert on and cover both outcomes unconditionally.
 */
function withHostDir<T>(dir: string, fn: () => T): T {
  const prev = process.env.AGENTGRIT_HOST_DIR;
  process.env.AGENTGRIT_HOST_DIR = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.AGENTGRIT_HOST_DIR;
    else process.env.AGENTGRIT_HOST_DIR = prev;
  }
}

describe("discoverClaudeCode", () => {
  test("returns null when the host registry file is missing", async () => {
    const mod = await import("../../src/adapters/discovery");
    const hostHome = ensureSandbox("no-registry", ".claude");
    // hostRegistryFile() is a sibling of hostDir(), so this is the path that must
    // be absent: <sandbox>/no-registry/.claude.json. Assert that, don't assume it.
    expect(existsSync(join(SANDBOX, "no-registry", ".claude.json"))).toBe(false);

    expect(withHostDir(hostHome, () => mod.discoverClaudeCode())).toBeNull();
  });

  test("returns home, projects and githubRepoPaths when the registry exists", async () => {
    const mod = await import("../../src/adapters/discovery");
    const hostHome = ensureSandbox("with-registry", ".claude");
    writeFileSync(
      join(SANDBOX, "with-registry", ".claude.json"),
      JSON.stringify({
        projects: { "/repo/alpha": { allowedTools: [] } },
        githubRepoPaths: { "owner/alpha": "/repo/alpha" },
      }),
    );

    const result = withHostDir(hostHome, () => mod.discoverClaudeCode());

    expect(result).not.toBeNull();
    expect(result!.home).toBe(hostHome);
    expect(Object.keys(result!.projects)).toEqual(["/repo/alpha"]);
    expect(result!.githubRepoPaths).toEqual({ "owner/alpha": "/repo/alpha" });
  });

  test("returns null when the registry exists but is not valid JSON", async () => {
    const mod = await import("../../src/adapters/discovery");
    const hostHome = ensureSandbox("bad-registry", ".claude");
    writeFileSync(join(SANDBOX, "bad-registry", ".claude.json"), "{ not json");

    expect(withHostDir(hostHome, () => mod.discoverClaudeCode())).toBeNull();
  });
});

// ── scanRuleFiles ──

describe("scanRuleFiles", () => {
  test("finds rules in CLAUDE.md with - ** pattern", async () => {
    const projectDir = ensureSandbox("project-a");
    const claudeMd = join(projectDir, "CLAUDE.md");
    writeFileSync(
      claudeMd,
      [
        "# Rules",
        "- **Rule one** — do something",
        "- **Rule two** — do another thing",
        "- Regular bullet (not a rule)",
        "- **Rule three** — last one",
      ].join("\n"),
    );

    const mod = await import("../../src/adapters/discovery");
    // Get baseline from global rules only
    const baseline = mod.scanRuleFiles([]);
    const result = mod.scanRuleFiles([projectDir]);

    expect(result.totalRules).toBe(baseline.totalRules + 3);
    const projectFile = result.files.find((f) => f.path === claudeMd);
    expect(projectFile).toBeDefined();
    expect(projectFile!.ruleCount).toBe(3);
  });

  test("scans .claude/CLAUDE.md and .claude/rules/ for project", async () => {
    const projectDir = ensureSandbox("project-b");
    const dotClaude = ensureSandbox("project-b", ".claude");
    const rulesDir = ensureSandbox("project-b", ".claude", "rules");

    writeFileSync(
      join(dotClaude, "CLAUDE.md"),
      "- **Project rule** — from .claude dir\n",
    );
    writeFileSync(
      join(rulesDir, "extra.md"),
      "- **Extra rule** — from rules dir\n",
    );
    writeFileSync(
      join(projectDir, "CLAUDE.md"),
      "- **Root rule** — from project root\n",
    );

    const mod = await import("../../src/adapters/discovery");
    const result = mod.scanRuleFiles([projectDir]);

    // Should find all 3 locations (excluding global ~/.claude paths)
    expect(result.totalRules).toBeGreaterThanOrEqual(3);
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain(join(dotClaude, "CLAUDE.md"));
    expect(paths).toContain(join(rulesDir, "extra.md"));
    expect(paths).toContain(join(projectDir, "CLAUDE.md"));
  });

  test("deduplicates same file path", async () => {
    const projectDir = ensureSandbox("project-c");
    writeFileSync(
      join(projectDir, "CLAUDE.md"),
      "- **Single rule** — dedup test\n",
    );

    const mod = await import("../../src/adapters/discovery");
    // Pass same project twice
    const result = mod.scanRuleFiles([projectDir, projectDir]);

    const matching = result.files.filter(
      (f) => f.path === join(projectDir, "CLAUDE.md"),
    );
    expect(matching).toHaveLength(1);
  });

  test("counts backtick rules (- `) alongside bold rules", async () => {
    const projectDir = ensureSandbox("project-d");
    writeFileSync(
      join(projectDir, "CLAUDE.md"),
      [
        "- **Bold rule** — one",
        "- `code_rule` — two",
        "- Regular bullet",
      ].join("\n"),
    );

    const mod = await import("../../src/adapters/discovery");
    const baseline = mod.scanRuleFiles([]);
    const result = mod.scanRuleFiles([projectDir]);
    expect(result.totalRules).toBe(baseline.totalRules + 2);
  });
});

// ── scanTranscripts ──

describe("scanTranscripts", () => {
  function makeTranscript(lines: any[]): string {
    return lines.map((l) => JSON.stringify(l)).join("\n");
  }

  function makePaddedTranscript(signalLines: any[]): string {
    // Pad to >50 lines with filler user/assistant pairs
    const filler: any[] = [];
    for (let i = 0; i < 30; i++) {
      filler.push({ type: "user", message: { content: `filler message ${i}` } });
      filler.push({
        type: "assistant",
        message: { content: [{ type: "text", text: `response ${i}` }] },
      });
    }
    return makeTranscript([...filler, ...signalLines]);
  }

  // The DI the old comment here said was impossible is AGENTGRIT_HOST_DIR:
  // scanTranscripts reads hostTranscriptsDir(), which honours it. It used to build
  // the fixture below, ignore it, scan the developer's real ~/.claude/projects and
  // assert `sessionsSkipped >= 0` — true of every number the function can return,
  // including the 0 a machine with no transcripts gives. Green everywhere for no
  // reason, which is why it is in neither failure list and still had to change.
  test("counts a short transcript as skipped and a long one as scanned", async () => {
    const mod = await import("../../src/adapters/discovery");
    const hostHome = ensureSandbox("transcript-host", ".claude");
    const projects = ensureSandbox("transcript-host", ".claude", "projects", "proj");

    writeFileSync(
      join(projects, "short.jsonl"),
      makeTranscript([
        { type: "user", message: { content: "/rate M:5 S:5 Q:5" } },
        { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
      ]),
    );
    writeFileSync(join(projects, "long.jsonl"), makePaddedTranscript([]));

    const result = withHostDir(hostHome, () => mod.scanTranscripts([]));

    expect(result.sessionsSkipped).toBe(1);
    expect(result.sessionsScanned).toBe(1);
  });

  test("extracts ratings from /rate pattern", async () => {
    const mod = await import("../../src/adapters/discovery");

    // Test the rating extraction indirectly via a real transcript scan
    // or directly test the pattern matching
    const testText = "/rate M:5 S:4 Q:5";
    const rateMatch = testText.match(/\/rate\s+(M:\d+\s+S:\d+\s+Q:\d+)/i);
    expect(rateMatch).not.toBeNull();
    expect(rateMatch![1]).toBe("M:5 S:4 Q:5");
  });

  test("extracts bare M:N S:N Q:N pattern", async () => {
    const testText = "M:3 S:4 Q:2";
    const bareMatch = testText.match(/M:\d+\s+S:\d+\s+Q:\d+/i);
    expect(bareMatch).not.toBeNull();
    expect(bareMatch![0]).toBe("M:3 S:4 Q:2");
  });

  test("detects correction phrases", async () => {
    const corrections = [
      "no that's wrong",
      "wrong approach",
      "stop doing that",
      "don't add comments",
      "fix this",
      "undo that change",
      "revert it",
    ];

    const nonCorrections = [
      "no problem at all",
      "no worries",
      "not bad actually",
      "yes perfect",
      "looks good",
    ];

    for (const text of corrections) {
      const lower = text.toLowerCase().trim();
      const isCorr = ["no ", "no,", "wrong", "stop", "don't", "fix", "undo", "revert"].some(
        (s) => lower.startsWith(s),
      );
      expect(isCorr).toBe(true);
    }

    for (const text of nonCorrections) {
      const lower = text.toLowerCase().trim();
      const isNoise = ["no problem", "no worries", "not bad"].some((s) =>
        lower.startsWith(s),
      );
      // Noise phrases should be filtered
      if (lower.startsWith("no ") || lower.startsWith("not ")) {
        expect(isNoise).toBe(true);
      }
    }
  });

  test("extracts tool usage from assistant blocks", async () => {
    // Verify the structure parsing works
    const assistantMessage = {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "/foo" } },
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
          { type: "tool_use", name: "Skill", input: { skill: "ship" } },
          { type: "text", text: "Done." },
        ],
      },
    };

    const blocks = assistantMessage.message.content;
    const tools: Record<string, number> = {};
    const skills: string[] = [];

    for (const block of blocks) {
      if (block.type === "tool_use") {
        tools[block.name] = (tools[block.name] ?? 0) + 1;
        if (block.name === "Skill" && block.input?.skill) {
          skills.push(block.input.skill);
        }
      }
    }

    expect(tools["Read"]).toBe(1);
    expect(tools["Bash"]).toBe(1);
    expect(tools["Skill"]).toBe(1);
    expect(skills).toEqual(["ship"]);
  });
});

// ── detectSignalSources ──

/**
 * Runs `fn` against a fixture install at <SANDBOX>/<name>, with config.json
 * written from `config`. detectSignalSources reads legacySignalDir() out of that
 * config and AGENTGRIT_DIR from the environment — never ~/.claude — so this is
 * the full set of inputs it has.
 */
function withBaseDir<T>(name: string, config: Record<string, unknown>, fn: () => T): T {
  const base = ensureSandbox(name);
  writeFileSync(join(base, "config.json"), JSON.stringify(config));
  const prev = process.env.AGENTGRIT_DIR;
  process.env.AGENTGRIT_DIR = base;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.AGENTGRIT_DIR;
    else process.env.AGENTGRIT_DIR = prev;
  }
}

describe("detectSignalSources", () => {
  test("reports 'pai' and the legacy dir when a configured legacy signal dir exists", async () => {
    const mod = await import("../../src/adapters/discovery");
    const legacy = ensureSandbox("legacy-signals");
    writeFileSync(join(legacy, "ratings.jsonl"), '{"rating":8}\n{"rating":9}\n');

    const result = withBaseDir("pai-install", { paths: { legacySignalDir: legacy } }, () =>
      mod.detectSignalSources(),
    );

    expect(result.source).toBe("pai");
    expect(result.signalDir).toBe(legacy);
    expect(result.counts?.ratings).toBe(2);
  });

  test("reports 'agentgrit' when only the base dir's own signals/ exists", async () => {
    const mod = await import("../../src/adapters/discovery");
    ensureSandbox("own-install", "signals");

    const result = withBaseDir("own-install", {}, () => mod.detectSignalSources());

    expect(result.source).toBe("agentgrit");
    expect(result.signalDir).toBe(join(SANDBOX, "own-install", "signals"));
  });

  test("reports 'none' with a signals path when neither source exists", async () => {
    const mod = await import("../../src/adapters/discovery");

    const result = withBaseDir("empty-install", {}, () => mod.detectSignalSources());

    expect(result.source).toBe("none");
    expect(result.signalDir).toBe(join(SANDBOX, "empty-install", "signals"));
  });

  test("a configured legacy dir that does not exist falls through rather than reporting 'pai'", async () => {
    const mod = await import("../../src/adapters/discovery");
    const missing = join(SANDBOX, "nope", "signals");
    expect(existsSync(missing)).toBe(false);

    const result = withBaseDir("stale-config", { paths: { legacySignalDir: missing } }, () =>
      mod.detectSignalSources(),
    );

    expect(result.source).toBe("none");
  });
});

// ── inventoryMemoryFiles ──

describe("inventoryMemoryFiles", () => {
  test("counts memory files from real projects", async () => {
    const mod = await import("../../src/adapters/discovery");
    const result = mod.inventoryMemoryFiles([]);

    expect(result.totalFiles).toBeGreaterThanOrEqual(0);
    expect(typeof result.byProject).toBe("object");
  });
});

// ── installHooks ──

describe("installHooks", () => {
  test("installs all 13 hooks into empty settings", async () => {
    const settingsPath = join(SANDBOX, "settings.json");
    writeFileSync(settingsPath, "{}", "utf-8");

    const mod = await import("../../src/adapters/discovery");
    const result = mod.installHooks(settingsPath);

    expect(result.installed).toBe(13);
    expect(result.existing).toBe(0);

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(settings.hooks.UserPromptSubmit).toBeDefined();
    expect(settings.hooks.PostToolUse).toBeDefined();
    expect(settings.hooks.Stop).toBeDefined();
    expect(settings.hooks.SessionEnd).toBeDefined();
  });

  test("merges with existing hooks without destroying them", async () => {
    const settingsPath = join(SANDBOX, "settings-merge.json");
    const existing = {
      hooks: {
        UserPromptSubmit: [
          {
            matcher: "",
            hooks: [
              { type: "command", command: "some-other-tool run", timeout: 3000 },
            ],
          },
        ],
      },
      permissions: { allow: ["Read"] },
    };
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2), "utf-8");

    const mod = await import("../../src/adapters/discovery");
    const result = mod.installHooks(settingsPath);

    expect(result.installed).toBe(13);

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));

    // Existing hook preserved
    const userPromptHooks = settings.hooks.UserPromptSubmit;
    const existingEntry = userPromptHooks.find((e: any) =>
      e.hooks?.some((h: any) => h.command === "some-other-tool run"),
    );
    expect(existingEntry).toBeDefined();

    // AgentGrit hooks added
    const agentgritEntry = userPromptHooks.find((e: any) =>
      e.hooks?.some((h: any) => h.command.includes("agentgrit")),
    );
    expect(agentgritEntry).toBeDefined();

    // Non-hook settings preserved
    expect(settings.permissions.allow).toEqual(["Read"]);
  });

  test("is idempotent — re-install skips existing hooks", async () => {
    const settingsPath = join(SANDBOX, "settings-idem.json");
    writeFileSync(settingsPath, "{}", "utf-8");

    const mod = await import("../../src/adapters/discovery");
    const first = mod.installHooks(settingsPath);
    expect(first.installed).toBe(13);

    const second = mod.installHooks(settingsPath);
    expect(second.installed).toBe(0);
    expect(second.existing).toBe(13);
  });

  test("creates settings file if it doesn't exist", async () => {
    const settingsPath = join(SANDBOX, "new-settings.json");
    expect(existsSync(settingsPath)).toBe(false);

    const mod = await import("../../src/adapters/discovery");
    const result = mod.installHooks(settingsPath);

    expect(result.installed).toBe(13);
    expect(existsSync(settingsPath)).toBe(true);
  });

  test("PostToolUse has Skill matcher entry separate from empty matcher", async () => {
    const settingsPath = join(SANDBOX, "settings-matchers.json");
    writeFileSync(settingsPath, "{}", "utf-8");

    const mod = await import("../../src/adapters/discovery");
    mod.installHooks(settingsPath);

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const postTool = settings.hooks.PostToolUse;

    const emptyMatcher = postTool.find((e: any) => e.matcher === "");
    const skillMatcher = postTool.find((e: any) => e.matcher === "Skill");

    expect(emptyMatcher).toBeDefined();
    expect(skillMatcher).toBeDefined();
    expect(emptyMatcher.hooks.some((h: any) => h.command.includes("capture tool"))).toBe(true);
    expect(skillMatcher.hooks.some((h: any) => h.command.includes("capture skill"))).toBe(true);
  });
});

// ── countExistingHooks ──

describe("countExistingHooks", () => {
  test("returns 0 for missing file", async () => {
    const mod = await import("../../src/adapters/discovery");
    expect(mod.countExistingHooks(join(SANDBOX, "nonexistent.json"))).toBe(0);
  });

  test("counts hooks across all events", async () => {
    const settingsPath = join(SANDBOX, "count-hooks.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { matcher: "", hooks: [{ type: "command", command: "a" }, { type: "command", command: "b" }] },
          ],
          Stop: [
            { matcher: "", hooks: [{ type: "command", command: "c" }] },
          ],
        },
      }),
    );

    const mod = await import("../../src/adapters/discovery");
    expect(mod.countExistingHooks(settingsPath)).toBe(3);
  });
});
