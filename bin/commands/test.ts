import { spawnSync } from "child_process";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { stateDir } from "../../src/adapters/paths";

export async function testCommand(args: string[]): Promise<void> {
  const agRoot = join(import.meta.dir, "..", "..");
  const verbose = args.includes("--verbose");

  console.log("\nagentgrit test\n");
  console.log("  Running test suite...");

  const result = spawnSync("bun", ["test", "test/"], {
    cwd: agRoot,
    timeout: 600_000,
    encoding: "utf-8",
  });

  const output = (result.stdout ?? "") + (result.stderr ?? "");

  let totalPass = 0;
  let totalFail = 0;
  for (const m of output.matchAll(/(\d+)\s+pass/g)) totalPass += parseInt(m[1], 10);
  for (const m of output.matchAll(/(\d+)\s+fail/g)) totalFail += parseInt(m[1], 10);

  const cacheDir = stateDir();
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });

  const cache = {
    pass: totalPass,
    fail: totalFail,
    timestamp: new Date().toISOString(),
    duration: result.status === 0 ? "success" : "failure",
  };

  writeFileSync(join(cacheDir, "test-results.json"), JSON.stringify(cache, null, 2), "utf-8");

  console.log(`  ${totalPass} pass, ${totalFail} fail`);
  console.log(`  Cached to: ${join(cacheDir, "test-results.json")}`);

  if (verbose) {
    console.log("\n" + output);
  }

  console.log("");
}
