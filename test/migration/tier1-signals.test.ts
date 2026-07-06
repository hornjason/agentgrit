import { describe, test, expect } from "bun:test";
import { existsSync } from "fs";
import { readSignals } from "../../src/adapters/jsonl";
import { loadConfig, resolveSignalDir, resolveSignalFile } from "../../src/adapters/paths";
import type { RatingSignal, CorrectionSignal } from "../../src/adapters/types";

const signalDir = resolveSignalDir();
const hasSignals = existsSync(signalDir);

describe("Tier 1: Core Signal Reading", () => {
  test("T1 — Read PAI ratings.jsonl", async () => {
    if (!hasSignals) return expect().pass();
    const file = resolveSignalFile(signalDir, "ratings.jsonl");
    const signals = await readSignals(file);
    expect(signals.length).toBeGreaterThanOrEqual(621);
  });

  test("T2 — Read PAI correction-captures.jsonl via alias", async () => {
    if (!hasSignals) return expect().pass();
    const file = resolveSignalFile(signalDir, "corrections.jsonl");
    expect(existsSync(file)).toBe(true);
    const signals = await readSignals(file);
    expect(signals.length).toBeGreaterThanOrEqual(1072);
  });

  test("T3 — Read PAI skill-invocations.jsonl via alias", async () => {
    if (!hasSignals) return expect().pass();
    const file = resolveSignalFile(signalDir, "skills.jsonl");
    expect(existsSync(file)).toBe(true);
    const signals = await readSignals(file);
    expect(signals.length).toBeGreaterThanOrEqual(935);
  });

  test("T4 — Read PAI tool-audit.jsonl", async () => {
    if (!hasSignals) return expect().pass();
    const file = resolveSignalFile(signalDir, "tool-audit.jsonl");
    const signals = await readSignals(file);
    expect(signals.length).toBeGreaterThanOrEqual(156000);
  });

  test("T5 — Parse rating dimensions from real PAI entry", async () => {
    if (!hasSignals) return expect().pass();
    const file = resolveSignalFile(signalDir, "ratings.jsonl");
    const signals = await readSignals(file);
    expect(signals.length).toBeGreaterThan(0);

    const rating = signals[0] as RatingSignal;
    expect(typeof rating.rating).toBe("number");
    expect(rating.rating).toBeGreaterThanOrEqual(1);
    expect(rating.rating).toBeLessThanOrEqual(10);
    expect(typeof rating.session_id).toBe("string");
    expect(typeof rating.timestamp).toBe("string");
    expect(["explicit", "implicit"]).toContain(rating.source);
  });

  test("T6 — Parse correction from real PAI entry", async () => {
    if (!hasSignals) return expect().pass();
    const file = resolveSignalFile(signalDir, "corrections.jsonl");
    const signals = await readSignals(file);
    expect(signals.length).toBeGreaterThan(0);

    const correction = signals[0] as CorrectionSignal;
    expect(typeof correction.correction_phrase).toBe("string");
    expect(correction.correction_phrase.length).toBeGreaterThan(0);
    expect(typeof correction.context).toBe("string");
    expect(correction.context.length).toBeGreaterThan(0);
  });
});
