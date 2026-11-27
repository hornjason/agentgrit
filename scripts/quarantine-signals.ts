#!/usr/bin/env bun
/**
 * quarantine-signals.ts — take rows out of a signal log without deleting them.
 *
 * #331: capture wrote rows from text no human typed — task notifications, peer
 * messages, /loop lines, code like `slice(0, -1)`. Many modules read these
 * logs directly, so a per-row "ignore me" flag would only work once every one
 * of them honoured it. Moving the rows to `<name>.quarantined.jsonl` takes them
 * out of every score and correlation at once, and keeps each one, tagged with
 * why and when. The original is backed up first.
 *
 * Two ways to choose rows:
 *
 *   --machine-text <field>   rows whose stored text fails isHumanPrompt — the
 *                            same predicate the capture gate uses, so the cleanup
 *                            and the gate cannot disagree. Rows without that
 *                            field cannot be judged: they stay, counted UNMEASURED.
 *   --source <s> --before <ISO>
 *                            for ratings, which store no prompt text at all
 *                            (thumbs rows written before the fix shipped).
 *
 * Dry run by default; --write applies it. Re-running finds nothing left to move.
 *
 *   bun scripts/quarantine-signals.ts --file sentiment.jsonl --machine-text message_preview --reason "#331"
 *   bun scripts/quarantine-signals.ts --file ratings.jsonl --source thumbs --before <ISO> --reason "#331"
 */
import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSignalDir } from "../src/adapters/paths";
import { isHumanPrompt } from "../src/capture/human-prompt";

type Selector = { source: string; before: string } | { textField: string };

interface QuarantineSplit {
  keep: string[];
  quarantined: Record<string, unknown>[];
  unmeasured: number;
}

/** Selected rows move; every other line, even unparseable, stays byte for byte. */
export function splitRows(raw: string, sel: Selector): QuarantineSplit {
  let cutoff = Number.NaN;
  if ("before" in sel) {
    cutoff = Date.parse(sel.before);
    if (Number.isNaN(cutoff)) throw new Error(`--before is not a date: ${sel.before}`);
  }

  const out: QuarantineSplit = { keep: [], quarantined: [], unmeasured: 0 };
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, unknown> | null = null;
    try {
      row = JSON.parse(line);
    } catch {
      // not ours to judge
    }
    let move = false;
    if (row && "textField" in sel) {
      const text = row[sel.textField];
      if (typeof text === "string") move = !isHumanPrompt(text);
      else out.unmeasured++;
    } else if (row && "source" in sel) {
      const ts = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : Number.NaN;
      move = row.source === sel.source && ts < cutoff;
    }
    if (move && row) out.quarantined.push(row);
    else out.keep.push(line);
  }
  return out;
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const USAGE =
  "usage: quarantine-signals --file <name.jsonl> --reason <text> " +
  "(--machine-text <field> | --source <s> --before <ISO>) [--write] [--dir <signalDir>]";

function main(args = process.argv.slice(2)): void {
  const file = arg(args, "--file");
  const reason = arg(args, "--reason");
  const textField = arg(args, "--machine-text");
  const source = arg(args, "--source");
  const before = arg(args, "--before");
  const sel: Selector | null = textField ? { textField } : source && before ? { source, before } : null;
  if (!file || !reason || !sel) {
    console.error(USAGE);
    process.exit(1);
  }
  const dir = arg(args, "--dir") ?? resolveSignalDir();
  const live = join(dir, file);
  const quarantineFile = join(dir, file.replace(/\.jsonl$/, "") + ".quarantined.jsonl");
  const write = args.includes("--write");

  // Hooks append to these logs on every prompt. If one lands while we work,
  // start over rather than drop its line.
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = readFileSync(live, "utf-8");
    const { keep, quarantined, unmeasured } = splitRows(raw, sel);
    console.log(
      `${live}: ${keep.length + quarantined.length} rows → ${quarantined.length} quarantined, ` +
        `${keep.length} stay (${unmeasured} UNMEASURED: no text to judge)`,
    );
    if (!write) {
      console.log("dry run — nothing written (add --write)");
      return;
    }
    if (quarantined.length === 0) return;

    const at = new Date().toISOString();
    const backup = `${live}.pre-quarantine-${at.replace(/[:.]/g, "-")}`;
    const tmp = `${live}.tmp-${process.pid}`;
    writeFileSync(tmp, keep.map((l) => `${l}\n`).join(""));
    writeFileSync(backup, raw);
    // Compare and swap back to back: the window a hook could append into is
    // two syscalls wide. The backup already holds every row if anything fails.
    if (readFileSync(live, "utf-8") !== raw) {
      rmSync(tmp);
      rmSync(backup);
      console.error(`${file} changed while running — retrying`);
      continue;
    }
    renameSync(tmp, live);
    appendFileSync(
      quarantineFile,
      quarantined.map((r) => `${JSON.stringify({ ...r, quarantine: { reason, at } })}\n`).join(""),
    );
    console.log(`moved ${quarantined.length} row(s) to ${quarantineFile}; backup at ${backup}`);
    return;
  }
  console.error(`${file} kept changing — nothing moved`);
  process.exit(1);
}

if (import.meta.main) main();
