import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// Use a temp dir to avoid touching real state
const TEST_DIR = join(homedir(), ".agentgrit-dashboard-test");
const DASHBOARD_PATH = join(TEST_DIR, "dashboard.html");

// We test the generateDashboardHtml function directly
// Import after setting env
describe("dashboard command", () => {
  beforeAll(() => {
    // Create minimal file structure the dashboard reads
    mkdirSync(join(TEST_DIR, "signals"), { recursive: true });
    mkdirSync(join(TEST_DIR, "state"), { recursive: true });

    // ratings.jsonl — 3 lines
    writeFileSync(
      join(TEST_DIR, "signals", "ratings.jsonl"),
      '{"rating":7,"timestamp":"2026-08-01T12:00:00Z"}\n{"rating":8,"timestamp":"2026-08-02T12:00:00Z"}\n{"rating":9,"timestamp":"2026-08-03T12:00:00Z"}\n'
    );

    // rule-stats.json — 2 rules
    writeFileSync(
      join(TEST_DIR, "state", "rule-stats.json"),
      JSON.stringify([
        { ruleId: "rule-a", injectionCount: 10, avgCorrelatedRating: 7.5, noisePenalty: 0 },
        { ruleId: "rule-b", injectionCount: 5, avgCorrelatedRating: 4.2, noisePenalty: 0.3 },
      ])
    );

    // session-context.json
    writeFileSync(
      join(TEST_DIR, "state", "session-context.json"),
      JSON.stringify({ rulesInjectedCount: 12, domains: ["testing"] })
    );
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("generateDashboardHtml returns valid HTML with all sections", async () => {
    const { generateDashboardHtml } = await import("../../bin/commands/dashboard");

    const html = await generateDashboardHtml({ noOpen: true, outputPath: DASHBOARD_PATH });

    // AC-1: HTML contains pipeline file entries
    expect(html).toContain("ratings.jsonl");
    expect(html).toContain("rule-stats.json");
    expect(html).toContain("session-context.json");
    expect(html).toContain("eviction-candidates.json");
    expect(html).toContain("GRAPH-CONTEXT.md");
    expect(html).toContain("patterns.json");

    // AC-1: Status badges present
    const statusMatches = html.match(/GREEN|YELLOW|RED/g);
    expect(statusMatches).toBeTruthy();
    expect(statusMatches!.length).toBeGreaterThanOrEqual(6);

    // AC-2: Phase section
    expect(html).toContain("Phase 1");
    expect(html).toContain("Phase 8");

    // AC-4: GitHub issue links (may be empty if no gh CLI, but structure present)
    expect(html).toContain("Open Issues");
  });

  test("getStatus returns correct staleness", async () => {
    const { getStatus } = await import("../../bin/commands/dashboard");

    const now = Date.now();
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;
    const fourDaysAgo = now - 4 * 24 * 60 * 60 * 1000;
    const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;

    expect(getStatus(twoHoursAgo, 3, 7)).toBe("GREEN");
    expect(getStatus(fourDaysAgo, 3, 7)).toBe("YELLOW");
    expect(getStatus(tenDaysAgo, 3, 7)).toBe("RED");
  });

  test("timeAgo returns human readable strings", async () => {
    const { timeAgo } = await import("../../bin/commands/dashboard");

    const now = Date.now();
    expect(timeAgo(now - 30 * 1000)).toBe("just now");
    expect(timeAgo(now - 5 * 60 * 1000)).toBe("5 minutes ago");
    expect(timeAgo(now - 3 * 60 * 60 * 1000)).toBe("3 hours ago");
    expect(timeAgo(now - 2 * 24 * 60 * 60 * 1000)).toBe("2 days ago");
  });

  test("dashboard HTML is self-contained (no external deps)", async () => {
    const { generateDashboardHtml } = await import("../../bin/commands/dashboard");
    const html = await generateDashboardHtml({ noOpen: true, outputPath: DASHBOARD_PATH });

    // No external CSS/JS links
    expect(html).not.toMatch(/<link[^>]+href="https?:/);
    expect(html).not.toMatch(/<script[^>]+src="https?:/);

    // Has inline styles
    expect(html).toContain("<style>");
    expect(html).toContain("#1a1a2e");
  });
});
