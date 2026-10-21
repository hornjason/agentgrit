/**
 * `agentgrit learn` — the iteration loop's LEARN step, from the command line.
 *
 * The loop that produces these learnings does not run inside this process and
 * is not written in TypeScript, so the only call site it can use is a command.
 * This file is that seam and holds no logic of its own: it parses flags, calls
 * `captureIterationLearning`, and prints what came back.
 *
 * Shadow, like the function it wraps — the tier is reported, never applied, so
 * there is no `--yes` here. `evict`'s dry-run/`--yes` pair exists because
 * eviction has a real mode to opt into; routing does not have one yet, and a
 * flag that promised one would be a lie the first person to pass it discovers.
 */

import {
  captureIterationLearning,
  type IterationLearningInput,
  type IterationLearningResult,
} from "../../src/capture/iteration-learning";

/** Last occurrence of `--name <value>`, or undefined. */
function flag(args: string[], name: string): string | undefined {
  let found: string | undefined;
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === name) found = args[i + 1];
  }
  return found;
}

/** Every occurrence of `--name <value>`, in order. */
function multiFlag(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === name) values.push(args[i + 1]);
  }
  return values;
}

function usage(): void {
  console.log(
    [
      "",
      "agentgrit learn — record an iteration-loop learning and shadow-route it",
      "",
      "Usage:",
      "  agentgrit learn --gap <text> --root-cause <text> \\",
      "                  --mechanical-fix <text> --artifact-type <text> \\",
      "                  [--project <name> ...] [--session <id>]",
      "",
      "Required:",
      "  --gap             What was missing or went wrong",
      "  --root-cause      Why it happened",
      "  --mechanical-fix  The change that stops it recurring (the router reads this)",
      "  --artifact-type   What the loop was producing (spec, workflow, review…)",
      "",
      "Optional:",
      "  --project         Project the gap was seen in; repeat for each one",
      "  --session         Session id to attribute the learning to",
      "",
      "Routing is shadow mode: the tier is recorded in the learning artifact",
      "for calibration and the rules store is left untouched.",
      "",
    ].join("\n"),
  );
}

export async function learnCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }

  const required = {
    "--gap": flag(args, "--gap"),
    "--root-cause": flag(args, "--root-cause"),
    "--mechanical-fix": flag(args, "--mechanical-fix"),
    "--artifact-type": flag(args, "--artifact-type"),
  };

  // Name every missing flag, not just the first. A caller fixing them one
  // round-trip at a time is the same information delivered four times slower.
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    console.error(`agentgrit learn: missing required flag(s): ${missing.join(", ")}`);
    usage();
    process.exitCode = 1;
    return;
  }

  const input: IterationLearningInput = {
    gap: required["--gap"]!,
    rootCause: required["--root-cause"]!,
    mechanicalFix: required["--mechanical-fix"]!,
    artifactType: required["--artifact-type"]!,
    projectHistory: multiFlag(args, "--project"),
    sessionId: flag(args, "--session"),
  };

  const result: IterationLearningResult | null = captureIterationLearning(input);

  if (!result) {
    console.error("agentgrit learn: nothing significant to capture — no learning written.");
    process.exitCode = 1;
    return;
  }

  console.log("");
  console.log(`  Tier:      ${result.tier}`);
  console.log(`  Rationale: ${result.rationale}`);
  console.log(`  Category:  ${result.learning.category}`);
  console.log(`  Mode:      shadow — recorded for calibration, rules store untouched`);
  for (const file of result.files) console.log(`  Wrote:     ${file}`);
  if (result.files.length === 0) {
    console.log("  Wrote:     (nothing — an identical artifact already exists)");
  }
  console.log("");
}
