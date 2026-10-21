import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";

/**
 * Lock-guarded, crash-safe writes for the JSON documents under
 * `~/.agentgrit/state/`.
 *
 * Every one of those files is a read-modify-write: load the whole document,
 * change one key, write the whole document back. Two writers overlapping on
 * that cycle lose one of the two edits, and a writer killed mid-`writeFileSync`
 * leaves a truncated document that the next load silently treats as "no data".
 *
 * Only `rule-lifecycle.json` was protected. This module is that protection
 * extracted so every state file gets it, because a guard on one of five write
 * paths is a guard on none — the 36 orphaned `.tmp.` files found in a live
 * state directory were proof the overlap is routine, not theoretical.
 */

/** A lock older than this is assumed to belong to a process that died holding it. */
const LOCK_STALE_MS = 30_000;

/**
 * Marks a scratch file. Shared by the writer and by {@link cleanupTmpFiles}, so
 * the sweeper cannot drift out of step with the names it is sweeping for.
 */
const TMP_INFIX = ".tmp.";

/** How long a blocked writer waits for the lock before giving up on it. */
const LOCK_WAIT_MS = 250;
const LOCK_POLL_MS = 5;

/**
 * Within one process the pid is identical for every writer, so the pid alone
 * does not make a temp name unique. Two overlapping writes in one process would
 * share a scratch file and interleave their bytes.
 */
let tmpCounter = 0;

/** Sleep without an event loop turn — the whole write path is synchronous. */
function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/** Take the lock if it is free, clearing it first if its owner is long gone. */
function tryAcquire(lockPath: string): number | undefined {
  try {
    return openSync(lockPath, "wx");
  } catch {
    try {
      const age = Date.now() - statSync(lockPath).mtimeMs;
      if (age > LOCK_STALE_MS) unlinkSync(lockPath);
    } catch {
      // Gone already, or another process cleaned it. Either way, retry below.
    }
    try {
      return openSync(lockPath, "wx");
    } catch {
      return undefined;
    }
  }
}

/**
 * Run `fn` holding an exclusive lock file, waiting briefly for a contended one.
 *
 * Deliberately fails open: after {@link LOCK_WAIT_MS} the work runs unlocked
 * rather than throwing. A state-file update is not worth failing a command
 * over, and the temp-write-and-rename below still keeps the document readable
 * and the directory clean under an unlocked overlap — only the lost-update
 * protection is given up.
 *
 * Only the process that created the lock removes it, so a writer that gave up
 * waiting can never delete the holder's lock out from under it.
 */
function withLock<T>(lockPath: string, fn: () => T): T {
  let fd = tryAcquire(lockPath);
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (fd === undefined && Date.now() < deadline) {
    sleepSync(LOCK_POLL_MS);
    fd = tryAcquire(lockPath);
  }

  try {
    return fn();
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort */ }
      try { unlinkSync(lockPath); } catch { /* best-effort */ }
    }
  }
}

/**
 * Delete scratch files left behind for `prefix` in `dir` by a write that died
 * between creating its temp file and renaming it into place.
 *
 * Scoped to one document's prefix on purpose: a blanket sweep of `*.tmp.*`
 * would delete the in-flight scratch file of a concurrent writer working on a
 * different document in the same directory.
 */
export function cleanupTmpFiles(dir: string, prefix: string): void {
  try {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(prefix + TMP_INFIX)) {
        try { unlinkSync(join(dir, entry)); } catch { /* best-effort */ }
      }
    }
  } catch { /* dir might not exist */ }
}

/**
 * Serialise `data` to `filePath` as JSON so a reader never sees a partial
 * document and the directory is never left holding scratch files.
 *
 * The content lands in a per-writer temp file and is moved into place with
 * `rename`, which is atomic within a filesystem: a concurrent reader sees
 * either the old document or the new one, never a half-written one. The parent
 * directory is created if missing, so callers do not each repeat that check.
 */
export function atomicWriteJSON(filePath: string, data: unknown, indent: number = 2): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const lockPath = filePath + ".lock";
  withLock(lockPath, () => {
    const content = JSON.stringify(data, null, indent);
    const tmpPath = `${filePath}${TMP_INFIX}${process.pid}.${tmpCounter++}`;
    try {
      writeFileSync(tmpPath, content, "utf-8");
      renameSync(tmpPath, filePath);
    } catch (err) {
      try { unlinkSync(tmpPath); } catch { /* cleanup best-effort */ }
      throw err;
    }
  });
}
