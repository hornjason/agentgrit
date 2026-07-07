import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import {
  toSlug,
  loadReflections,
  slugExists,
  buildSkillMd,
  feedSuppressedToBenchmarks,
  getLiveSkillSlugs,
  getRouterUsageCounts,
  type Cluster,
  type Reflection,
  type SuppressedCluster,
} from "../../src/optimize/skill-forge";

const TEST_DIR = "/tmp/agentgrit-skill-forge-test-" + process.pid;
const SKILLS_DIR = join(TEST_DIR, "skills");
const PROPOSED_DIR = join(SKILLS_DIR, "_PROPOSED");
const STATE_DIR = join(TEST_DIR, "state");
const SIGNALS_DIR = join(TEST_DIR, "signals");

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(SKILLS_DIR, { recursive: true });
  mkdirSync(PROPOSED_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(SIGNALS_DIR, { recursive: true });
});

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("toSlug", () => {
  test("converts to kebab-case", () => {
    expect(toSlug("Debug Container Issues")).toBe("debug-container-issues");
  });

  test("strips special characters", () => {
    expect(toSlug("Fix API (v2) endpoint!")).toBe("fix-api-v2-endpoint");
  });

  test("truncates to 40 chars", () => {
    const long = "a".repeat(60);
    expect(toSlug(long).length).toBeLessThanOrEqual(40);
  });

  test("strips leading/trailing hyphens", () => {
    expect(toSlug("--hello--")).toBe("hello");
  });

  test("returns empty for empty input", () => {
    expect(toSlug("")).toBe("");
  });
});

describe("loadReflections", () => {
  test("parses valid JSONL", () => {
    const file = join(TEST_DIR, "reflections.jsonl");
    const lines = [
      JSON.stringify({ task_description: "Fix bug in auth" }),
      JSON.stringify({ task_description: "Deploy container" }),
    ];
    writeFileSync(file, lines.join("\n"));

    const result = loadReflections(file);
    expect(result).toHaveLength(2);
    expect(result[0].task_description).toBe("Fix bug in auth");
  });

  test("skips malformed lines", () => {
    const file = join(TEST_DIR, "reflections.jsonl");
    writeFileSync(file, "not json\n" + JSON.stringify({ task_description: "valid" }));

    const result = loadReflections(file);
    expect(result).toHaveLength(1);
  });

  test("skips entries without task_description", () => {
    const file = join(TEST_DIR, "reflections.jsonl");
    writeFileSync(file, JSON.stringify({ other: "field" }));

    const result = loadReflections(file);
    expect(result).toHaveLength(0);
  });

  test("returns empty for missing file", () => {
    expect(loadReflections("/tmp/nonexistent-" + Date.now())).toHaveLength(0);
  });

  test("respects limit parameter (takes most recent)", () => {
    const file = join(TEST_DIR, "reflections.jsonl");
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ task_description: `task-${i}` }),
    );
    writeFileSync(file, lines.join("\n"));

    const result = loadReflections(file, 3);
    expect(result).toHaveLength(3);
    expect(result[0].task_description).toBe("task-7");
  });
});

describe("slugExists", () => {
  test("detects slug in proposed dir", () => {
    mkdirSync(join(PROPOSED_DIR, "my-skill"), { recursive: true });
    expect(slugExists("my-skill", SKILLS_DIR, PROPOSED_DIR)).toBe(true);
  });

  test("detects slug in skills dir", () => {
    mkdirSync(join(SKILLS_DIR, "live-skill"), { recursive: true });
    expect(slugExists("live-skill", SKILLS_DIR, PROPOSED_DIR)).toBe(true);
  });

  test("case-insensitive match in skills dir", () => {
    mkdirSync(join(SKILLS_DIR, "MySkill"), { recursive: true });
    expect(slugExists("myskill", SKILLS_DIR, PROPOSED_DIR)).toBe(true);
  });

  test("returns false for nonexistent slug", () => {
    expect(slugExists("nonexistent", SKILLS_DIR, PROPOSED_DIR)).toBe(false);
  });
});

describe("getLiveSkillSlugs", () => {
  test("lists skill directories excluding _ and . prefixed", () => {
    mkdirSync(join(SKILLS_DIR, "ship"), { recursive: true });
    mkdirSync(join(SKILLS_DIR, "debug"), { recursive: true });
    mkdirSync(join(SKILLS_DIR, "_PROPOSED"), { recursive: true });
    mkdirSync(join(SKILLS_DIR, ".hidden"), { recursive: true });

    const slugs = getLiveSkillSlugs(SKILLS_DIR);
    expect(slugs).toContain("ship");
    expect(slugs).toContain("debug");
    expect(slugs).not.toContain("_PROPOSED");
    expect(slugs).not.toContain(".hidden");
  });

  test("returns empty for nonexistent dir", () => {
    expect(getLiveSkillSlugs("/tmp/nonexistent-" + Date.now())).toHaveLength(0);
  });
});

