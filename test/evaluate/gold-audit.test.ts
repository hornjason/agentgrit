import { describe, expect, test } from "bun:test";
import { formatAuditSession, parseAuditFile, type AuditSession, type AuditRule } from "../../src/evaluate/gold-audit";

describe("formatAuditSession", () => {
  test("produces markdown with session header and rules", () => {
    const session: AuditSession = {
      sessionId: "abc123",
      taskDescription: "Fix the broken deploy pipeline",
      domains: ["deployment", "data"],
      rules: [
        { id: "feedback_mac_mini_deploy", text: "Mac Mini deployment requires Dockerfile rebuild", rank: 1 },
        { id: "feedback_scraper_host", text: "Scraper runs on host not hero", rank: 2 },
      ],
    };
    const output = formatAuditSession(session);
    expect(output).toContain("=== Session: abc123 ===");
    expect(output).toContain("Fix the broken deploy pipeline");
    expect(output).toContain("deployment, data");
    expect(output).toContain("feedback_mac_mini_deploy");
    expect(output).toContain("Mac Mini deployment requires Dockerfile rebuild");
    expect(output).toContain("Relevant? [ ]");
    expect(output).toContain("1.");
    expect(output).toContain("2.");
  });

  test("handles session with no rules", () => {
    const session: AuditSession = {
      sessionId: "empty",
      taskDescription: "Short task",
      domains: [],
      rules: [],
    };
    const output = formatAuditSession(session);
    expect(output).toContain("=== Session: empty ===");
    expect(output).toContain("(no rules retrieved)");
  });
});

describe("parseAuditFile", () => {
  test("parses checked and unchecked rules", () => {
    const content = `# Gold Set Audit Report

=== Session: s1 ===
Task: "Deploy the dashboard"
Domains detected: [deployment]

Retrieved rules (top 15):
  1. feedback_deploy_rule
     "Deploy rule description"
     Relevant? [x]

  2. feedback_scraper_rule
     "Scraper rule description"
     Relevant? [ ]

=== Session: s2 ===
Task: "Fix tests"
Domains detected: [verification]

Retrieved rules (top 15):
  3. feedback_test_rule
     "Test rule description"
     Relevant? [x]

  4. feedback_other_rule
     "Other rule description"
     Relevant? [x]
`;

    const sessions = parseAuditFile(content);
    expect(sessions.length).toBe(2);

    expect(sessions[0].sessionId).toBe("s1");
    expect(sessions[0].taskDescription).toBe("Deploy the dashboard");
    expect(sessions[0].relevantRules).toEqual(["feedback_deploy_rule"]);
    expect(sessions[0].excludedRules).toEqual(["feedback_scraper_rule"]);

    expect(sessions[1].sessionId).toBe("s2");
    expect(sessions[1].taskDescription).toBe("Fix tests");
    expect(sessions[1].relevantRules).toEqual(["feedback_test_rule", "feedback_other_rule"]);
    expect(sessions[1].excludedRules).toEqual([]);
  });

  test("handles empty audit file", () => {
    const sessions = parseAuditFile("");
    expect(sessions.length).toBe(0);
  });

  test("handles audit with no checked rules", () => {
    const content = `=== Session: s1 ===
Task: "Do something"
Domains detected: [code]

Retrieved rules (top 15):
  1. rule_a
     "Rule A description"
     Relevant? [ ]
`;
    const sessions = parseAuditFile(content);
    expect(sessions.length).toBe(1);
    expect(sessions[0].relevantRules).toEqual([]);
    expect(sessions[0].excludedRules).toEqual(["rule_a"]);
  });
});
