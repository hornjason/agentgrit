import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolveSignalDir, resolveSignalFile } from "../../src/adapters/paths";

export async function backfillTypesCommand(args: string[]): Promise<void> {
  const filePath = args[0]
    ? args[0]
    : resolveSignalFile(resolveSignalDir(), "ratings.jsonl");

  if (!existsSync(filePath)) {
    console.log(`File not found: ${filePath}`);
    return;
  }

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());

  let patched = 0;
  const updated: string[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (!entry.type) {
        entry.type = "rating";
        patched++;
      }
      updated.push(JSON.stringify(entry));
    } catch {
      updated.push(line);
    }
  }

  writeFileSync(filePath, updated.join("\n") + "\n");
  console.log(`Backfilled ${patched}/${lines.length} entries with type: "rating" in ${filePath}`);
}
