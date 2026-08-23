import { describe, expect, test } from "bun:test";
import {
  detectContradictions,
  filterContradictions,
  type ContradictionResult,
} from "../../src/graph/contradictions";

describe("detectContradictions", () => {
  test("detects direct contradiction: always vs never on same topic", () => {
    const rulesA = [
      { id: "rule-make", text: "Always use make for deploys" },
    ];
    const rulesB = [
      { id: "rule-docker", text: "Never use make, prefer docker compose for deploys" },
    ];

    const results = detectContradictions(rulesA, rulesB);
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("direct");
    expect(results[0].ruleA).toBe("rule-make");
    expect(results[0].ruleB).toBe("rule-docker");
  });

  test("does NOT flag complementary rules as contradictions", () => {
    const rulesA = [
      { id: "rule-test", text: "Test before production deployment" },
    ];
    const rulesB = [
      { id: "rule-verify", text: "Verify before deploying to production" },
    ];

    const results = detectContradictions(rulesA, rulesB);
    const direct = results.filter(r => r.type === "direct");
    expect(direct.length).toBe(0);
  });

  test("detects mock vs no-mock contradiction", () => {
    const rulesA = [
      { id: "rule-mock", text: "Use mocks for database tests" },
    ];
    const rulesB = [
      { id: "rule-no-mock", text: "Don't mock the database in tests" },
    ];

    const results = detectContradictions(rulesA, rulesB);
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("direct");
  });

  test("returns empty for unrelated rules", () => {
    const rulesA = [
      { id: "rule-lint", text: "Run linting on every commit" },
    ];
    const rulesB = [
      { id: "rule-backup", text: "Back up the database every night" },
    ];

    const results = detectContradictions(rulesA, rulesB);
    expect(results.length).toBe(0);
  });

  test("handles multiple rules, finding only actual contradictions", () => {
    const rulesA = [
      { id: "rule-1", text: "Always write tests before code" },
      { id: "rule-2", text: "Use TypeScript for all new projects" },
    ];
    const rulesB = [
      { id: "rule-3", text: "Never write tests before code, write them after" },
      { id: "rule-4", text: "Prefer Python for new data projects" },
    ];

    const results = detectContradictions(rulesA, rulesB);
    const direct = results.filter(r => r.type === "direct");
    expect(direct.length).toBeGreaterThanOrEqual(1);
    const testContradiction = direct.find(
      r => (r.ruleA === "rule-1" && r.ruleB === "rule-3") ||
           (r.ruleA === "rule-3" && r.ruleB === "rule-1"),
    );
    expect(testContradiction).toBeDefined();
  });

  test("prefer/avoid detected as opposing directives", () => {
    const rulesA = [
      { id: "rule-prefer", text: "Prefer using bun for JavaScript projects" },
    ];
    const rulesB = [
      { id: "rule-avoid", text: "Avoid using bun for JavaScript projects" },
    ];

    const results = detectContradictions(rulesA, rulesB);
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("direct");
  });

  test("do vs don't detected as opposing directives", () => {
    const rulesA = [
      { id: "rule-do", text: "Do commit tests with implementation code" },
    ];
    const rulesB = [
      { id: "rule-dont", text: "Don't commit tests with implementation code" },
    ];

    const results = detectContradictions(rulesA, rulesB);
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("direct");
  });

  test("start/stop detected as opposing directives", () => {
    const rulesA = [
      { id: "rule-start", text: "Start every session with a context refresh" },
    ];
    const rulesB = [
      { id: "rule-stop", text: "Stop running context refresh at session start" },
    ];

    const results = detectContradictions(rulesA, rulesB);
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("direct");
  });

  test("resolution favors rule with higher correlationScore", () => {
    const rulesA = [
      { id: "rule-a", text: "Always use make for deploys", correlationScore: 0.9 },
    ];
    const rulesB = [
      { id: "rule-b", text: "Never use make for deploys", correlationScore: 0.3 },
    ];

    const results = detectContradictions(rulesA, rulesB);
    expect(results.length).toBe(1);
    expect(results[0].resolution).toBe("keep-a");
  });

  test("resolution favors rule with more recent timestamp when scores equal", () => {
    const rulesA = [
      { id: "rule-old", text: "Always use make for deploys", correlationScore: 0.5, created: "2026-01-01T00:00:00Z" },
    ];
    const rulesB = [
      { id: "rule-new", text: "Never use make for deploys", correlationScore: 0.5, created: "2026-08-01T00:00:00Z" },
    ];

    const results = detectContradictions(rulesA, rulesB);
    expect(results.length).toBe(1);
    expect(results[0].resolution).toBe("keep-b");
  });

  test("cross-compares all pairs across both sets", () => {
    const rulesA = [
      { id: "a1", text: "Always deploy with make" },
      { id: "a2", text: "Always write unit tests" },
    ];
    const rulesB = [
      { id: "b1", text: "Never deploy with make" },
      { id: "b2", text: "Never write unit tests" },
    ];

    const results = detectContradictions(rulesA, rulesB);
    expect(results.length).toBe(2);
  });
});

describe("filterContradictions", () => {
  test("removes losing rules from merged markdown", () => {
    const merged = [
      "# Graph Context — testing",
      "*Generated: 2026-08-22T00:00:00Z | 3 context rules*",
      "",
      "## Context Rules (correlation-ranked)",
      "",
      "- **rule-keep** [testing] (score: 0.90)",
      "  Always use make for deploys",
      "",
      "- **rule-lose** [testing] (score: 0.30)",
      "  Never use make for deploys",
      "",
      "- **rule-unrelated** [config] (score: 0.70)",
      "  Back up database nightly",
      "",
    ].join("\n");

    const filtered = filterContradictions(merged);
    expect(filtered).toContain("rule-keep");
    expect(filtered).not.toContain("rule-lose");
    expect(filtered).toContain("rule-unrelated");
  });

  test("preserves all rules when no contradictions exist", () => {
    const merged = [
      "# Graph Context — testing",
      "*Generated: 2026-08-22T00:00:00Z | 2 context rules*",
      "",
      "## Context Rules (correlation-ranked)",
      "",
      "- **rule-a** [testing] (score: 0.90)",
      "  Write tests before code",
      "",
      "- **rule-b** [config] (score: 0.70)",
      "  Back up database nightly",
      "",
    ].join("\n");

    const filtered = filterContradictions(merged);
    expect(filtered).toContain("rule-a");
    expect(filtered).toContain("rule-b");
  });

  test("handles empty markdown gracefully", () => {
    const filtered = filterContradictions("");
    expect(filtered).toBe("");
  });
});
