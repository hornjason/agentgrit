#!/usr/bin/env bun
/**
 * quarantine-ratings.ts — take rows out of ratings.jsonl without deleting them.
 *
 * #331: the live hook wrote thumbs rows from machine text (task notifications,
 * peer messages, code like `slice(0, -1)`); none of the 107 traceable rows was
 * typed by the human. About twenty modules read ratings.jsonl directly, so a
 * per-row "ignore me" flag would only work once every one of them honoured it.
 * Moving the rows to ratings.quarantined.jsonl takes them out of every score
 * and correlation at once, and keeps each one, tagged with why and when.
 *
 * Dry run by default; --write applies it. Re-running with the same arguments
 * finds nothing left to move.
 *
 *   bun scripts/quarantine-ratings.ts --source thumbs \
 *     --before 2026-11-27T21:00:00Z --reason "#331 machine text" [--write] [--dir <signalDir>]
 */
import { appendFileSync, copyFileSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSignalDir } from "../src/adapters/paths";

interface QuarantineSelector {
  source: string;
  before: string;
}

interface QuarantineSplit {
  keep: string[];
  quarantined: Record<string, unknown>[];
}

/** Rows with `source` written before `before` move; every other line, even unparseable, stays as it was. */
export function splitRatings(raw: string, sel: QuarantineSelector): QuarantineSplit {
  const cutoff = Date.parse(sel.before);
  if (Number.isNaN(cutoff)) throw new Error(`--before is not a date: ${sel.before}`);

  const keep: string[] = [];
  const quarantined: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, unknown> | null = null;
    try {
      row = JSON.parse(line);
    } catch {
      // not ours to judge — keep it byte for byte
    }
    const ts = typeof row?.timestamp === "string" ? Date.parse(row.timestamp) : Number.NaN;
    if (row && row.source === sel.source && ts < cutoff) quarantined.push(row);
    else keep.push(line);
  }
  return { keep, quarantined };
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(args = process.argv.slice(2)): void {
  const source = arg(args, "--source");
  const before = arg(args, "--before");
  const reason = arg(args, "--reason");
  if (!source || !before || !reason) {
    console.error("usage: quarantine-ratings --source <s> --before <ISO> --reason <text> [--write] [--dir <signalDir>]");
    process.exit(1);
  }
  const dir = arg(args, "--dir") ?? resolveSignalDir();
  const live = join(dir, "ratings.jsonl");
  const raw = readFileSync(live, "utf-8");
  const { keep, quarantined } = splitRatings(raw, { source, before });

  const byRating = new Map<unknown, number>();
  for (const r of quarantined) byRating.set(r.rating, (byRating.get(r.rating) ?? 0) + 1);
  console.log(`${live}: ${quarantined.length} row(s) with source=${source} before ${before}; ${keep.length} line(s) stay`);
  for (const [rating, n] of byRating) console.log(`  rating ${rating}: ${n}`);
  if (!args.includes("--write")) {
    console.log("dry run — nothing written (add --write)");
    return;
  }
  if (quarantined.length === 0) return;

  const at = new Date().toISOString();
  const backup = `${live}.pre-quarantine-${at.replace(/[:.]/g, "-")}`;
  copyFileSync(live, backup);

  const tmp = `${live}.tmp-${process.pid}`;
  writeFileSync(tmp, keep.map((l) => `${l}\n`).join(""));
  // A hook may have appended while we worked; never drop its line.
  if (readFileSync(live, "utf-8") !== raw) {
    rmSync(tmp);
    console.error("ratings.jsonl changed while running — nothing moved, rerun");
    process.exit(1);
  }
  appendFileSync(
    join(dir, "ratings.quarantined.jsonl"),
    quarantined.map((r) => `${JSON.stringify({ ...r, quarantine: { reason, at } })}\n`).join(""),
  );
  renameSync(tmp, live);
  console.log(`moved ${quarantined.length} row(s) to ratings.quarantined.jsonl; backup at ${backup}`);
}

if (import.meta.main) main();
