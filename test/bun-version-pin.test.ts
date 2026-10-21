/**
 * Every workflow in this repo installs the Bun named by `.bun-version` (#318).
 *
 * `.github/workflows/ci.yml` and `gates.yml` carried `bun-version: "latest"`,
 * which is the opposite of a pin: the runtime executing a given commit can
 * change between two runs of it, with nothing in the diff to explain a new
 * failure, and re-running a red job is also a Bun upgrade.
 *
 * It already cost a red. PR #313's `test` job failed on exactly one case —
 * `AC-1: the preloaded warm-up spawned fallow once` — asserting a spawn count
 * of 1 and getting 3, because the reading depends on when bun chooses to
 * import a test file relative to running the ones before it:
 *
 * | bun | reading |
 * |---|---|
 * | 1.3.14 (local) | 1 |
 * | 1.4.3 (CI, resolved from `latest`) | 3 |
 *
 * That test was fixed to be scheduling-independent. This file is about the
 * exposure underneath it, which was unchanged: nothing in the repository said
 * which runtime a given commit runs on.
 *
 * ## Why a test and not just the edit
 *
 * The declaration is four lines of YAML, and nothing holds them. A new
 * workflow copy-pasted from an old one, or a hand-edit to a managed file,
 * puts `latest` back with no signal. `ci.yml` and `gates.yml` are generated
 * by rungate and would be restored by a re-scaffold; `publish.yml` and
 * `doc-check.yml` are this repo's own and nothing but this file is watching
 * them.
 *
 * ## Why the reading is parsed, not grepped
 *
 * A grep for `bun-version: "latest"` is a detector narrower than what it
 * detects — unquoted `latest`, `'latest'` and a flow mapping all defeat it,
 * and all three are valid workflow syntax GitHub honours. So the property is
 * asserted against parsed steps, and the raw text is used for one thing: the
 * number of `oven-sh/setup-bun@` occurrences must equal the number of steps
 * the parse found, which catches a parse that silently stopped seeing steps.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const WORKFLOW_DIR = join(ROOT, ".github", "workflows");
const BUN_VERSION_FILE = ".bun-version";

/** Tags that resolve to whatever shipped today. Declaring one is not a pin. */
const MOVING_TAGS = ["latest", "canary"];

interface SetupBunStep {
  file: string;
  job: string;
  /** A version literal spelled in the workflow. */
  version: string | null;
  /** A pointer at the declaration file. */
  versionFile: string | null;
}

function setupBunSteps(): SetupBunStep[] {
  const files = readdirSync(WORKFLOW_DIR)
    .filter(f => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();
  if (files.length === 0) throw new Error(`${WORKFLOW_DIR} holds no workflow files`);

  const found: SetupBunStep[] = [];
  for (const file of files) {
    const text = readFileSync(join(WORKFLOW_DIR, file), "utf-8");
    const doc = Bun.YAML.parse(text) as any;
    const jobs = doc?.jobs;
    if (!jobs || typeof jobs !== "object") {
      throw new Error(`${file} has no jobs: block, so no step in it can be read`);
    }
    let seen = 0;
    for (const [job, body] of Object.entries<any>(jobs)) {
      for (const step of (body?.steps ?? []) as any[]) {
        if (typeof step?.uses !== "string" || !step.uses.startsWith("oven-sh/setup-bun@")) continue;
        seen++;
        const w = (step.with ?? {}) as Record<string, unknown>;
        found.push({
          file,
          job,
          version: w["bun-version"] === undefined ? null : String(w["bun-version"]),
          versionFile: w["bun-version-file"] === undefined ? null : String(w["bun-version-file"]),
        });
      }
    }
    // The instrument check. A parse that stopped seeing steps reads exactly
    // like a directory with nothing to find.
    const raw = (text.match(/oven-sh\/setup-bun@/g) ?? []).length;
    if (raw !== seen) {
      throw new Error(`${file} names oven-sh/setup-bun ${raw} time(s) but the parse found ${seen}`);
    }
  }
  return found;
}

describe("#318: the Bun runtime is pinned, in one position", () => {
  test("every setup-bun step is read, and the scan says how many it read", () => {
    // The coverage assertion, first and on its own. Every case below is
    // satisfied by an empty reading — "no step names a moving tag" is true of
    // a directory with no setup-bun steps in it — so the reading is
    // established before any claim is made about what it contains.
    const steps = setupBunSteps();
    expect(steps.length, "no workflow in this repo installs bun").toBeGreaterThanOrEqual(4);
    expect([...new Set(steps.map(s => s.file))].sort()).toEqual([
      "ci.yml",
      "doc-check.yml",
      "gates.yml",
      "publish.yml",
    ]);
  });

  test(`${BUN_VERSION_FILE} exists and names an exact version`, () => {
    const path = join(ROOT, BUN_VERSION_FILE);
    expect(existsSync(path), `${BUN_VERSION_FILE} is the one position CI reads, and it is absent`).toBe(true);
    const declared = readFileSync(path, "utf-8").trim();
    expect(declared, `${BUN_VERSION_FILE} is empty, so it declares nothing`).not.toBe("");
    expect(
      MOVING_TAGS.includes(declared),
      `${BUN_VERSION_FILE} says ${declared}, which resolves to whatever shipped today`,
    ).toBe(false);
  });

  test("no step resolves bun from a moving tag", () => {
    for (const step of setupBunSteps()) {
      expect(
        step.version === null || !MOVING_TAGS.includes(step.version),
        `${step.file} (${step.job}) installs the moving tag ${JSON.stringify(step.version)} — ` +
          `re-running that job is also a Bun upgrade`,
      ).toBe(true);
    }
  });

  test("no workflow spells a version of its own — every step reads the declaration", () => {
    // The stronger property, and the one that keeps the pin honest over time:
    // a literal that merely AGREES with the file today is a second position,
    // and a second position is a thing that drifts.
    for (const step of setupBunSteps()) {
      expect(step.version, `${step.file} (${step.job}) spells its own Bun version`).toBeNull();
      expect(
        step.versionFile,
        `${step.file} (${step.job}) resolves bun from nothing at all`,
      ).toBe(BUN_VERSION_FILE);
    }
  });

  test("the file every step points at is the file this repo has", () => {
    // Without this the case above is satisfied by four workflows agreeing to
    // read a path that does not exist, which is a job that fails rather than
    // a project that is pinned — and they fail identically either way.
    for (const step of setupBunSteps()) {
      // Asserted rather than asserted-with-`!`: a step that points at nothing
      // would otherwise throw out of `join`, which reads as a broken test
      // rather than as the unpinned workflow it is.
      expect(
        typeof step.versionFile,
        `${step.file} (${step.job}) points CI at no declaration file at all`,
      ).toBe("string");
      expect(
        existsSync(join(ROOT, step.versionFile as string)),
        `${step.file} (${step.job}) points CI at ${step.versionFile}, which is not in this tree`,
      ).toBe(true);
    }
  });

  test("ci.bunVersion agrees with the file, so the two declarations cannot drift", () => {
    // rungate reads `.bun-version` first and `ci.bunVersion` second. Both
    // exist here, so they are compared: a config left on `latest` would be
    // the stale position a future re-scaffold reads if the file were ever
    // removed.
    const config = JSON.parse(readFileSync(join(ROOT, ".claude", "rungate", "config.json"), "utf-8"));
    const declared = readFileSync(join(ROOT, BUN_VERSION_FILE), "utf-8").trim();
    expect(
      config?.ci?.bunVersion,
      `ci.bunVersion and ${BUN_VERSION_FILE} name two different runtimes`,
    ).toBe(declared);
  });
});
