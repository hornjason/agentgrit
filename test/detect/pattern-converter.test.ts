import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  parseNewGapPatterns,
  getExistingFeedbackSlugs,
  writeFeedbackMemory,
  convertPatternReports,
  readProcessedReports,
  saveProcessedReports,
  type NewGapPattern,
} from "../../src/detect/pattern-converter";

const TEST_DIR = "/tmp/agentgrit-pattern-converter-test-" + process.pid;
const REPORTS_DIR = join(TEST_DIR, "reports");
const MEMORY_DIR = join(TEST_DIR, "memory");
const STATE_PATH = join(TEST_DIR, "state", "processed-reports.json");

const SAMPLE_REPORT = `# Pattern Synthesis Report

### Pattern 1: Scope Drift
**Common theme:** Agent expands scope beyond the stated request
**Existing feedback memory:** NONE — NEW GAP
**Suggested rule:** Before implementing, restate the exact scope of the request and confirm.

### Pattern 2: Already Handled
**Common theme:** Duplicate work already covered
**Existing feedback memory:** feedback_duplicate-work.md
**Suggested rule:** Check existing code before writing new.

### Pattern 3: Missing Tests
**Common theme:** Code ships without corresponding test coverage
**Existing feedback memory:** NONE — NEW GAP
**Suggested rule:** Every code change must include a test that fails without the change. No exceptions for "simple" changes.
`;

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(REPORTS_DIR, { recursive: true });
  mkdirSync(MEMORY_DIR, { recursive: true });
});

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("parseNewGapPatterns", () => {
  test("extracts NEW GAP patterns only", () => {
    const patterns = parseNewGapPatterns(SAMPLE_REPORT, "report.md");
    expect(patterns).toHaveLength(2);
    expect(patterns[0].name).toBe("Scope Drift");
    expect(patterns[1].name).toBe("Missing Tests");
  });

  test("generates correct slugs", () => {
    const patterns = parseNewGapPatterns(SAMPLE_REPORT, "report.md");
    expect(patterns[0].slug).toBe("scope-drift");
    expect(patterns[1].slug).toBe("missing-tests");
  });

  test("extracts common theme and suggested rule", () => {
    const patterns = parseNewGapPatterns(SAMPLE_REPORT, "report.md");
    expect(patterns[0].commonTheme).toContain("scope beyond");
    expect(patterns[0].suggestedRule).toContain("restate the exact scope");
  });

  test("returns empty for report with no NEW GAP patterns", () => {
    const noGaps = `### Pattern 1: Already Handled
**Common theme:** test
**Existing feedback memory:** feedback_test.md
**Suggested rule:** test rule`;

    const patterns = parseNewGapPatterns(noGaps, "report.md");
    expect(patterns).toHaveLength(0);
  });
});

describe("getExistingFeedbackSlugs", () => {
  test("returns slugs from existing feedback files", () => {
    writeFileSync(join(MEMORY_DIR, "feedback_test-slug.md"), "content");
    writeFileSync(join(MEMORY_DIR, "feedback_another.md"), "content");
    writeFileSync(join(MEMORY_DIR, "not-feedback.md"), "content");

    const slugs = getExistingFeedbackSlugs(MEMORY_DIR);
    expect(slugs.size).toBe(2);
    expect(slugs.has("test-slug")).toBe(true);
    expect(slugs.has("another")).toBe(true);
  });

  test("returns empty set for nonexistent directory", () => {
    const slugs = getExistingFeedbackSlugs("/tmp/nonexistent-" + Date.now());
    expect(slugs.size).toBe(0);
  });
});

describe("writeFeedbackMemory", () => {
  test("creates feedback file with correct frontmatter", () => {
    const pattern: NewGapPattern = {
      name: "Test Pattern",
      slug: "test-pattern",
      commonTheme: "A recurring issue with testing",
      suggestedRule: "Always write tests first. Then implement.",
      reportFile: "report.md",
    };

    const filename = writeFeedbackMemory(pattern, MEMORY_DIR);
    expect(filename).toBe("feedback_test-pattern.md");

    const content = readFileSync(join(MEMORY_DIR, filename), "utf-8");
    expect(content).toContain("name: test-pattern");
    expect(content).toContain("type: feedback");
    expect(content).toContain("Always write tests first");
    expect(content).toContain("**Why:**");
    expect(content).toContain("**How to apply:**");
  });
});

describe("processedReports state", () => {
  test("reads empty state for missing file", () => {
    const state = readProcessedReports("/tmp/nonexistent-" + Date.now());
    expect(state).toEqual({});
  });

  test("roundtrips state correctly", () => {
    const state = { "report.md": ["slug-1", "slug-2"] };
    saveProcessedReports(STATE_PATH, state);
    const loaded = readProcessedReports(STATE_PATH);
    expect(loaded).toEqual(state);
  });
});

describe("convertPatternReports", () => {
  test("converts NEW GAP patterns to feedback files", () => {
    writeFileSync(join(REPORTS_DIR, "report.md"), SAMPLE_REPORT);

    const result = convertPatternReports(REPORTS_DIR, MEMORY_DIR, STATE_PATH);
    expect(result.found).toBe(2);
    expect(result.written).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.filesCreated).toHaveLength(2);

    expect(existsSync(join(MEMORY_DIR, "feedback_scope-drift.md"))).toBe(true);
    expect(existsSync(join(MEMORY_DIR, "feedback_missing-tests.md"))).toBe(true);
  });

  test("skips already-processed patterns on second run", () => {
    writeFileSync(join(REPORTS_DIR, "report.md"), SAMPLE_REPORT);

    convertPatternReports(REPORTS_DIR, MEMORY_DIR, STATE_PATH);
    const result = convertPatternReports(REPORTS_DIR, MEMORY_DIR, STATE_PATH);

    expect(result.found).toBe(2);
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(2);
  });

  test("skips patterns with existing feedback files", () => {
    writeFileSync(join(MEMORY_DIR, "feedback_scope-drift.md"), "existing");
    writeFileSync(join(REPORTS_DIR, "report.md"), SAMPLE_REPORT);

    const result = convertPatternReports(REPORTS_DIR, MEMORY_DIR, STATE_PATH);
    expect(result.written).toBe(1);
    expect(result.skipped).toBe(1);
  });

  test("returns zeros for nonexistent reports directory", () => {
    const result = convertPatternReports(
      "/tmp/nonexistent-" + Date.now(),
      MEMORY_DIR,
      STATE_PATH,
    );
    expect(result.found).toBe(0);
    expect(result.written).toBe(0);
  });
});