describe("getRouterUsageCounts", () => {
  test("counts suggestions from last 30 days", () => {
    const file = join(SIGNALS_DIR, "suggestions.jsonl");
    const recent = new Date().toISOString();
    const lines = [
      JSON.stringify({ timestamp: recent, suggested_skills: ["ship", "debug"] }),
      JSON.stringify({ timestamp: recent, suggested_skills: ["ship"] }),
    ];
    writeFileSync(file, lines.join("\n"));

    const counts = getRouterUsageCounts(file);
    expect(counts.get("ship")).toBe(2);
    expect(counts.get("debug")).toBe(1);
  });

  test("ignores old entries", () => {
    const file = join(SIGNALS_DIR, "suggestions.jsonl");
    const old = new Date();
    old.setDate(old.getDate() - 45);
    writeFileSync(file, JSON.stringify({ timestamp: old.toISOString(), suggested_skills: ["old-skill"] }));

    const counts = getRouterUsageCounts(file);
    expect(counts.get("old-skill")).toBeUndefined();
  });

  test("returns empty for missing file", () => {
    expect(getRouterUsageCounts("/tmp/nonexistent").size).toBe(0);
  });
});

describe("buildSkillMd", () => {
  test("builds scaffold with cluster metadata", () => {
    const cluster: Cluster = {
      label: "Debug Container Issues",
      entries: [
        { task_description: "Fix container startup", implied_sentiment: 8 },
        { task_description: "Debug port binding", implied_sentiment: 6 },
        { task_description: "Container health check", implied_sentiment: 7 },
      ],
    };

    const md = buildSkillMd(cluster, "debug-container-issues", "2026-07-07");

    expect(md).toContain("name: Debug Container Issues");
    expect(md).toContain("cluster_entries: 3");
    expect(md).toContain("avg_implied_sentiment: 7");
    expect(md).toContain("Fix container startup");
    expect(md).toContain("Debug port binding");
    expect(md).toContain("Container health check");
    expect(md).toContain("proposed: 2026-07-07");
  });

  test("handles entries without sentiment", () => {
    const cluster: Cluster = {
      label: "Test",
      entries: [
        { task_description: "a" },
        { task_description: "b" },
        { task_description: "c" },
      ],
    };

    const md = buildSkillMd(cluster, "test", "2026-01-01");
    expect(md).toContain("avg_implied_sentiment: 0");
  });
});

describe("feedSuppressedToBenchmarks", () => {
  test("creates benchmark file for matched skill", () => {
    const suppressed: SuppressedCluster[] = [
      {
        cluster: {
          label: "Debug Issues",
          entries: [
            { task_description: "Fix bug A", implied_sentiment: 7 },
            { task_description: "Fix bug B", implied_sentiment: 8 },
          ],
        },
        matchedSkill: "debugging-and-bug-fixes",
      },
    ];

    const results = feedSuppressedToBenchmarks(suppressed, STATE_DIR);
    expect(results).toHaveLength(1);
    expect(results[0].skill).toBe("debugging-and-bug-fixes");
    expect(results[0].added).toBe(2);

    const benchFile = join(STATE_DIR, "skill-benchmark.json");
    expect(existsSync(benchFile)).toBe(true);

    const bench = JSON.parse(readFileSync(benchFile, "utf-8"));
    expect(bench.tasks).toHaveLength(2);
  });

  test("deduplicates against existing benchmark entries", () => {
    const benchFile = join(STATE_DIR, "skill-benchmark-test-skill.json");
    const existing = {
      generated: "2026-01-01",
      content_hash: "abc",
      tasks: [{ id: "exists", task: "Fix bug A", rating: 7, gold_q1: "", gold_q2: "", domain: "standard" }],
    };
    writeFileSync(benchFile, JSON.stringify(existing));

    const suppressed: SuppressedCluster[] = [
      {
        cluster: {
          label: "Test",
          entries: [{ task_description: "New task", implied_sentiment: 8 }],
        },
        matchedSkill: "test-skill",
      },
    ];

    const results = feedSuppressedToBenchmarks(suppressed, STATE_DIR);
    expect(results[0].added).toBe(1);

    const bench = JSON.parse(readFileSync(benchFile, "utf-8"));
    expect(bench.tasks).toHaveLength(2);
  });

  test("returns empty for no suppressed clusters", () => {
    expect(feedSuppressedToBenchmarks([], STATE_DIR)).toHaveLength(0);
  });
});
