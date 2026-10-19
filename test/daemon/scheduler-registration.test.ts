/**
 * Scheduler registration tests (issue #259).
 *
 * These cover the gap that let #259 happen: the old implementation wrote a
 * plist file to disk and called that "installed". A file in
 * ~/Library/LaunchAgents is NOT a registered launchd job — launchd only reads
 * that directory at login. The old getSchedulerStatus() asked existsSync() and
 * nothing else, so a plist that launchd had never heard of reported
 * installed: true.
 *
 * Per .claude/rules/checks-must-be-able-to-fail.md, every check here is
 * exercised in BOTH directions: there is a case that makes it go red and a
 * case that makes it go green. The "plist present but not bootstrapped" test
 * is the one that kills the old existsSync-only detector — under the previous
 * implementation that state was indistinguishable from a working scheduler.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";

import {
  parseSchedule,
  generatePlist,
  installScheduler,
  uninstallScheduler,
  getSchedulerStatus,
  checkSchedulerRegistered,
  isSchedulerRegistered,
} from "../../src/daemon/scheduler";

const isDarwin = process.platform === "darwin";
const darwinOnly = isDarwin ? test : test.skip;

const scratch: string[] = [];
const bootstrapped: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "grit-sched-"));
  scratch.push(dir);
  return dir;
}

/** A label unique to this process so parallel agents cannot collide in launchd. */
function testLabel(suffix: string): string {
  return `com.agentgrit.test.${process.pid}.${suffix}`;
}

