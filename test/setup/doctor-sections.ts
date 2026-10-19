/**
 * The exact sections runDoctor emits, in order.
 *
 * Asserted by both test/daemon/doctor.test.ts and test/daemon/daemon.test.ts.
 * Both used to assert `sections.length === 9` and nothing about which nine, so
 * when commit 4925681 wired in checkEvictionAndContext ("HEALTH") they went red
 * with "Expected: 9, Received: 10" — a message naming neither the section that
 * appeared nor the one that was meant to be missing. Asserting the list instead
 * means a dropped, renamed or reordered section says which one.
 *
 * Deliberately a plain module rather than an export from one of the test files:
 * importing a `*.test.ts` from another re-registers its describe blocks in the
 * importer, which silently ran the doctor suite twice.
 */
export const EXPECTED_DOCTOR_SECTIONS = [
  "CAPTURE",
  "SCORING",
  "GRAPH",
  "RULES",
  "SIGNALS",
  "CONFIG",
  "INTEGRITY",
  "DATA INTEGRITY",
  "WIRING",
  "HEALTH",
] as const;
