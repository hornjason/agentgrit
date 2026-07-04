import { existsSync, statSync, readdirSync } from "fs";
import { join } from "path";
import { getBaseDir, resolveSignalDir } from "../../src/adapters/paths";
import { readSignals, rotateFile } from "../../src/adapters/jsonl";
import { relativeTime } from "../../src/adapters/time";

const DEFAULT_MAX_SIZE = 5 * 1024 * 1024;

interface SignalFileInfo {
  name: string;
  path: string;
  count: number;
  sizeKb: number;
  lastModified: string | null;
}

async function listSignalFiles(dir: string): Promise<SignalFileInfo[]> {
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  const infos: SignalFileInfo[] = [];

  for (const name of files.sort()) {
    const path = join(dir, name);
    const stat = statSync(path);
    const signals = await readSignals(path);

    infos.push({
      name,
      path,
      count: signals.length,
      sizeKb: Math.round(stat.size / 1024),
      lastModified: stat.mtime.toISOString(),
    });
  }

  return infos;
}

export async function signalsCommand(args: string[]): Promise<void> {
  const base = getBaseDir();
  const sigDir = resolveSignalDir();
  const sub = args[0];

  console.log("\nagentgrit signals\n");

  if (!existsSync(sigDir)) {
    console.log("  No signals directory. Run 'agentgrit init' first.\n");
    return;
  }

  const files = await listSignalFiles(sigDir);

  if (files.length === 0) {
    console.log("  No signal files found.\n");
    return;
  }

  if (sub === "rotate") {
    let rotated = 0;
    for (const file of files) {
      const result = await rotateFile(file.path, DEFAULT_MAX_SIZE);
      if (result.rotated) {
        console.log(`  ✓ Rotated ${file.name} → ${result.archivePath}`);
        rotated++;
      }
    }
    if (rotated === 0) {
      console.log("  No files need rotation (all under 5MB).");
    }
    console.log("");
    return;
  }

  let totalSize = 0;
  let totalEntries = 0;

  for (const file of files) {
    const age = file.lastModified ? relativeTime(file.lastModified) : "unknown";
    const sizeWarn = file.sizeKb > 5000 ? " ⚠" : "";
    console.log(`  ${file.name.padEnd(24)} ${String(file.count).padStart(6)} entries  ${String(file.sizeKb).padStart(6)}KB  ${age}${sizeWarn}`);
    totalSize += file.sizeKb;
    totalEntries += file.count;
  }

  console.log(`${"".padEnd(2)}${"─".repeat(60)}`);
  console.log(`  ${"Total".padEnd(24)} ${String(totalEntries).padStart(6)} entries  ${String(totalSize).padStart(6)}KB`);

  if (files.some((f) => f.sizeKb > 5000)) {
    console.log(`\n  ⚠ Large files detected. Run 'agentgrit signals rotate' to archive.`);
  }

  console.log("");
}
