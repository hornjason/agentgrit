/**
 * backfill-ratings — recover rating signals from host transcripts (#260).
 *
 * #257 left the capture hook reading a field the host stopped sending, so from
 * 2026-10-01 until the fix every rating the user typed was parsed and thrown
 * away. None of it is under the AgentGrit base dir, so no amount of re-running
 * the daemon brings it back. The host's own transcript log, however, records
 * every user prompt verbatim, and that is where the ratings still live.
 *
 * This command walks those transcripts, runs each typed user prompt through the
 * SAME four parsers the live hook uses, and appends what they recognise.
 *
 * Two things it deliberately does NOT reuse:
 *
 *  - `captureRating`, because it hardcodes `timestamp: new Date()`. Mining 200
 *    October ratings and stamping them all with today's date destroys exactly
 *    the timeline this command exists to restore.
 *  - `parseTranscript` from the debrief module, because it returns only
 *    `{role, text}` and discards the uuid and timestamp — the two fields that
 *    make this run dateable and repeatable.
 *
 * KNOWN LIMIT, stated so nobody plans on it: transcripts do not record which
 * rules were injected into a session, so mined records carry no `rule_ids` and
 * rule attribution cannot be rebuilt from them. `processUnattributedRatings`
 * skips any record without rule_ids, and also skips anything at or behind its
 * cursor — backfilled records are both. What this recovers is the rating
 * history itself: counts, trend, sentiment. Not edge weights.
 */
import { randomUUID } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { appendSignals } from "../../src/adapters/jsonl";
import { hostTranscriptsDir, loadConfig, ratingsFile } from "../../src/adapters/paths";
import { SCHEMA_VERSION } from "../../src/adapters/types";
import type { AnySignal, RatingSignal } from "../../src/adapters/types";
import {
  computeComposite,
  parseBareNumberRating,
  parsePraiseRating,
  parseRating,
  parseThumbsRating,
} from "../../src/capture/rating";

export interface BackfillRatingsOptions {
  /** Root to walk for `*.jsonl`. Defaults to the host transcript root. */
  transcriptsDir?: string;
  /** Signal file to append to. Defaults to the live ratings log. */
  ratingsPath?: string;
  /** Inclusive lower bound, `YYYY-MM-DD` or a full ISO timestamp. */
  since?: string;
  /** Inclusive upper bound, `YYYY-MM-DD` or a full ISO timestamp. */
  until?: string;
  /** Report what would be written and write nothing. */
  dryRun?: boolean;
}

export interface BackfillRatingsResult {
  scannedFiles: number;
  scannedEntries: number;
  malformedLines: number;
  userPrompts: number;
  inRange: number;
  bySource: Record<RatingSignal["source"], number>;
  skippedDuplicate: number;
  skippedNoUuid: number;
  /** Records written — or, under dryRun, records that would be written. */
  written: number;
  dryRun: boolean;
  earliest?: string;
  latest?: string;
}

/** A mined record: a RatingSignal plus the dimensions live capture also writes. */
type MinedRating = RatingSignal & {
  mode?: number;
  scope?: number;
  quality?: number;
};

/** A user-authored prompt recovered from a transcript entry. */
interface TranscriptPrompt {
  uuid: string;
  timestamp: string;
  sessionId: string;
  text: string;
}

// ── Range bounds ──

/**
 * A date-only bound means the whole day, so the two ends expand differently.
 * Host timestamps are UTC with a Z suffix, which makes ISO-8601 strings
 * lexicographically ordered and a string compare sufficient.
 */
function lowerBound(since?: string): string | null {
  if (!since) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(since) ? `${since}T00:00:00.000Z` : since;
}

function upperBound(until?: string): string | null {
  if (!until) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(until) ? `${until}T23:59:59.999Z` : until;
}

// ── Transcript reading ──

function transcriptFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".jsonl")) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/** Text of a transcript message, or null when it carries none. */
function messageText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  const joined = parts.join("\n").trim();
  return joined || null;
}

/**
 * The typed user prompt in a transcript entry, or null.
 *
 * The host writes several things under `type: "user"` that no human typed:
 * tool results, injected meta entries, and subagent sidechain turns. The live
 * hook never saw any of those, so mining them would invent ratings that never
 * happened — `9 files changed` is a bare-number rating of 9 to a parser that
 * is handed it out of context.
 */
