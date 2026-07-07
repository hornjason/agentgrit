import { describe, test, expect } from "bun:test";
import {
  parseFrontmatter,
  rebuildSkillMd,
  countWorkflowSteps,
  countAntipatterns,
  loadReflections,
} from "../../src/optimize/skill-synthesizer";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const TEST_DIR = "/tmp/agentgrit-skill-synthesizer-test-" + process.pid;

describe("parseFrontmatter", () => {
  test("extracts frontmatter and body", () => {
    const content = "---\nname: Test\ndescription: A test\n---\n\n## Body content";
    const result = parseFrontmatter(content);

    expect(result.frontmatterLines).toEqual(["name: Test", "description: A test"]);
    expect(result.body).toContain("## Body content");
  });

  test("returns empty frontmatter when no --- block", () => {
    const content = "## No frontmatter\nJust body";
    const result = parseFrontmatter(content);

    expect(result.frontmatterLines).toEqual([]);
    expect(result.body).toBe(content);
  });

  test("handles unclosed frontmatter", () => {
    const content = "---\nname: Test\nno closing";
    const result = parseFrontmatter(content);

    expect(result.frontmatterLines).toEqual([]);
    expect(result.body).toBe(content);
  });
});

describe("rebuildSkillMd", () => {
  test("preserves original frontmatter and adds promoted date", () => {
    const fm = ["name: MySkill", "source: forge"];
    const body = "## What it does\nSomething useful";
    const result = rebuildSkillMd(fm, body, "2026-07-07");

    expect(result).toContain("name: MySkill");
    expect(result).toContain("source: forge");
    expect(result).toContain("promoted: 2026-07-07");
    expect(result).toContain("## What it does");
  });

  test("does not duplicate promoted date", () => {
    const fm = ["name: MySkill", "promoted: 2026-06-01"];
    const result = rebuildSkillMd(fm, "body", "2026-07-07");

    const matches = result.match(/promoted:/g);
    expect(matches).toHaveLength(1);
    expect(result).toContain("promoted: 2026-06-01");
  });

  test("replaces existing description", () => {
    const fm = ["name: MySkill", "description: Old desc"];
    const result = rebuildSkillMd(fm, "body", "2026-07-07", "New desc");

    expect(result).toContain("description: New desc");
    expect(result).not.toContain("Old desc");
  });

  test("inserts description after name if not present", () => {
    const fm = ["name: MySkill", "source: forge"];
    const result = rebuildSkillMd(fm, "body", "2026-07-07", "Added desc");

    const lines = result.split("\n");
    const nameIdx = lines.findIndex((l) => l.includes("name: MySkill"));
    const descIdx = lines.findIndex((l) => l.includes("description: Added desc"));
    expect(descIdx).toBe(nameIdx + 1);
  });

  test("handles multi-line description replacement", () => {
    const fm = ["name: Test", "description: >", "  Multi-line", "  description here", "source: forge"];
    const result = rebuildSkillMd(fm, "body", "2026-07-07", "Single line desc");

    expect(result).toContain("description: Single line desc");
    expect(result).not.toContain("Multi-line");
    expect(result).toContain("source: forge");
  });
});

describe("countWorkflowSteps", () => {
  test("counts ### Step N headings", () => {
    const body = "## Workflow\n### Step 1 -- Init\nDo stuff\n### Step 2 -- Build\nMore stuff\n### Step 3 -- Verify\nCheck";
    expect(countWorkflowSteps(body)).toBe(3);
  });

  test("returns 0 for no steps", () => {
    expect(countWorkflowSteps("## Just a body\nNo steps here")).toBe(0);
  });
});

describe("countAntipatterns", () => {
  test("counts bullet items in Anti-patterns section", () => {
    const body = "## Anti-patterns\n- Don't do this\n- Or this\n- Or that\n\n## Next section";
    expect(countAntipatterns(body)).toBe(3);
  });

  test("returns 0 when no Anti-patterns section", () => {
    expect(countAntipatterns("## Workflow\n- step")).toBe(0);
  });
});

describe("loadReflections", () => {
  test("parses valid JSONL", () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    const file = join(TEST_DIR, "reflections.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ task_description: "Task A", timestamp: "2026-01-01", effort_level: "standard" }),
        JSON.stringify({ task_description: "Task B", timestamp: "2026-01-02", effort_level: "fast" }),
      ].join("\n"),
    );

    const result = loadReflections(file);
    expect(result).toHaveLength(2);
    expect(result[0].task_description).toBe("Task A");

    rmSync(TEST_DIR, { recursive: true });
  });

  test("returns empty for missing file", () => {
    expect(loadReflections("/tmp/nonexistent-" + Date.now())).toHaveLength(0);
  });

  test("skips entries without task_description", () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    const file = join(TEST_DIR, "reflections.jsonl");
    writeFileSync(file, JSON.stringify({ other: "field" }));

    const result = loadReflections(file);
    expect(result).toHaveLength(0);

    rmSync(TEST_DIR, { recursive: true });
  });
});
