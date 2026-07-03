import { describe, test, expect } from "bun:test";
import { checkBudget } from "../../src/promote/budget";
import { Tier } from "../../src/adapters/types";

describe("checkBudget", () => {
  test("returns OK when well under cap", () => {
    const status = checkBudget(Tier.Global, 10);
    expect(status.level).toBe("OK");
    expect(status.remaining).toBe(15);
  });

  test("returns OK at exactly 20 (default cap 25, warning at 21+)", () => {
    const status = checkBudget(Tier.Global, 20);
    expect(status.level).toBe("OK");
    expect(status.remaining).toBe(5);
  });

  test("returns WARNING when within 5 of cap", () => {
    const status = checkBudget(Tier.Global, 21);
    expect(status.level).toBe("WARNING");
    expect(status.remaining).toBe(4);
  });

  test("returns OK at exactly cap boundary (25)", () => {
    const status = checkBudget(Tier.Global, 25);
    expect(status.level).toBe("WARNING");
    expect(status.remaining).toBe(0);
  });

  test("returns OVER_BUDGET when exceeding cap", () => {
    const status = checkBudget(Tier.Global, 26);
    expect(status.level).toBe("OVER_BUDGET");
    expect(status.remaining).toBe(-1);
  });

  test("Graph tier is always OK (unlimited)", () => {
    const status = checkBudget(Tier.Graph, 500);
    expect(status.level).toBe("OK");
    expect(status.remaining).toBe(Infinity);
  });

  test("Project tier uses same cap as Global", () => {
    const status = checkBudget(Tier.Project, 24);
    expect(status.level).toBe("WARNING");
  });

  test("custom cap overrides default", () => {
    const status = checkBudget(Tier.Global, 8, 10);
    expect(status.level).toBe("WARNING");
    expect(status.cap).toBe(10);
    expect(status.remaining).toBe(2);
  });

  test("custom cap of 10 returns OVER_BUDGET at 11", () => {
    const status = checkBudget(Tier.Global, 11, 10);
    expect(status.level).toBe("OVER_BUDGET");
  });

  test("zero rules is OK", () => {
    const status = checkBudget(Tier.Global, 0);
    expect(status.level).toBe("OK");
    expect(status.remaining).toBe(25);
  });
});
