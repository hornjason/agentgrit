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
 * The single write path for every JSON file under the state directory.
 *
 * Only `rule-lifecycle.json` used to be written this way; every other state
 * file was a bare `writeFileSync`, which is a read-modify-write race between
 * any two processes that touch it — the daemon, a CLI command and a hook all
 * do. The evidence was 36 orphaned `.tmp` files in a live state directory
 * (#242). PID-based temp names gave uniqueness, never mutual exclusion.
 *
 * Two mechanisms, and they do different jobs. Do not collapse them:
 *
 * - **temp-and-rename** makes each write atomic. `rename(2)` within a
 *   filesystem is atomic, so a reader sees the old document or the new one and
 *   never a half-flushed one. This holds even with no lock at all.
 * - **the lock file** serialises read-modify-write callers, so two processes
 *   that each read, edit and save do not silently drop one of the two edits.
 *
 * The lock is advisory and bounded: after `LOCK_WAIT_MS` of contention the
 * write proceeds unguarded. That is deliberate. A daemon that blocks forever on
 * a lock file someone else leaked is a worse failure than a lost update, and
 * the rename keeps the document whole either way.
 */

/** A lock older than this is assumed to belong to a process that died. */
const LOCK_STALE_MS = 30_000;

/** How long to contend for the lock before writing without it. */
const LOCK_WAIT_MS = 250;

/** Pause between acquisition attempts. */
const LOCK_RETRY_MS = 10;

/**
 * Marks a temp sibling. `cleanupOrphanedTmpFiles` matches on this, so the two
 * must agree — hence one constant rather than two string literals.
 */
const TMP_INFIX = ".tmp.";

/**
 * Distinguishes two writes from the *same* process. The PID alone does not:
 * one process writing two state files, or the same file twice, reused the name.
 */
let tmpCounter = 0;

/**
 * Block the thread for `ms`.
 *
 * `Atomics.wait` rather than `Bun.sleepSync`: this module is reached by the
 * `--target=node` bundle, where the `Bun` global does not exist. Node and Bun
 * both allow `Atomics.wait` on the main thread.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryAcquire(lockPath: string): number | undefined {
  try {
    return openSync(lockPath, "wx");
  } catch {
    return undefined;
  }
}

function clearIfStale(lockPath: string): void {
  try {
    if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync(lockPath);
  } catch {
    /* already gone, or another process cleaned it first */
  }
}

/**
 * Run `fn` while holding `lockPath`, releasing it afterwards.
 *
 * Deliberately module-private: the point of this issue is that there is one
 * write path, and an exported lock primitive invites a second one built beside
 * it rather than through `atomicWriteJSON`.
 */
function withFileLock<T>(lockPath: string, fn: () => T): T {
  let fd = tryAcquire(lockPath);
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (fd === undefined && Date.now() < deadline) {
    clearIfStale(lockPath);
    fd = tryAcquire(lockPath);
    if (fd === undefined) sleepSync(LOCK_RETRY_MS);
  }

  try {
    return fn();
  } finally {
    // Only the holder removes the lock. Unlinking one we never acquired would
    // hand the file to a third process while the real holder is mid-write.
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort */ }
      try { unlinkSync(lockPath); } catch { /* best-effort */ }
    }
  }
}

/**
 * Delete temp siblings of `prefix` left behind by a crashed writer.
 *
 * Scoped to one file's prefix on purpose: a sweep of every `*.tmp.*` in the
 * directory would delete the in-flight temp file of a concurrent writer.
 */
export function cleanupOrphanedTmpFiles(dir: string, prefix: string): void {
  try {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(prefix + TMP_INFIX)) {
        try { unlinkSync(join(dir, entry)); } catch { /* best-effort */ }
      }
    }
  } catch {
    /* directory may not exist yet */
  }
}

/**
 * Serialise `value` and replace `filePath` with it atomically, under a lock.
 *
 * Creates the parent directory if needed. Throws — rather than writing an
 * empty or partial file — if `value` cannot be serialised, and removes the
 * temp file if the write or rename fails.
 */
export function atomicWriteJSON(filePath: string, value: unknown, space: number = 2): void {
  // Serialise before touching the filesystem: a value containing a BigInt or a
  // cycle throws here, and doing it first means the failure leaves nothing
  // behind — no directory, no lock, no temp file.
  const content = JSON.stringify(value, null, space);
  if (content === undefined) {
    throw new TypeError(`atomicWriteJSON: value for ${filePath} serialises to undefined`);
  }

  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  withFileLock(filePath + ".lock", () => {
    const tmpPath = `${filePath}${TMP_INFIX}${process.pid}.${++tmpCounter}`;
    try {
      writeFileSync(tmpPath, content, "utf-8");
      renameSync(tmpPath, filePath);
    } catch (err) {
      try { unlinkSync(tmpPath); } catch { /* cleanup best-effort */ }
      throw err;
    }
  });
}
