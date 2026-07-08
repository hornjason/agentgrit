import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { bm25InferDomains } from "../../src/graph/context";
import { buildIndex } from "../../src/graph/bm25";

const TMP_DIR = join(import.meta.dir, ".tmp-bm25-domains-test");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

function writeRule(id: string, content: string): string {
  const path = join(TMP_DIR, `${id}.md`);
  writeFileSync(path, content, "utf-8");
  return path;
}

describe("bm25InferDomains", () => {
  test("text matching rules returns their domains", () => {
    const files = [
      writeRule("deploy-gate", "run make rebuild before deploying containers"),
      writeRule("verify-first", "always verify endpoints before answering"),
      writeRule("scope-guard", "keep minimal scope for changes"),
    ];
    const index = buildIndex(files);
    const ruleDomains: Record<string, { domains: string[] }> = {
      "deploy-gate": { domains: ["deployment"] },
      "verify-first": { domains: ["verification"] },
      "scope-guard": { domains: ["scope"] },
    };

    const result = bm25InferDomains("deploy containers with make rebuild", index, ruleDomains);
    expect(result).toContain("deployment");
  });

  test("frequency ranking — domain in 3 rules ranks above domain in 1", () => {
    const files = [
      writeRule("rule-a", "deploy containers rebuild make"),
      writeRule("rule-b", "deploy images rebuild pipeline"),
      writeRule("rule-c", "deploy services rebuild cluster"),
      writeRule("rule-d", "security scan vulnerability check"),
    ];
    const index = buildIndex(files);
    const ruleDomains: Record<string, { domains: string[] }> = {
      "rule-a": { domains: ["deployment"] },
      "rule-b": { domains: ["deployment"] },
      "rule-c": { domains: ["deployment"] },
      "rule-d": { domains: ["security"] },
    };

    const result = bm25InferDomains("deploy rebuild containers", index, ruleDomains);
    expect(result[0]).toBe("deployment");
  });

  test("caps at maxDomains", () => {
    const files = [
      writeRule("r1", "deploy containers"),
      writeRule("r2", "verify endpoints"),
      writeRule("r3", "security scan"),
      writeRule("r4", "scope minimal"),
      writeRule("r5", "delegate agent"),
      writeRule("r6", "algorithm phase"),
    ];
    const index = buildIndex(files);
    const ruleDomains: Record<string, { domains: string[] }> = {
      "r1": { domains: ["deployment"] },
      "r2": { domains: ["verification"] },
      "r3": { domains: ["security"] },
      "r4": { domains: ["scope"] },
      "r5": { domains: ["delegation"] },
      "r6": { domains: ["algorithm"] },
    };

    const result = bm25InferDomains(
      "deploy verify security scope delegate algorithm",
      index, ruleDomains, { maxDomains: 3 },
    );
    expect(result.length).toBeLessThanOrEqual(3);
  });

  test("default maxDomains is 4", () => {
    const files = [
      writeRule("r1", "deploy containers rebuild"),
      writeRule("r2", "verify endpoints check"),
      writeRule("r3", "security scan vulnerability"),
      writeRule("r4", "scope minimal focused"),
      writeRule("r5", "delegate agent spawn"),
      writeRule("r6", "algorithm phase iteration"),
    ];
    const index = buildIndex(files);
    const ruleDomains: Record<string, { domains: string[] }> = {
      "r1": { domains: ["deployment"] },
      "r2": { domains: ["verification"] },
      "r3": { domains: ["security"] },
      "r4": { domains: ["scope"] },
      "r5": { domains: ["delegation"] },
      "r6": { domains: ["algorithm"] },
    };

    const result = bm25InferDomains(
      "deploy verify security scope delegate algorithm",
      index, ruleDomains,
    );
    expect(result.length).toBeLessThanOrEqual(4);
  });

  test("fallback to detectDomains when BM25 returns <2 domains", () => {
    const files = [
      writeRule("lonely-rule", "deploy containers"),
    ];
    const index = buildIndex(files);
    const ruleDomains: Record<string, { domains: string[] }> = {
      "lonely-rule": { domains: ["deployment"] },
    };

    // Text that also triggers detectDomains regex for verification
    const result = bm25InferDomains("verify before deploying", index, ruleDomains);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  test("empty index returns detectDomains result", () => {
    const index = buildIndex([]);
    const ruleDomains: Record<string, { domains: string[] }> = {};

    const result = bm25InferDomains("run make rebuild to deploy", index, ruleDomains);
    // detectDomains should catch "make rebuild" and "deploy" → deployment
    expect(result).toContain("deployment");
  });

  test("rules not in ruleDomains mapping are skipped", () => {
    const files = [
      writeRule("mapped-rule", "deploy containers rebuild"),
      writeRule("unmapped-rule", "deploy containers rebuild"),
    ];
    const index = buildIndex(files);
    // Only map one rule
    const ruleDomains: Record<string, { domains: string[] }> = {
      "mapped-rule": { domains: ["deployment"] },
    };

    const result = bm25InferDomains("deploy containers rebuild", index, ruleDomains);
    // Should still work — unmapped rule is skipped, mapped one provides deployment
    // Falls back to detectDomains since only 1 domain from BM25
    expect(result).toContain("deployment");
  });

  test("multi-domain rules contribute all their domains", () => {
    const files = [
      writeRule("multi-rule", "deploy containers and verify endpoints"),
    ];
    const index = buildIndex(files);
    const ruleDomains: Record<string, { domains: string[] }> = {
      "multi-rule": { domains: ["deployment", "verification"] },
    };

    const result = bm25InferDomains("deploy containers verify endpoints", index, ruleDomains);
    expect(result).toContain("deployment");
    expect(result).toContain("verification");
  });

  test("topK option limits number of BM25 results considered", () => {
    const files = Array.from({ length: 20 }, (_, i) =>
      writeRule(`rule-${i}`, `deploy containers rebuild iteration ${i}`),
    );
    const index = buildIndex(files);
    const ruleDomains: Record<string, { domains: string[] }> = {};
    for (let i = 0; i < 20; i++) {
      ruleDomains[`rule-${i}`] = { domains: ["deployment"] };
    }

    const result = bm25InferDomains(
      "deploy containers rebuild",
      index, ruleDomains, { topK: 3 },
    );
    expect(result).toContain("deployment");
  });
});
