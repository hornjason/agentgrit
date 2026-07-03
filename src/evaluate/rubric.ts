import { readFileSync, existsSync } from "fs";
import type { Dimension, RubricConfig } from "../adapters/types";
import { SCHEMA_VERSION } from "../adapters/types";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateRubric(r: RubricConfig): ValidationResult {
  const errors: string[] = [];

  if (!r.version) errors.push("missing version");
  if (typeof r.schemaVersion !== "number") errors.push("missing or invalid schemaVersion");
  if (!Array.isArray(r.dimensions)) {
    errors.push("dimensions must be an array");
    return { valid: false, errors };
  }
  if (r.dimensions.length === 0) errors.push("dimensions must not be empty");

  let totalWeight = 0;
  const names = new Set<string>();

  for (let i = 0; i < r.dimensions.length; i++) {
    const d = r.dimensions[i];
    const prefix = `dimensions[${i}]`;

    if (!d.name || typeof d.name !== "string") errors.push(`${prefix}: missing or invalid name`);
    if (typeof d.weight !== "number" || d.weight <= 0 || d.weight > 1) {
      errors.push(`${prefix}: weight must be a number between 0 (exclusive) and 1 (inclusive)`);
    }
    if (!d.rubric || typeof d.rubric !== "string") errors.push(`${prefix}: missing or invalid rubric`);

    if (d.name && names.has(d.name)) errors.push(`${prefix}: duplicate dimension name "${d.name}"`);
    if (d.name) names.add(d.name);

    totalWeight += d.weight ?? 0;
  }

  const weightDiff = Math.abs(totalWeight - 1.0);
  if (weightDiff > 0.01) errors.push(`dimension weights sum to ${totalWeight.toFixed(3)}, expected ~1.0`);

  if (!r.judgeModel || typeof r.judgeModel !== "string") errors.push("missing or invalid judgeModel");

  return { valid: errors.length === 0, errors };
}

export function loadRubric(path: string): RubricConfig {
  if (!existsSync(path)) throw new Error(`rubric file not found: ${path}`);
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as RubricConfig;
  const result = validateRubric(parsed);
  if (!result.valid) throw new Error(`invalid rubric at ${path}: ${result.errors.join("; ")}`);
  return parsed;
}

export function composeRubrics(...rubrics: RubricConfig[]): RubricConfig {
  if (rubrics.length === 0) throw new Error("at least one rubric required");

  const merged = new Map<string, Dimension>();

  for (const rubric of rubrics) {
    for (const dim of rubric.dimensions) {
      merged.set(dim.name, { ...dim });
    }
  }

  const dimensions = [...merged.values()];

  const totalWeight = dimensions.reduce((s, d) => s + d.weight, 0);
  if (totalWeight > 0) {
    for (const d of dimensions) {
      d.weight = d.weight / totalWeight;
    }
  }

  const last = rubrics[rubrics.length - 1];
  return {
    version: last.version,
    schemaVersion: last.schemaVersion ?? SCHEMA_VERSION,
    dimensions,
    judgeModel: last.judgeModel,
  };
}
