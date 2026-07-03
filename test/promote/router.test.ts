import { describe, test, expect } from "bun:test";
import { routeRule } from "../../src/promote/router";
import { Tier, type Pattern } from "../../src/adapters/types";

function makePattern(candidateRule?: string): Pattern {
  return {
    id: "p1",
    type: "failure-cluster",
    frequency: 5,
    sessions: ["s1", "s2", "s3"],
    severity: 3,
    candidateRule,
  };
}

describe("routeRule", () => {
  test("single project routes to Project tier", () => {
    const result = routeRule(
      makePattern("Always verify before asserting"),
      ["my-project"],
    );
    expect(result.tier).toBe(Tier.Project);
    expect(result.rationale).toContain("single project");
  });

  test("empty project history routes to Project tier", () => {
    const result = routeRule(makePattern("Some rule"), []);
    expect(result.tier).toBe(Tier.Project);
    expect(result.rationale).toContain("no");
  });

  test("duplicate project names count as single project", () => {
    const result = routeRule(
      makePattern("Check before deploying"),
      ["proj-a", "proj-a", "proj-a"],
    );
    expect(result.tier).toBe(Tier.Project);
  });

  test("multi-project behavioral pattern routes to Global", () => {
    const result = routeRule(
      makePattern("Always verify and validate evidence before asserting claims. Read first, check always."),
      ["proj-a", "proj-b"],
    );
    expect(result.tier).toBe(Tier.Global);
    expect(result.rationale).toContain("behavioral");
  });

  test("multi-project procedural pattern routes to Graph", () => {
    const result = routeRule(
      makePattern("Run deploy after rebuild. Execute the queue and launch workers."),
      ["proj-a", "proj-b"],
    );
    expect(result.tier).toBe(Tier.Graph);
    expect(result.rationale).toContain("procedural");
  });

  test("no candidate rule text defaults to Graph for multi-project", () => {
    const result = routeRule(makePattern(), ["proj-a", "proj-b"]);
    expect(result.tier).toBe(Tier.Graph);
  });

  test("tied scores default to Graph", () => {
    const result = routeRule(
      makePattern("verify and run"),
      ["proj-a", "proj-b"],
    );
    expect(result.tier).toBe(Tier.Graph);
  });
});