function bootout(label: string): void {
  try {
    execFileSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${label}`], {
      stdio: "ignore",
    });
  } catch {
    // already gone
  }
}

afterEach(() => {
  while (bootstrapped.length) bootout(bootstrapped.pop()!);
  while (scratch.length) {
    const dir = scratch.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// ───────────────────────── interval parsing ─────────────────────────
//
// The config on the affected machine says `"interval": "daily"`. The old
// regex was /^(\d+)(s|m|h)$/, which does not match "daily", so it silently
// returned 1800. The config and the installed schedule disagreed and nothing
// said so.

describe("parseSchedule", () => {
  test("parses 'daily' — the value in the real config — instead of silently defaulting", () => {
    const schedule = parseSchedule("daily");
    expect(schedule).not.toBeNull();
    expect(schedule!.kind).toBe("calendar");
    if (schedule!.kind !== "calendar") throw new Error("unreachable");
    expect(schedule!.hour).toBe(3);
    expect(schedule!.minute).toBe(0);
    expect(schedule!.weekday).toBeUndefined();
  });

  test("parses 'hourly' and 'weekly'", () => {
    const hourly = parseSchedule("hourly");
    expect(hourly).toEqual({ kind: "interval", seconds: 3600 });

    const weekly = parseSchedule("weekly");
    expect(weekly).not.toBeNull();
    expect(weekly!.kind).toBe("calendar");
    if (weekly!.kind !== "calendar") throw new Error("unreachable");
    expect(weekly!.weekday).toBe(0);
  });

  test("still parses the numeric forms", () => {
    expect(parseSchedule("30m")).toEqual({ kind: "interval", seconds: 1800 });
    expect(parseSchedule("45s")).toEqual({ kind: "interval", seconds: 45 });
    expect(parseSchedule("2h")).toEqual({ kind: "interval", seconds: 7200 });
    expect(parseSchedule("1d")).toEqual({ kind: "interval", seconds: 86400 });
  });

  // The negative half: parseSchedule must be able to say "I do not know".
  test("returns null for genuinely unparseable intervals rather than guessing", () => {
    expect(parseSchedule("fortnightly")).toBeNull();
    expect(parseSchedule("")).toBeNull();
    expect(parseSchedule("30x")).toBeNull();
    expect(parseSchedule("m30")).toBeNull();
  });
});

describe("plist generation honours the parsed schedule", () => {
  test("'daily' emits StartCalendarInterval, not a 30-minute StartInterval", () => {
    const plist = generatePlist({ interval: "daily", command: "/bin/true" });
    expect(plist).toContain("StartCalendarInterval");
    expect(plist).toContain("<key>Hour</key>");
    // The specific regression: "daily" must never become 1800 seconds.
    expect(plist).not.toContain("<key>StartInterval</key>");
    expect(plist).not.toContain("<integer>1800</integer>");
  });

  test("numeric intervals still emit StartInterval", () => {
    const plist = generatePlist({ interval: "15m", command: "/bin/true" });
    expect(plist).toContain("<key>StartInterval</key>");
    expect(plist).toContain("<integer>900</integer>");
    expect(plist).not.toContain("StartCalendarInterval");
  });

  // The old plist wrote to <base>/daemon.log, but every real daemon cycle on
  // the affected machine logged to <base>/logs/daemon.log. The scheduler was
  // pointed at a path nothing else in the system used.
  test("logs are pointed at the logs/ directory that daemon output actually uses", () => {
    const plist = generatePlist({ interval: "daily", command: "/bin/true" });
    expect(plist).toContain(join("logs", "daemon.log"));
    expect(plist).toContain(join("logs", "daemon.err.log"));
  });

  test("an explicit logDir is honoured", () => {
    const plist = generatePlist({ interval: "daily", command: "/bin/true", logDir: "/tmp/grit-x/logs" });
    expect(plist).toContain("<string>/tmp/grit-x/logs/daemon.log</string>");
  });
});

describe("installScheduler rejects what it cannot schedule", () => {
  test("throws on an unparseable interval instead of quietly installing 30m", async () => {
    const root = tempRoot();
    await expect(
      installScheduler(
        { interval: "fortnightly", command: "/bin/true" },
        { launchAgentDir: join(root, "LaunchAgents"), logDir: join(root, "logs"), label: testLabel("badinterval"), register: false },
      ),
    ).rejects.toThrow(/fortnightly/);
  });
});

// ───────────────────── the check that must be able to fail ─────────────────────

describe("checkSchedulerRegistered", () => {
  test("FAILS when daemon.interval is set but nothing is registered", async () => {
    const root = tempRoot();
    const result = await checkSchedulerRegistered(
      { daemon: { interval: "daily", weeklyDay: "sunday" } },
      { launchAgentDir: join(root, "LaunchAgents"), logDir: join(root, "logs"), label: testLabel("absent") },
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("missing-scheduler");
    expect(result.detail.configuredInterval).toBe("daily");
    expect(result.detail.plistPresent).toBe(false);
    expect(result.detail.registered).toBe(false);
  });

  // This is the case the old implementation could not see. A plist sitting in
  // LaunchAgents is inert until launchd is told about it; existsSync() called
  // that success. Deleting the launchctl query from the implementation makes
  // this test go green again, which is exactly the regression it guards.
  darwinOnly("FAILS when the plist exists on disk but was never bootstrapped into launchd", async () => {
    const root = tempRoot();
    const agentDir = join(root, "LaunchAgents");
    const label = testLabel("ondiskonly");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, `${label}.plist`),
      generatePlist({ interval: "daily", command: "/bin/true", label }),
    );

    const result = await checkSchedulerRegistered(
      { daemon: { interval: "daily", weeklyDay: "sunday" } },
      { launchAgentDir: agentDir, logDir: join(root, "logs"), label },
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("plist-not-loaded");
    expect(result.detail.plistPresent).toBe(true);
    expect(result.detail.registered).toBe(false);
    expect(result.message).toMatch(/not loaded|not registered/i);
  });

  // The positive half. A check that can only ever go red is as useless as one
  // that can only ever go green, so prove this one goes green on a real,
  // genuinely bootstrapped launchd job.
  darwinOnly("PASSES against a real registered launchd job", async () => {
    const root = tempRoot();
    const agentDir = join(root, "LaunchAgents");
    const logDir = join(root, "logs");
    const label = testLabel("registered");

    await installScheduler(
      { interval: "60s", command: "/bin/echo registered-probe", label },
      { launchAgentDir: agentDir, logDir, label, register: true },
    );
    bootstrapped.push(label);

    const result = await checkSchedulerRegistered(
      { daemon: { interval: "60s", weeklyDay: "sunday" } },
      { launchAgentDir: agentDir, logDir, label },
    );

    expect(result.detail.registered).toBe(true);
    expect(result.detail.plistPresent).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.ok).toBe(true);
  });

  test("reports not-configured (and does not claim success) when no interval is set", async () => {
    const root = tempRoot();
    const result = await checkSchedulerRegistered(
      { daemon: { interval: "", weeklyDay: "sunday" } },
      { launchAgentDir: join(root, "LaunchAgents"), logDir: join(root, "logs"), label: testLabel("noconfig") },
    );
    expect(result.status).toBe("not-configured");
    expect(result.ok).toBe(true);
  });

  // Fail-open is the amplifier called out in the project rule. If the launchd
  // query itself blows up we must report a problem, never "all clear".
  test("is not fail-open: a broken registry probe reports failure, not success", async () => {
    const root = tempRoot();
    const result = await checkSchedulerRegistered(
      { daemon: { interval: "daily", weeklyDay: "sunday" } },
      {
        launchAgentDir: join(root, "LaunchAgents"),
        logDir: join(root, "logs"),
        label: testLabel("probeboom"),
        probe: () => {
          throw new Error("launchctl exploded");
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("probe-failed");
    expect(result.message).toMatch(/launchctl exploded/);
  });
});

describe("isSchedulerRegistered", () => {
  darwinOnly("returns false for a label launchd has never heard of", async () => {
    expect(await isSchedulerRegistered(testLabel("neverexisted"))).toBe(false);
  });
});

// ───────────────────── install actually registers (AC2) ─────────────────────

describe("installScheduler registers with launchd, not just the filesystem", () => {
  darwinOnly("writes the plist AND bootstraps it so launchctl can see it", async () => {
    const root = tempRoot();
    const agentDir = join(root, "LaunchAgents");
    const logDir = join(root, "logs");
    const label = testLabel("install");

    await installScheduler(
      { interval: "60s", command: "/bin/echo install-probe", label },
      { launchAgentDir: agentDir, logDir, label, register: true },
    );
    bootstrapped.push(label);

    expect(existsSync(join(agentDir, `${label}.plist`))).toBe(true);
    expect(await isSchedulerRegistered(label)).toBe(true);

    const status = await getSchedulerStatus({ launchAgentDir: agentDir, logDir, label });
    expect(status.installed).toBe(true);
    expect(status.registered).toBe(true);
  });

  darwinOnly("uninstall removes it from launchd as well as from disk", async () => {
    const root = tempRoot();
    const agentDir = join(root, "LaunchAgents");
    const logDir = join(root, "logs");
    const label = testLabel("uninstall");

    await installScheduler(
      { interval: "60s", command: "/bin/echo uninstall-probe", label },
      { launchAgentDir: agentDir, logDir, label, register: true },
    );
    expect(await isSchedulerRegistered(label)).toBe(true);

    await uninstallScheduler({ launchAgentDir: agentDir, logDir, label });

    expect(existsSync(join(agentDir, `${label}.plist`))).toBe(false);
    expect(await isSchedulerRegistered(label)).toBe(false);
  });
});

// ───────────────── a scheduled cycle actually fires (AC4) ─────────────────
//
// AC2 and AC3 can both be satisfied by something that never runs. This test
// installs a real 10-second scheduler under a test-only label in a temp
// directory, then waits. Nothing invokes the command; if the log gains a line,
// launchd fired it.

describe("scheduled execution", () => {
  darwinOnly(
    "a registered scheduler writes to its log without any manual invocation",
    async () => {
      const root = tempRoot();
      const agentDir = join(root, "LaunchAgents");
      const logDir = join(root, "logs");
      const label = testLabel("tick");
      const logPath = join(logDir, "daemon.log");

      await installScheduler(
        {
          interval: "10s",
          command: "/bin/date +scheduled-tick-%Y-%m-%dT%H:%M:%S",
          label,
        },
        { launchAgentDir: agentDir, logDir, label, register: true, runAtLoad: false },
      );
      bootstrapped.push(label);

      const deadline = Date.now() + 40_000;
      let contents = "";
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        if (existsSync(logPath)) {
          contents = readFileSync(logPath, "utf-8");
          if (contents.includes("scheduled-tick-")) break;
        }
      }

      expect(contents).toContain("scheduled-tick-");
    },
    60_000,
  );
});