function readPrompt(entry: unknown): TranscriptPrompt | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;

  if (e.type !== "user") return null;
  if (e.isSidechain === true) return null;
  if (e.isMeta === true) return null;
  // Unproven defence-in-depth, stated as such: deleting this line changes the
  // result on no input I can name. Every one of the 6059 tool-result entries
  // in the real transcripts carries `toolUseResult` AND has no text block, so
  // the text extraction above already drops them. It stays because the shape
  // it names is the host's, not ours, and a future entry that carried both
  // would otherwise be mined as a prompt.
  if (e.toolUseResult !== undefined) return null;

  const message = e.message as { role?: unknown; content?: unknown } | undefined;
  if (!message || message.role !== "user") return null;

  const text = messageText(message.content);
  if (text === null) return null;

  if (typeof e.uuid !== "string" || typeof e.timestamp !== "string") return null;

  return {
    uuid: e.uuid,
    timestamp: e.timestamp,
    sessionId: typeof e.sessionId === "string" ? e.sessionId : "unknown",
    text,
  };
}

// ── Parsing, in the live hook's priority order ──

type ParsedRating = Pick<MinedRating, "rating" | "source" | "mode" | "scope" | "quality" | "comment">;

/**
 * Longest prompt the implicit parsers are allowed to see.
 *
 * MEASURED, and the reason this gate exists at all: a first pass without it
 * mined 4135 records from the 2026-10-01..19 window, of which 4134 were
 * "thumbs". Every single one was `parseThumbsRating` finding `+1` or `-1`
 * inside a long working prompt — `bump the retry counter by +1` and the like.
 * 3804 up, 344 down, zero real thumbs; none of the 4148 matches in that window
 * was a prompt of 5 words or fewer. Importing them would have buried the
 * signal far more thoroughly than the outage did.
 *
 * 5 words is not a new invention: `parsePraiseRating` already enforces exactly
 * this cap internally. The miner applies the same cap to the other two implicit
 * parsers, which do not. An explicit `/rate` line is exempt — it is anchored at
 * the start of the prompt and cannot be hit by accident, and its comment is
 * free text of any length.
 *
 * The live hook has the same false-positive hazard and no such gate; that is
 * worth its own issue, but it is not this command's to fix.
 */
const MAX_IMPLICIT_WORDS = 5;

function parsePrompt(text: string): ParsedRating | null {
  const config = loadConfig();

  const explicit = parseRating(text);
  if (explicit) {
    return {
      rating: computeComposite(explicit.mode, explicit.scope, explicit.quality),
      source: "explicit",
      mode: explicit.mode,
      scope: explicit.scope,
      quality: explicit.quality,
      comment: explicit.comment,
    };
  }

  if (text.split(/\s+/).length > MAX_IMPLICIT_WORDS) return null;

  const bare = parseBareNumberRating(text);
  if (bare !== null) return { rating: bare, source: "implicit" };

  const praise = parsePraiseRating(text, config);
  if (praise) return { rating: praise.score, source: "praise" };

  const thumbs = parseThumbsRating(text, config);
  if (thumbs) return { rating: thumbs.score, source: "thumbs" };

  return null;
}

// ── Idempotency ──

/**
 * The transcript uuids already represented in the ratings log.
 *
 * Keyed on the transcript entry uuid rather than on timestamp or content: two
 * prompts of "8" a minute apart are two real ratings, and re-running the miner
 * must not collapse them, while re-reading the same entry must not duplicate it.
 */
function existingSourceUuids(ratingsPath: string): Set<string> {
  const seen = new Set<string>();
  if (!existsSync(ratingsPath)) return seen;

  for (const line of readFileSync(ratingsPath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as { source_uuid?: unknown };
      if (typeof record.source_uuid === "string") seen.add(record.source_uuid);
    } catch {
      // A malformed line cannot claim a uuid; worst case we re-write a record.
    }
  }
  return seen;
}

// ── The miner ──

