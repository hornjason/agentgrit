/**
 * Scheduler installation for the agentgrit daemon.
 *
 * Issue #259: this module used to write a plist into ~/Library/LaunchAgents
 * and report success. A plist file is not a scheduled job — launchd only scans
 * that directory at login, so until something calls `launchctl bootstrap` the
 * file is inert. getSchedulerStatus() asked existsSync() and nothing else,
 * which meant "file on disk" and "job running" were indistinguishable.
 *
 * Three things changed:
 *   1. installScheduler() now registers the job with launchd and verifies it.
 *   2. Named intervals ("daily", "hourly", "weekly") parse. The real config
 *      says "daily", which the old numeric-only regex silently turned into
 *      1800 seconds.
 *   3. Registration is queried from launchd, not inferred from the filesystem,
 *      and the query is not fail-open.
 *
 * Windows (issue #186) is deliberately a distinct, named gap rather than a
 * generic "unsupported platform" — the backend split below is where Task
 * Scheduler support slots in.
 */

import { existsSync, mkdirSync, realpathSync, unlinkSync, writeFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { execFileSync } from "child_process";
import { getBaseDir } from "../adapters/paths";

export const DEFAULT_LABEL = "com.agentgrit.daemon";

/** Hour of day used for calendar schedules; matches the historical 03:00 cadence. */
const DEFAULT_RUN_HOUR = 3;

/** Legacy fallback retained only for generatePlist's older unit contract. */
const LEGACY_FALLBACK_SECONDS = 1800;

export interface SchedulerConfig {
  interval: string;
  command: string;
  /** Explicit argv. Preferred over splitting `command` on spaces. */
  args?: string[];
  label?: string;
  logDir?: string;
  /**
   * Argv for a cheap "can this even start" probe of `command`, run before the
   * job is registered. Omitting it skips the probe and the install reports
   * UNVERIFIED rather than silently treating "not checked" as "fine" (#277).
   */
  verifyArgs?: string[];
  /**
   * PATH for the scheduled job. Defaults to the installing shell's PATH —
   * launchd gives a job a minimal one that does not include homebrew (#285).
   */
  path?: string;
}

export interface SchedulerPaths {
  launchAgentDir: string;
  /**
   * Where the systemd user units live. Overridable for the same reason
   * `launchAgentDir` is: without it a test that wants a `.timer` on disk has
   * to write one into the developer's real ~/.config/systemd/user, so the
   * state #275 is about could not be set up at all (#275).
   */
  systemdDir: string;
  logDir: string;
  label: string;
}

export interface SchedulerOptions extends Partial<SchedulerPaths> {
  /** Register with the platform scheduler. False writes files only (tests). */
  register?: boolean;
  runAtLoad?: boolean;
  /** Injectable registry probe. Used by tests to prove the check is not fail-open. */
  probe?: (label: string) => boolean;
  /**
   * Injectable executability probe for the scheduled command. Returns nothing
   * on success and throws on failure, mirroring execFileSync.
   */
  verify?: (command: string, args: string[]) => void;
}

export interface SchedulerStatus {
  installed: boolean;
  /** Whether the platform scheduler actually knows about the job. */
  registered: boolean;
  running: boolean;
  lastRun?: string;
  platform: string;
  label: string;
}

export type Schedule =
  | { kind: "interval"; seconds: number }
  | { kind: "calendar"; hour: number; minute: number; weekday?: number };

// ───────────────────────────── interval parsing ─────────────────────────────

/**
 * Parse a configured interval into a concrete schedule.
 *
 * Returns null when the value is not understood. Callers must decide what to
 * do about that — silently substituting a default is what produced #259,
 * where a config saying "daily" was installed as a 30-minute timer.
 */
export function parseSchedule(interval: string): Schedule | null {
  const value = (interval ?? "").trim().toLowerCase();
  if (!value) return null;

  if (value === "hourly") return { kind: "interval", seconds: 3600 };
  if (value === "daily") return { kind: "calendar", hour: DEFAULT_RUN_HOUR, minute: 0 };
  if (value === "weekly") {
    return { kind: "calendar", hour: DEFAULT_RUN_HOUR, minute: 0, weekday: 0 };
  }

  const match = value.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return null;

  const n = parseInt(match[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;

  const unit = match[2];
  const multiplier = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
  return { kind: "interval", seconds: n * multiplier };
}

/** Approximate seconds between runs, for staleness reasoning. */
function schedulePeriodSeconds(schedule: Schedule): number {
  if (schedule.kind === "interval") return schedule.seconds;
  return schedule.weekday === undefined ? 86400 : 604800;
}

// ───────────────────────────────── paths ─────────────────────────────────

function defaultLogDir(): string {
  return join(getBaseDir(), "logs");
}

function defaultLaunchAgentDir(): string {
  return join(homedir(), "Library", "LaunchAgents");
}

function defaultSystemdDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

/**
 * Refuse to let a test reach the developer's real scheduler.
 *
 * Exported so there is one binding to mutate, and so the case proving it can
 * fail is pointed at the thing that decides rather than at a message.
 *
 * A test that scopes neither the label nor the directory is not testing the
 * scheduler, it is editing the machine — and because `uninstallScheduler()`
 * takes every argument optionally, reaching the real job is what you get by
 * writing nothing at all. That is what #281 was: one no-argument call deleted
 * a live launchd job and its plist, with the suite green and nothing said.
 *
 * Scoped by NODE_ENV rather than by a flag the caller passes, because the
 * callers that need stopping are the ones that did not think to pass anything.
 */
// `null` means "there is no NODE_ENV", which is distinct from omitting the
// argument. A default parameter is applied when the argument is `undefined`,
// so `f(opts, undefined)` reads process.env.NODE_ENV and cannot express the
// unset case at all — which made the first version of the control case here
// fail against correct code.
/** Compare two paths by value, not by spelling. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = resolve(p);
    try {
      return realpathSync.native(r);
    } catch {
      // Not yet created — a temp dir the caller is about to make. `resolve`
      // alone is the right answer there, and it is still normalized.
      return r;
    }
  };
  return norm(a) === norm(b);
}

export function hostSchedulerEscape(
  opts: SchedulerOptions,
  nodeEnv: string | null | undefined = process.env.NODE_ENV,
): string | null {
  if (nodeEnv !== "test") return null;

  // EVERY real resource is refused on its own, not only the combination.
  //
  // The first version of this guard required label AND directory to both be
  // real before refusing, which left the hole it was written to close:
  // `uninstallScheduler({ launchAgentDir: "/tmp/x" })` kept DEFAULT_LABEL, was
  // allowed through, and `bootoutQuiet(label)` removed the live launchd job —
  // #281 verbatim, reintroduced by its own fix. launchd is addressed BY LABEL
  // and knows nothing about which directory the plist came from, so scoping
  // the directory does not scope the side effect. The mirror case is just as
  // real: a scoped label with the default directory writes a plist into the
  // user's own ~/Library/LaunchAgents.
  //
  // So the rule is: a test must scope all three, and any one left at its real
  // value is refused by name.
  const offenders: string[] = [];
  if ((opts.label ?? DEFAULT_LABEL) === DEFAULT_LABEL) {
    offenders.push(`label "${DEFAULT_LABEL}" (launchd is addressed by label, not by path)`);
  }
  if (samePath(opts.launchAgentDir ?? defaultLaunchAgentDir(), defaultLaunchAgentDir())) {
    offenders.push(`launchAgentDir ${defaultLaunchAgentDir()}`);
  }
  // systemdDir is refused on the same terms, and on every platform, exactly as
  // launchAgentDir is. On linux `installScheduler` writes two unit files there
  // and `uninstallScheduler` unlinks them, so an unscoped test deletes the
  // user's real units — #281 with a different filename (#275).
  if (samePath(opts.systemdDir ?? defaultSystemdDir(), defaultSystemdDir())) {
    offenders.push(`systemdDir ${defaultSystemdDir()}`);
  }
  if (samePath(opts.logDir ?? defaultLogDir(), defaultLogDir())) {
    offenders.push(`logDir ${defaultLogDir()}`);
  }
  if (offenders.length === 0) return null;

  return (
    `Refusing to touch the real scheduler from a test run — ` +
    `${offenders.join("; ")}. Scope label, launchAgentDir, systemdDir and ` +
    `logDir to a temp directory; any one left real is refused, because each ` +
    `reaches the host on its own (#281, #283, #275).`
  );
}

function resolvePaths(opts: SchedulerOptions = {}): SchedulerPaths {
  const escape = hostSchedulerEscape(opts);
  if (escape) throw new Error(escape);
  return {
    launchAgentDir: opts.launchAgentDir ?? defaultLaunchAgentDir(),
    systemdDir: opts.systemdDir ?? defaultSystemdDir(),
    logDir: opts.logDir ?? defaultLogDir(),
    label: opts.label ?? DEFAULT_LABEL,
  };
}

function plistPath(paths: SchedulerPaths): string {
  return join(paths.launchAgentDir, `${paths.label}.plist`);
}

function stdoutPath(logDir: string): string {
  return join(logDir, "daemon.log");
}

function stderrPath(logDir: string): string {
  return join(logDir, "daemon.err.log");
}

function servicePath(paths: SchedulerPaths): string {
  return join(paths.systemdDir, `${paths.label}.service`);
}

function timerPath(paths: SchedulerPaths): string {
  return join(paths.systemdDir, `${paths.label}.timer`);
}

/** True when both unit files are on disk. Says nothing about enablement. */
function unitFilesPresent(paths: SchedulerPaths): boolean {
  return existsSync(timerPath(paths)) && existsSync(servicePath(paths));
}

// ──────────────────────────── macOS LaunchAgent ────────────────────────────

/**
 * The PATH the scheduled job runs with.
 *
 * launchd does not give a job the user's login PATH — it gets a minimal
 * `/usr/bin:/bin:/usr/sbin:/sbin`, and `launchctl getenv PATH` is empty on a
 * default install. The daemon's test-cache step shells out to `bun`, which
 * lives in /opt/homebrew/bin on an Apple Silicon machine, so every scheduled
 * cycle reported `spawnSync bun ENOENT` while the identical command worked
 * from a terminal (#285).
 *
 * Captured at install time rather than hardcoded: the install is run from the
 * user's shell, which is the one place that knows where their tools are. The
 * fallback is the launchd default, so a caller passing nothing is no worse off
 * than before.
 */
export function schedulerPath(explicit?: string): string {
  const LAUNCHD_DEFAULT = "/usr/bin:/bin:/usr/sbin:/sbin";
  const captured = explicit ?? process.env.PATH ?? "";
  // One decider. An earlier version also had an `if (!captured ||
  // captured.trim().length === 0) return LAUNCHD_DEFAULT` above this, and
  // removing it was 0 red across the whole suite — the filter below already
  // discards empty and whitespace entries, so the two always agreed and no
  // test could tell them apart. Kept the one that does the work.
  //
  // The launchd default stays on the end so the job keeps working if the
  // captured PATH goes stale (a homebrew prefix that moved, a version manager
  // shim that was uninstalled), and so an empty capture degrades to what the
  // job would have had anyway rather than to nothing.
  const entries = [...captured.split(":"), ...LAUNCHD_DEFAULT.split(":")]
    .map(p => p.trim())
    .filter(p => p.length > 0);
  return [...new Set(entries)].join(":");
}

function commandArgv(config: SchedulerConfig): string[] {
  if (config.args && config.args.length > 0) return [config.command, ...config.args];
  return config.command.split(" ").filter((p) => p.length > 0);
}

export function generatePlist(config: SchedulerConfig): string {
  const label = config.label ?? DEFAULT_LABEL;
  const logDir = config.logDir ?? defaultLogDir();

  // parseSchedule returning null means "not understood". installScheduler
  // rejects that before it gets here; the fallback exists only to preserve the
  // original unit-level contract of this function and is unreachable through
  // the install path.
  const schedule: Schedule =
    parseSchedule(config.interval) ?? { kind: "interval", seconds: LEGACY_FALLBACK_SECONDS };

  const argEntries = commandArgv(config)
    .map((a) => `      <string>${escapeXml(a)}</string>`)
    .join("\n");

  let triggerBlock: string;
  if (schedule.kind === "interval") {
    triggerBlock = `    <key>StartInterval</key>
    <integer>${schedule.seconds}</integer>`;
  } else {
    const weekdayEntry =
      schedule.weekday === undefined
        ? ""
        : `\n        <key>Weekday</key>\n        <integer>${schedule.weekday}</integer>`;
    triggerBlock = `    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>${schedule.hour}</integer>
        <key>Minute</key>
        <integer>${schedule.minute}</integer>${weekdayEntry}
    </dict>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${argEntries}
    </array>
${triggerBlock}
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${escapeXml(schedulerPath(config.path))}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(stdoutPath(logDir))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(stderrPath(logDir))}</string>
</dict>
</plist>`;
}

// ───────────────────────────── Linux systemd ─────────────────────────────

export function generateSystemdService(config: SchedulerConfig): string {
  return `[Unit]
Description=AgentGrit daemon cycle
After=network.target

[Service]
Type=oneshot
Environment=PATH=${schedulerPath(config.path)}
ExecStart=${config.command}

[Install]
WantedBy=default.target
`;
}

export function generateSystemdTimer(config: SchedulerConfig): string {
  const schedule: Schedule =
    parseSchedule(config.interval) ?? { kind: "interval", seconds: LEGACY_FALLBACK_SECONDS };

  let trigger: string;
  if (schedule.kind === "calendar") {
    trigger =
      schedule.weekday === undefined
        ? `OnCalendar=*-*-* ${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}:00`
        : `OnCalendar=Sun *-*-* ${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}:00`;
  } else {
    const minutes = Math.max(1, Math.round(schedule.seconds / 60));
    trigger = `OnBootSec=${minutes}min\nOnUnitActiveSec=${minutes}min`;
  }

  return `[Unit]
Description=AgentGrit daemon timer

[Timer]
${trigger}
Persistent=true

[Install]
WantedBy=timers.target
`;
}

// ────────────────────────────── launchd registry ──────────────────────────────

function uid(): number {
  return process.getuid?.() ?? 501;
}

function serviceTarget(label: string): string {
  return `gui/${uid()}/${label}`;
}

/**
 * Ask launchd whether a job is loaded.
 *
 * Deliberately NOT fail-open. A non-zero exit from `launchctl list` means the
 * label is unknown, which is a legitimate false. A spawn failure (launchctl
 * missing, not executable) means we could not determine anything, and that
 * throws rather than reporting "not registered" — an undetermined probe must
 * never be reported as a clean answer in either direction.
 */
export async function isSchedulerRegistered(label: string = DEFAULT_LABEL): Promise<boolean> {
  // NOT routed through querySystemd on linux, deliberately. `return false`
  // here is the same confident wrong answer #275 is about, but this function
  // takes no injection seam, so a linux case for it would have to run the
  // host's real systemctl — a test whose result is a fact about the machine,
  // which is the #249 shape. Left alone rather than changed untested; the
  // single caller is darwin-gated. See the follow-up noted on #275.
  if (process.platform !== "darwin") return false;
  return queryLaunchd(label);
}

function queryLaunchd(label: string): boolean {
  try {
    execFileSync("launchctl", ["list", label], { stdio: "ignore" });
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number | null };
    // Non-zero exit => launchd answered "no such job".
    if (typeof e.status === "number") return false;
    // Could not run launchctl at all => we do not know. Do not guess.
    throw new Error(`could not query launchd for ${label}: ${e.message}`);
  }
}

// ────────────────────────────── systemd registry ──────────────────────────────

/** States `systemctl is-enabled` prints when it has actually reached systemd. */
const SYSTEMD_ENABLEMENT_STATES = new Set([
  "enabled",
  "enabled-runtime",
  "linked",
  "linked-runtime",
  "alias",
  "masked",
  "masked-runtime",
  "static",
  "indirect",
  "disabled",
  "generated",
  "transient",
  "not-found",
  "bad",
]);

/** Injectable runner so the probe's contract is testable off linux. */
export type SystemdRunner = (file: string, args: string[]) => string;

function runSystemctl(file: string, args: string[]): string {
  return execFileSync(file, args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
}

/**
 * Ask systemd whether a timer is enabled. The linux mirror of queryLaunchd.
 *
 * `existsSync(timer) && existsSync(service)` was the old reading, and it is
 * the exact conflation #259 was filed about: a `.timer` written but never
 * `systemctl --user enable`d sat on disk while systemd had never heard of it
 * and nothing ever fired (#275).
 *
 * Deliberately NOT fail-open, and deliberately NOT a bare exit-status mirror
 * of queryLaunchd either. `systemctl --user is-enabled` exits non-zero for two
 * unrelated reasons:
 *
 *   - systemd answered, and the answer was "disabled" / "not-found". That is a
 *     legitimate false, and the answer word is on stdout.
 *   - systemctl never reached systemd at all — no D-Bus session, which is what
 *     a CI container gives you. Exit status is still 1 and stdout is empty.
 *
 * Treating the second as "not registered" would be a guess dressed as an
 * answer, so the status word on stdout is what decides and anything else
 * throws. That is why this reads stdout rather than the exit code: the exit
 * code's view of the input silently shrinks to "something went wrong", which
 * is the shape .claude/rules/checks-must-be-able-to-fail.md calls a detector
 * narrower than what it detects.
 *
 * The no-D-Bus container therefore surfaces as `probe-failed`, never as `ok`
 * and never as a confident `missing-scheduler`.
 */
export function querySystemd(label: string, run: SystemdRunner = runSystemctl): boolean {
  let out: string;
  try {
    out = run("systemctl", ["--user", "is-enabled", `${label}.timer`]);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number | null; stdout?: Buffer | string };
    const word = (e.stdout?.toString() ?? "").trim().split(/\s+/)[0] ?? "";
    if (typeof e.status === "number" && SYSTEMD_ENABLEMENT_STATES.has(word)) {
      // systemd answered. "disabled", "not-found", "static" — all mean the
      // timer is not going to fire on its own.
      return word === "enabled" || word === "enabled-runtime";
    }
    // Could not reach systemd (no systemctl, no D-Bus session, no user
    // manager). We do not know. Do not guess.
    throw new Error(
      `could not query systemd for ${label}: ${e.message.trim()}` +
        ` (a container with no systemd user session cannot answer this;` +
        ` that is reported as probe-failed, not as "not registered")`,
    );
  }
  const word = out.trim().split(/\s+/)[0] ?? "";
  return word === "enabled" || word === "enabled-runtime";
}

/**
 * The registry reading for this platform, used when no probe is injected.
 *
 * Both arms now ask the platform scheduler rather than the filesystem: launchd
 * on darwin, systemd on linux. The asymmetry this function used to document —
 * darwin asking launchd while linux asked existsSync — was #275.
 */
function defaultRegistryProbe(): (label: string) => boolean {
  if (process.platform === "darwin") return queryLaunchd;
  return (label: string) => querySystemd(label);
}

/**
 * Default executability probe: run the command and let a non-zero exit throw.
 * Capped so a command that hangs cannot hang the install.
 */
function defaultVerify(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: "ignore", timeout: 30_000 });
}

function bootoutQuiet(label: string): void {
  try {
    execFileSync("launchctl", ["bootout", serviceTarget(label)], { stdio: "ignore" });
  } catch {
    // Not loaded. Nothing to remove.
  }
}

function bootstrap(path: string): void {
  execFileSync("launchctl", ["bootstrap", `gui/${uid()}`, path], { stdio: "pipe" });
}

// ───────────────────────────── cross-platform API ─────────────────────────────

function unsupportedPlatform(): Error {
  if (process.platform === "win32") {
    return new Error(
      "Windows scheduling is not implemented yet (see issue #186 — Task Scheduler support). " +
        "Run 'agentgrit daemon run' manually or schedule it with Task Scheduler.",
    );
  }
  return new Error(`Unsupported platform for scheduling: ${process.platform}`);
}

export async function installScheduler(
  config: SchedulerConfig,
  opts: SchedulerOptions = {},
): Promise<void> {
  const paths = resolvePaths({ ...opts, label: opts.label ?? config.label });
  const register = opts.register ?? true;

  // Validate before writing anything. #259's config said "daily" and got a
  // 30-minute timer because this check did not exist.
  const schedule = parseSchedule(config.interval);
  if (!schedule) {
    throw new Error(
      `Unrecognized daemon.interval "${config.interval}". ` +
        `Use daily, hourly, weekly, or a duration like 30m / 2h / 1d.`,
    );
  }

  // Registration is not the same thing as a working daemon, and #259 is the
  // proof that collapsing the two costs weeks of silence. That issue was a
  // plist on disk treated as a scheduled job; this is a scheduled job whose
  // command cannot start. `daemon status` says "Registered: yes" either way,
  // so the only native evidence of failure is an exit code in `launchctl list`
  // and a stack trace in a log nobody opens (#277).
  //
  // So the command is run once, cheaply, BEFORE anything is registered. A
  // refusal here leaves nothing installed, which is the honest outcome: no
  // scheduler is a state the user can see, and a scheduler that fails nightly
  // is one they cannot.
  if (config.verifyArgs) {
    const verify = opts.verify ?? defaultVerify;
    try {
      verify(config.command, config.verifyArgs);
    } catch (err) {
      const e = err as Error & { stderr?: Buffer };
      const detail = e.stderr?.toString().trim() || e.message;
      throw new Error(
        `Refusing to schedule a command that does not run.\n` +
          `  ${[config.command, ...(config.args ?? [])].join(" ")}\n` +
          `The probe '${[config.command, ...config.verifyArgs].join(" ")}' failed: ${detail}\n` +
          `Nothing was installed.`,
      );
    }
  }

  mkdirSync(paths.logDir, { recursive: true });

  if (process.platform === "darwin") {
    mkdirSync(paths.launchAgentDir, { recursive: true });
    const path = plistPath(paths);
    writeFileSync(
      path,
      generatePlist({ ...config, label: paths.label, logDir: paths.logDir }),
    );

    if (!register) return;

    bootoutQuiet(paths.label);
    try {
      bootstrap(path);
    } catch (err) {
      const e = err as Error & { stderr?: Buffer };
      const detail = e.stderr?.toString().trim() || e.message;
      throw new Error(`launchctl bootstrap failed for ${paths.label}: ${detail}`);
    }

    // Verify rather than assume. Writing the file and calling it installed is
    // precisely the bug this issue is about.
    if (!queryLaunchd(paths.label)) {
      throw new Error(
        `Scheduler plist was written to ${path} but launchd did not register ${paths.label}.`,
      );
    }
    return;
  }

  if (process.platform === "linux") {
    mkdirSync(paths.systemdDir, { recursive: true });
    writeFileSync(servicePath(paths), generateSystemdService(config));
    writeFileSync(timerPath(paths), generateSystemdTimer(config));

    if (!register) return;
    try {
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      execFileSync("systemctl", ["--user", "enable", "--now", `${paths.label}.timer`], {
        stdio: "ignore",
      });
    } catch (err) {
      throw new Error(`systemctl enable failed for ${paths.label}: ${(err as Error).message}`);
    }
    return;
  }

  throw unsupportedPlatform();
}

export async function uninstallScheduler(opts: SchedulerOptions = {}): Promise<void> {
  const paths = resolvePaths(opts);

  if (process.platform === "darwin") {
    bootoutQuiet(paths.label);
    const path = plistPath(paths);
    if (existsSync(path)) unlinkSync(path);
    return;
  }

  if (process.platform === "linux") {
    try {
      execFileSync("systemctl", ["--user", "disable", "--now", `${paths.label}.timer`], {
        stdio: "ignore",
      });
    } catch {
      // Not enabled.
    }
    const sPath = servicePath(paths);
    const tPath = timerPath(paths);
    if (existsSync(sPath)) unlinkSync(sPath);
    if (existsSync(tPath)) unlinkSync(tPath);
  }
}

export async function getSchedulerStatus(opts: SchedulerOptions = {}): Promise<SchedulerStatus> {
  const paths = resolvePaths(opts);
  // defaultRegistryProbe(), not queryLaunchd: this defaulted to the launchd
  // query on every platform and then never consulted it off darwin, so an
  // injected probe was silently discarded on linux (#275).
  const probe = opts.probe ?? defaultRegistryProbe();

  const status: SchedulerStatus = {
    installed: false,
    registered: false,
    running: false,
    platform: process.platform,
    label: paths.label,
  };

  if (process.platform === "darwin" || process.platform === "linux") {
    status.installed =
      process.platform === "darwin" ? existsSync(plistPath(paths)) : unitFilesPresent(paths);
    // `status.registered = status.installed` is what the linux arm used to
    // say. That is the line `agentgrit daemon status` prints as
    // "Registered: yes", so two unit files on disk and a timer systemd had
    // never enabled were reported as a running scheduler (#275).
    try {
      status.registered = probe(paths.label);
    } catch {
      status.registered = false;
    }
  }

  const logPath = stdoutPath(paths.logDir);
  if (existsSync(logPath)) {
    status.lastRun = statSync(logPath).mtime.toISOString();
  }

  // "Running" means the platform scheduler holds the job, not that a log file
  // happens to be recent.
  status.running = status.registered;

  return status;
}

// ───────────────────────── the doctor-facing check ─────────────────────────

export type SchedulerCheckStatus =
  | "ok"
  | "not-configured"
  | "missing-scheduler"
  | "plist-not-loaded"
  /**
   * The linux sibling of `plist-not-loaded`: unit files on disk, timer not
   * enabled. A separate name rather than a rename, because the two messages
   * name different commands and `plist-not-loaded` is already matched on by
   * the darwin case (#275).
   */
  | "timer-not-enabled"
  | "stale"
  | "unsupported-platform"
  | "probe-failed";

export interface SchedulerCheckResult {
  ok: boolean;
  status: SchedulerCheckStatus;
  message: string;
  detail: {
    configuredInterval: string | null;
    plistPresent: boolean;
    registered: boolean;
    lastRun: string | null;
    expectedPeriodSeconds: number | null;
    label: string;
    platform: string;
  };
}

/** Minimal shape this check needs; avoids depending on the whole config type. */
export interface SchedulerCheckConfig {
  daemon?: { interval?: string; weeklyDay?: string; autoPrune?: boolean };
}

/**
 * Fail when daemon.interval is configured but no scheduler is actually
 * registered with the platform.
 *
 * This is the check #259 lacked. It distinguishes the states the old
 * existsSync() test collapsed into one, on BOTH platforms (#275):
 *   - no unit/plist at all            -> missing-scheduler
 *   - plist on disk, launchd blind    -> plist-not-loaded    (the #259 mode)
 *   - units on disk, timer not enabled-> timer-not-enabled   (its linux twin)
 *   - registered but not firing       -> stale
 *   - registry unreachable            -> probe-failed
 *
 * Called from `agentgrit daemon status` (bin/commands/daemon.ts) — an earlier
 * version of this comment said "doctor", which has never called it. Not
 * fail-open: if the registry probe cannot answer, that is reported as a
 * failure, never as "ok". On a CI container with no systemd user session that
 * means `probe-failed` and a non-zero exit from `daemon status`, which is the
 * deliberate choice recorded in #275 — "cannot tell" must not read as "fine".
 */
export async function checkSchedulerRegistered(
  config: SchedulerCheckConfig,
  opts: SchedulerOptions = {},
): Promise<SchedulerCheckResult> {
  const paths = resolvePaths(opts);
  const probe = opts.probe ?? defaultRegistryProbe();
  const configured = (config.daemon?.interval ?? "").trim();

  const detail: SchedulerCheckResult["detail"] = {
    configuredInterval: configured || null,
    plistPresent: false,
    registered: false,
    lastRun: null,
    expectedPeriodSeconds: null,
    label: paths.label,
    platform: process.platform,
  };

  if (!configured) {
    return {
      ok: true,
      status: "not-configured",
      message: "daemon.interval is not set; no scheduler expected.",
      detail,
    };
  }

  const schedule = parseSchedule(configured);
  detail.expectedPeriodSeconds = schedule ? schedulePeriodSeconds(schedule) : null;

  if (!schedule) {
    return {
      ok: false,
      status: "missing-scheduler",
      message:
        `daemon.interval is "${configured}", which is not a schedule agentgrit can install. ` +
        `Use daily, hourly, weekly, or a duration like 30m / 2h / 1d.`,
      detail,
    };
  }

  if (process.platform !== "darwin" && process.platform !== "linux") {
    return {
      ok: false,
      status: "unsupported-platform",
      message: unsupportedPlatform().message,
      detail,
    };
  }

  detail.plistPresent =
    process.platform === "darwin" ? existsSync(plistPath(paths)) : unitFilesPresent(paths);

  // The probe is consulted on every supported platform, not just darwin. It
  // used to sit inside `if (platform === "darwin")`, with the else branch
  // assigning `registered = plistPresent` directly — so an injected probe was
  // silently ignored off darwin, and the fail-open guard below could only be
  // exercised on a Mac. That made the guard's own test host-coupled: green
  // locally, red on Linux CI, for a reason that had nothing to do with
  // fail-open handling (#249, #259).
  try {
    detail.registered = probe(paths.label);
  } catch (err) {
    return {
      ok: false,
      status: "probe-failed",
      message: `Could not determine whether ${paths.label} is registered: ${(err as Error).message}`,
      detail,
    };
  }

  const logPath = stdoutPath(paths.logDir);
  if (existsSync(logPath)) {
    detail.lastRun = statSync(logPath).mtime.toISOString();
  }

  if (!detail.registered) {
    if (detail.plistPresent && process.platform === "linux") {
      return {
        ok: false,
        status: "timer-not-enabled",
        message:
          `${timerPath(paths)} and its .service exist but systemd has not enabled ` +
          `${paths.label}.timer. A unit file is not a scheduled job. ` +
          `Run 'agentgrit daemon start' to enable it.`,
        detail,
      };
    }
    if (detail.plistPresent) {
      return {
        ok: false,
        status: "plist-not-loaded",
        message:
          `${plistPath(paths)} exists but launchd has not loaded ${paths.label}. ` +
          `A plist file is not a scheduled job. Run 'agentgrit daemon start' to register it.`,
        detail,
      };
    }
    return {
      ok: false,
      status: "missing-scheduler",
      message:
        `daemon.interval is "${configured}" but no scheduler is registered for ${paths.label}. ` +
        `Nothing will run the daemon. Run 'agentgrit daemon start'.`,
      detail,
    };
  }

  // Registered. If it has run before but not recently enough, say so.
  if (detail.lastRun && detail.expectedPeriodSeconds) {
    const ageSeconds = (Date.now() - new Date(detail.lastRun).getTime()) / 1000;
    const tolerance = detail.expectedPeriodSeconds * 2 + 3600;
    if (ageSeconds > tolerance) {
      return {
        ok: false,
        status: "stale",
        message:
          `${paths.label} is registered but ${logPath} has not been written since ${detail.lastRun} ` +
          `(${Math.floor(ageSeconds / 3600)}h ago, expected every ${Math.round(detail.expectedPeriodSeconds / 3600)}h).`,
        detail,
      };
    }
  }

  return {
    ok: true,
    status: "ok",
    message: `${paths.label} is registered with a "${configured}" schedule.`,
    detail,
  };
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
