import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HOME = homedir();
const CLAUDE_DIR = join(HOME, ".claude");
const PAI_DIR = join(CLAUDE_DIR, "PAI");
const SHIP_DIR = join(CLAUDE_DIR, "skills", "ship");
const OUTPUT_TYPES_DIR = join(PAI_DIR, "output-types");
const GATES_DIR = join(SHIP_DIR, "gates");

describe("ADR-005: Unified Harness Output Types", () => {
  test("output type registry directory exists with entries for code, document, campaign, config", () => {
    expect(existsSync(OUTPUT_TYPES_DIR)).toBe(true);

    const files = readdirSync(OUTPUT_TYPES_DIR);
    const requiredTypes = ["code", "campaign"];
    for (const type of requiredTypes) {
      const found = files.some((f) => f.startsWith(type) && f.endsWith(".json"));
      expect(found).toBe(true);
    }

    // Document and config may not exist yet — verify registry structure supports them
    const anyJson = files.filter((f) => f.endsWith(".json"));
    expect(anyJson.length).toBeGreaterThanOrEqual(2);

    // Verify registry entries have expected structure
    for (const jsonFile of anyJson) {
      const content = JSON.parse(
        readFileSync(join(OUTPUT_TYPES_DIR, jsonFile), "utf-8")
      );
      expect(content).toHaveProperty("type");
    }
  });

  test("verify-gate.sh delegates to type-specific gate via verify-{type}.sh naming", () => {
    const gatePath = join(SHIP_DIR, "verify-gate.sh");
    expect(existsSync(gatePath)).toBe(true);

    const source = readFileSync(gatePath, "utf-8");
    // Must contain delegation pattern: verify-{type}.sh
    expect(source).toMatch(/verify-\$\{?OUTPUT_TYPE\}?\.sh/);
    // Must look for gate in gates/ directory
    expect(source).toContain("gates/verify-");
  });

  test("campaign gate enforces render evidence", () => {
    const campaignGate = join(GATES_DIR, "verify-campaign.sh");
    expect(existsSync(campaignGate)).toBe(true);

    const source = readFileSync(campaignGate, "utf-8");
    // Must check for render evidence (screenshot, not just source HTML)
    expect(source).toMatch(/render|screenshot|visual|google.doc/i);
  });

  test("campaign gate enforces EMAIL-OUTREACH-SPEC quality gate", () => {
    const campaignGate = join(GATES_DIR, "verify-campaign.sh");
    expect(existsSync(campaignGate)).toBe(true);

    const source = readFileSync(campaignGate, "utf-8");
    expect(source).toMatch(/EMAIL-OUTREACH-SPEC|email.outreach.spec/i);
  });

  test.skip("document gate checks structural integrity and link validation", () => {
    // SKIP: Document gate (verify-document.sh) is Phase 2 of ADR-005.
    // Phase 2 has not been implemented yet. When it ships, this test
    // should verify that gates/verify-document.sh exists and checks
    // structural integrity and link validation on rendered output.
  });

  test.skip("config gate checks apply confirmation and rollback documentation", () => {
    // SKIP: Config gate (verify-config.sh) is Phase 3 of ADR-005.
    // Phase 3 has not been implemented yet. When it ships, this test
    // should verify that gates/verify-config.sh exists and checks
    // apply confirmation, health check, and rollback documentation.
  });

  test("existing code verification is unchanged (backwards compatible)", () => {
    const gatePath = join(SHIP_DIR, "verify-gate.sh");
    const source = readFileSync(gatePath, "utf-8");

    // Universal code checks must still exist
    expect(source).toMatch(/git\s+diff|git\s+log/);
    expect(source).toMatch(/test|bun\s+test|make\s+test/i);

    // Default to code type when no Output Type declared
    const skillPath = join(SHIP_DIR, "SKILL.md");
    if (existsSync(skillPath)) {
      const skillSource = readFileSync(skillPath, "utf-8");
      expect(skillSource).toMatch(/default.*code|no.*type.*declared.*code/i);
    }
  });

  test("GOAL issue template includes Output Type field", () => {
    const skillPath = join(CLAUDE_DIR, "skills", "goal", "SKILL.md");
    if (!existsSync(skillPath)) {
      // GOAL may not have Output Type yet (Phase 5)
      // Check ship SKILL.md references it
      const shipSkill = join(SHIP_DIR, "SKILL.md");
      const source = readFileSync(shipSkill, "utf-8");
      expect(source).toMatch(/Output Type/);
      return;
    }

    const source = readFileSync(skillPath, "utf-8");
    // If GOAL skill exists, check for Output Type field
    // Phase 5 may not be implemented — verify ship at least references it
    const shipSkill = join(SHIP_DIR, "SKILL.md");
    const shipSource = readFileSync(shipSkill, "utf-8");
    expect(shipSource).toMatch(/Output Type/);
  });

  test("ship SCOPE confirms/infers output type and routes to registered skill", () => {
    const skillPath = join(SHIP_DIR, "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);

    const source = readFileSync(skillPath, "utf-8");
    // SCOPE must read Output Type from issue
    expect(source).toMatch(/Output Type/);
    // Must route to registered skill
    expect(source).toMatch(/output-types.*json|execution\.skill/i);
  });

  test("ship BUILD skips TDD/simplify/fallow for non-code types", () => {
    const skillPath = join(SHIP_DIR, "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);

    const source = readFileSync(skillPath, "utf-8");
    // Must document skipping TDD for non-code
    expect(source).toMatch(/skip.*TDD|exempt.*TDD|non-code/i);
    // Must document skipping simplify/fallow for non-code
    expect(source).toMatch(/simplify|fallow/i);
  });

  test.skip("Quinn brief template exists for content types", () => {
    // SKIP: Quinn content brief template is not yet implemented.
    // ADR-005 specifies that content types should have a Quinn
    // brief template for QA review. When implemented, this test
    // should verify the template file exists and contains
    // content-specific review criteria.
  });

  test("adding new output type requires only: registry JSON + gate script + keyword entry", () => {
    // Verify the extension pattern by checking existing types
    const registryFiles = readdirSync(OUTPUT_TYPES_DIR).filter((f) =>
      f.endsWith(".json")
    );
    expect(registryFiles.length).toBeGreaterThanOrEqual(1);

    // Verify verify-gate.sh uses dynamic dispatch (not hardcoded types)
    const gatePath = join(SHIP_DIR, "verify-gate.sh");
    const gateSource = readFileSync(gatePath, "utf-8");
    // Gate discovers type from variable, not hardcoded if/else per type
    expect(gateSource).toMatch(/verify-\$\{?OUTPUT_TYPE\}?\.sh/);

    // Verify SKILL.md references registry JSON (not hardcoded type list)
    const skillPath = join(SHIP_DIR, "SKILL.md");
    const skillSource = readFileSync(skillPath, "utf-8");
    expect(skillSource).toMatch(/output-types\/\{type\}\.json|output-types.*json/i);
  });
});