export async function mineTranscriptRatings(
  opts: BackfillRatingsOptions = {},
): Promise<BackfillRatingsResult> {
  const root = opts.transcriptsDir ?? hostTranscriptsDir();
  const ratingsPath = opts.ratingsPath ?? ratingsFile();
  const from = lowerBound(opts.since);
  const to = upperBound(opts.until);
  const dryRun = opts.dryRun === true;

  const result: BackfillRatingsResult = {
    scannedFiles: 0,
    scannedEntries: 0,
    malformedLines: 0,
    userPrompts: 0,
    inRange: 0,
    bySource: { explicit: 0, implicit: 0, praise: 0, thumbs: 0 },
    skippedDuplicate: 0,
    skippedNoUuid: 0,
    written: 0,
    dryRun,
  };

  const seen = existingSourceUuids(ratingsPath);
  const records: MinedRating[] = [];

  for (const file of transcriptFiles(root)) {
    result.scannedFiles++;
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;

      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        result.malformedLines++;
        continue;
      }
      result.scannedEntries++;

      const prompt = readPrompt(entry);
      if (!prompt) continue;
      result.userPrompts++;

      if (from && prompt.timestamp < from) continue;
      if (to && prompt.timestamp > to) continue;
      result.inRange++;

      const parsed = parsePrompt(prompt.text);
      if (!parsed) continue;
      result.bySource[parsed.source]++;

      if (seen.has(prompt.uuid)) {
        result.skippedDuplicate++;
        continue;
      }
      seen.add(prompt.uuid);

      records.push({
        id: randomUUID(),
        type: "rating",
        timestamp: prompt.timestamp,
        session_id: prompt.sessionId,
        schemaVersion: SCHEMA_VERSION,
        rating: parsed.rating,
        source: parsed.source,
        mode: parsed.mode,
        scope: parsed.scope,
        quality: parsed.quality,
        comment: parsed.comment,
        provenance: "backfill",
        source_uuid: prompt.uuid,
      });
    }
  }

  records.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  result.written = records.length;
  result.earliest = records[0]?.timestamp;
  result.latest = records[records.length - 1]?.timestamp;

  if (!dryRun) await appendSignals(ratingsPath, records as AnySignal[]);

  return result;
}

// ── CLI ──

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

export async function backfillRatingsCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
agentgrit backfill-ratings — recover ratings from host transcripts

Usage: agentgrit backfill-ratings [options]

Options:
  --since <date>    Inclusive lower bound (YYYY-MM-DD or ISO timestamp)
  --until <date>    Inclusive upper bound (YYYY-MM-DD or ISO timestamp)
  --transcripts <dir>  Transcript root to walk (default: host transcript dir)
  --out <file>      Ratings file to append to (default: signals/ratings.jsonl)
  --dry-run         Report what would be written, write nothing

Re-running over the same range is a no-op: each record carries the transcript
entry uuid it came from, and an entry already in the log is skipped.

Mined records carry no rule_ids — transcripts do not record which rules a
session loaded — so this restores rating history, not rule attribution.
`);
    return;
  }

  const dryRun = args.includes("--dry-run");
  const since = flagValue(args, "--since");
  const until = flagValue(args, "--until");
  const transcriptsDir = flagValue(args, "--transcripts");
  const ratingsPath = flagValue(args, "--out");

  const root = transcriptsDir ?? hostTranscriptsDir();
  const target = ratingsPath ?? ratingsFile();

  console.log(`\nagentgrit backfill-ratings${dryRun ? " (dry run)" : ""}\n`);
  console.log(`  Transcripts: ${root}`);
  console.log(`  Ratings:     ${target}`);
  console.log(`  Range:       ${since ?? "(beginning)"} → ${until ?? "(now)"}\n`);

  if (!existsSync(root)) {
    console.log(`  ✗ Transcript directory not found: ${root}`);
    console.log("    Set paths.hostTranscriptsDir in config.json, or pass --transcripts.\n");
    return;
  }

  const result = await mineTranscriptRatings({ transcriptsDir: root, ratingsPath: target, since, until, dryRun });

  console.log(`  Scanned:     ${result.scannedFiles} files, ${result.scannedEntries} entries`);
  console.log(`  User prompts: ${result.userPrompts} (${result.inRange} in range)`);
  console.log(`  Recognised:  explicit ${result.bySource.explicit}, implicit ${result.bySource.implicit}, praise ${result.bySource.praise}, thumbs ${result.bySource.thumbs}`);
  console.log(`  Already present: ${result.skippedDuplicate}`);
  if (result.malformedLines > 0) console.log(`  Malformed lines skipped: ${result.malformedLines}`);

  if (result.written === 0) {
    console.log("\n  Nothing to write — every recognised rating is already in the log.\n");
    return;
  }

  console.log(`\n  ${dryRun ? "Would write" : "Wrote"}: ${result.written} records (${result.earliest} → ${result.latest})`);
  if (dryRun) {
    console.log("  Dry run — nothing written. Re-run without --dry-run to apply.\n");
  } else {
    console.log("  Run 'agentgrit status' to see the restored trend.\n");
  }
}
