import {
  captureIterationLearning,
  type IterationLearningInput,
  type IterationLearningResult,
} from "../../src/capture/iteration-learning";

/**
 * `agentgrit iteration-learn` — the LEARN step of an iteration loop calling in
 * from wherever that loop runs (#253).
 *
 * The caller is a loop in another process, in another directory, that has
 * three strings and an artifact type. It gets back the routed tier on stdout
 * and an artifact on disk. Nothing is written to the rules store: the routing
 * is shadow, the same display-only treatment `inbox` gives a computed route.
 */

const REQUIRED = ["gap", "root-cause", "mechanical-fix", "artifact-type"] as const;

const USAGE = `Usage: agentgrit iteration-learn --gap <text> --root-cause <text> \\
                                  --mechanical-fix <text> --artifact-type <text>
                                  [--session <id>] [--project <name>]... [--json]

Records one iteration-loop learning: classified, routed in SHADOW mode, and
written to the learning directory. No rule is created or promoted.`;

/** Last occurrence of `--name value` or `--name=value`. */
function flag(args: string[], name: string): string | undefined {
  const values = flagAll(args, name);
  return values.length > 0 ? values[values.length - 1] : undefined;
}

/** Every occurrence, so `--project` can be repeated for a multi-project gap. */
function flagAll(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === `--${name}`) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) out.push(next);
    } else if (arg.startsWith(`--${name}=`)) {
      out.push(arg.slice(name.length + 3));
    }
  }
  return out;
}

export async function iterationLearnCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }

  const missing = REQUIRED.filter((name) => !flag(args, name));
  if (missing.length > 0) {
    // Named, not counted: a caller that has to re-read the usage block to
    // learn which of four strings it forgot will guess.
    process.stderr.write(
      `agentgrit iteration-learn: missing required flag(s): ` +
        `${missing.map((m) => `--${m}`).join(", ")}\n\n${USAGE}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const input: IterationLearningInput = {
    gap: flag(args, "gap")!,
    rootCause: flag(args, "root-cause")!,
    mechanicalFix: flag(args, "mechanical-fix")!,
    artifactType: flag(args, "artifact-type")!,
    sessionId: flag(args, "session"),
    projects: flagAll(args, "project"),
  };

  let result: IterationLearningResult;
  try {
    result = captureIterationLearning(input);
  } catch (err) {
    process.stderr.write(`agentgrit iteration-learn: ${(err as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify(result));
    return;
  }

  console.log("\nagentgrit iteration-learn (shadow)\n");
  console.log(`  Tier:     ${result.route.tier}`);
  console.log(`  Reason:   ${result.route.rationale}`);
  console.log(`  Category: ${result.learning.category}`);
  console.log(`  Artifact: ${result.files[0] ?? "(an identical learning was already recorded)"}`);
  console.log(`\n  Shadow mode — the tier is recorded for calibration, no rule was written.\n`);
}
