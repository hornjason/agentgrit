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
  querySystemd,
  generateSystemdService,
  generateSystemdTimer,
} from "../../src/daemon/scheduler";

const isDarwin = process.platform === "darwin";
const darwinOnly = isDarwin ? test : test.skip;

/**
 * Run a body with `process.platform` forced to a value (#275).
 *
 * The linux reading is the one CI exercises (every workflow is
 * `runs-on: ubuntu-latest`) and the one a developer on a Mac can never reach.
 * Gating the linux cases behind `linuxOnly` would mean each half of this
 * module is only ever checked on the platform where the other half is the
 * live code — and the darwin half would stop being checked at all once it
 * mattered. Forcing the branch instead means both readings are exercised on
 * every run, everywhere.
 *
 * This stubs the branch selector only. Anything that actually shells out to
 * `systemctl` still behaves like the host, which is why the default-probe case
 * below asserts "not ok" rather than a single status.
 */
const REAL_PLATFORM = process.platform;

function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", {
    value,
    configurable: true,
    writable: true,
    enumerable: true,
  });
}

async function withPlatform<T>(value: string, body: () => Promise<T>): Promise<T> {
  setPlatform(value);
  try {
    return await body();
  } finally {
    setPlatform(REAL_PLATFORM);
  }
}

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

/**
 * Write a `.timer` and `.service` pair into a scoped systemd dir and return it.
 *
 * This is the state #275 is about: both unit files on disk, nothing enabled.
 * It could not be set up at all before `systemdDir` became overridable —
 * the path was hardcoded to ~/.config/systemd/user, so the only way to write
 * these files was into the developer's real systemd directory.
 */
function writeUnits(root: string, label: string): string {
  const unitDir = join(root, "systemd");
  mkdirSync(unitDir, { recursive: true });
  const config = { interval: "daily", command: "/bin/true", label };
  writeFileSync(join(unitDir, `${label}.service`), generateSystemdService(config));
  writeFileSync(join(unitDir, `${label}.timer`), generateSystemdTimer(config));
  return unitDir;
}

/** An execFileSync-shaped failure: numeric exit status plus captured stdout. */
function execFailure(status: number, stdout: string, stderr = ""): Error {
  const e = new Error(`Command failed: systemctl`) as Error & {
    status: number;
    stdout: Buffer;
    stderr: Buffer;
  };
  e.status = status;
  e.stdout = Buffer.from(stdout);
  e.stderr = Buffer.from(stderr);
  return e;
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
        { launchAgentDir: join(root, "LaunchAgents"), systemdDir: join(root, "systemd"), logDir: join(root, "logs"), label: testLabel("badinterval"), register: false },
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
      { launchAgentDir: join(root, "LaunchAgents"), systemdDir: join(root, "systemd"), logDir: join(root, "logs"), label: testLabel("absent") },
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
      { launchAgentDir: agentDir, systemdDir: join(root, "systemd"), logDir: join(root, "logs"), label },
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
      { launchAgentDir: agentDir, systemdDir: join(root, "systemd"), logDir, label, register: true },
    );
    bootstrapped.push(label);

    const result = await checkSchedulerRegistered(
      { daemon: { interval: "60s", weeklyDay: "sunday" } },
      { launchAgentDir: agentDir, systemdDir: join(root, "systemd"), logDir, label },
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
      { launchAgentDir: join(root, "LaunchAgents"), systemdDir: join(root, "systemd"), logDir: join(root, "logs"), label: testLabel("noconfig") },
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
        launchAgentDir: join(root, "LaunchAgents"), systemdDir: join(root, "systemd"),
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

  test("still returns false on a platform with no scheduler at all", async () => {
    await withPlatform("win32", async () => {
      expect(await isSchedulerRegistered(testLabel("nowhere"))).toBe(false);
    });
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
      { launchAgentDir: agentDir, systemdDir: join(root, "systemd"), logDir, label, register: true },
    );
    bootstrapped.push(label);

    expect(existsSync(join(agentDir, `${label}.plist`))).toBe(true);
    expect(await isSchedulerRegistered(label)).toBe(true);

    const status = await getSchedulerStatus({ launchAgentDir: agentDir, systemdDir: join(root, "systemd"), logDir, label });
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
      { launchAgentDir: agentDir, systemdDir: join(root, "systemd"), logDir, label, register: true },
    );
    expect(await isSchedulerRegistered(label)).toBe(true);

    await uninstallScheduler({ launchAgentDir: agentDir, systemdDir: join(root, "systemd"), logDir, label });

    expect(existsSync(join(agentDir, `${label}.plist`))).toBe(false);
    expect(await isSchedulerRegistered(label)).toBe(false);
  });
});

// ───────── the systemd reading asks systemd, not the filesystem (#275) ─────────
//
// #259 was "a plist file is not a scheduled job". The same conflation survived
// on the systemd side: a `.timer` and a `.service` written but never
// `systemctl --user enable`d read as registered, and the daemon silently never
// ran. `plistPresent` and `registered` were computed from the same two
// existsSync calls, so no input could make them differ and any test asserting
// the distinction passed vacuously.

describe("getSchedulerStatus consults the registry on linux (#275)", () => {
  test("an injected probe decides `registered`, overriding what is on disk", async () => {
    await withPlatform("linux", async () => {
      const root = tempRoot();
      const status = await getSchedulerStatus({
        launchAgentDir: join(root, "LaunchAgents"), systemdDir: join(root, "systemd"),
        logDir: join(root, "logs"),
        label: testLabel("statusprobe"),
        probe: () => true,
      });

      // No unit files exist for this label, so `installed` is false. Before
      // #275 the linux branch assigned `registered = installed` outright and
      // never looked at the probe, which made this false too.
      expect(status.installed).toBe(false);
      expect(status.registered).toBe(true);
    });
  });

  test("a probe saying no beats unit files saying yes", async () => {
    await withPlatform("linux", async () => {
      const root = tempRoot();
      const label = testLabel("statusprobeno");
      const unitDir = writeUnits(root, label);

      const status = await getSchedulerStatus({
        launchAgentDir: join(root, "LaunchAgents"),
        systemdDir: unitDir,
        logDir: join(root, "logs"),
        label,
        probe: () => false,
      });

      // Both unit files are on disk. `installed` says so; `registered` must
      // not. `status.registered = status.installed` — the line this replaced
      // — makes both of these true, which is what `agentgrit daemon status`
      // printed as "Registered: yes" for a timer systemd had never enabled.
      expect(status.installed).toBe(true);
      expect(status.registered).toBe(false);
      expect(status.running).toBe(false);
    });
  });
});

describe("querySystemd mirrors queryLaunchd's contract (#275)", () => {
  test("exit 0 with 'enabled' on stdout is registered", () => {
    expect(querySystemd("x", () => "enabled\n")).toBe(true);
  });

  test("'disabled' is a real answer from systemd, so it is a plain false", () => {
    expect(
      querySystemd("x", () => {
        throw execFailure(1, "disabled\n");
      }),
    ).toBe(false);
  });

  test("'static' and 'not-found' are answers too — not-enabled, not undetermined", () => {
    for (const word of ["static", "not-found", "masked", "indirect"]) {
      expect(
        querySystemd("x", () => {
          throw execFailure(1, `${word}\n`);
        }),
      ).toBe(false);
    }
  });

  // The CI question #275 asks to decide deliberately. Every workflow in
  // .github/workflows is `runs-on: ubuntu-latest`, so this path runs on every
  // push. `systemctl --user` in a container with no D-Bus session exits 1 with
  // NOTHING on stdout — indistinguishable, by exit code alone, from a genuine
  // "disabled". Mirroring launchd's exit-status contract literally would have
  // turned that into a confident "not registered".
  test("a non-zero exit with no status word — the no-D-Bus container — THROWS", () => {
    expect(() =>
      querySystemd("x", () => {
        throw execFailure(1, "", "Failed to connect to bus: No medium found");
      }),
    ).toThrow(/could not query systemd/);
  });

  test("systemctl missing entirely throws rather than reporting not-registered", () => {
    expect(() =>
      querySystemd("x", () => {
        const e = new Error('Executable not found in $PATH: "systemctl"') as NodeJS.ErrnoException;
        e.code = "ENOENT";
        throw e;
      }),
    ).toThrow(/could not query systemd/);
  });
});

describe("checkSchedulerRegistered on linux (#275)", () => {
  // The linux twin of "the plist exists on disk but was never bootstrapped".
  // Before #275 this state reported ok: the default probe was the same two
  // existsSync calls that set plistPresent, so the two could not disagree.
  test("FAILS when the unit files exist but the timer was never enabled", async () => {
    await withPlatform("linux", async () => {
      const root = tempRoot();
      const label = testLabel("unitsnotenabled");
      const unitDir = writeUnits(root, label);

      const result = await checkSchedulerRegistered(
        { daemon: { interval: "daily", weeklyDay: "sunday" } },
        {
          launchAgentDir: join(root, "LaunchAgents"),
          systemdDir: unitDir,
          logDir: join(root, "logs"),
          label,
          probe: () => false,
        },
      );

      expect(result.ok).toBe(false);
      expect(result.status).toBe("timer-not-enabled");
      expect(result.detail.plistPresent).toBe(true);
      expect(result.detail.registered).toBe(false);
      expect(result.message).toMatch(/not enabled/i);
    });
  });

  // The other direction of the same disagreement. plistPresent false while
  // registered is true proves the two readings are genuinely independent
  // rather than one being an alias of the other.
  test("units absent but the timer enabled is ok — the readings are independent", async () => {
    await withPlatform("linux", async () => {
      const root = tempRoot();
      const result = await checkSchedulerRegistered(
        { daemon: { interval: "daily", weeklyDay: "sunday" } },
        {
          launchAgentDir: join(root, "LaunchAgents"),
          systemdDir: join(root, "systemd"),
          logDir: join(root, "logs"),
          label: testLabel("enabledonly"),
          probe: () => true,
        },
      );

      expect(result.detail.plistPresent).toBe(false);
      expect(result.detail.registered).toBe(true);
      expect(result.status).toBe("ok");
    });
  });

  test("FAILS with missing-scheduler when there are no units and nothing enabled", async () => {
    await withPlatform("linux", async () => {
      const root = tempRoot();
      const result = await checkSchedulerRegistered(
        { daemon: { interval: "daily", weeklyDay: "sunday" } },
        {
          launchAgentDir: join(root, "LaunchAgents"),
          systemdDir: join(root, "systemd"),
          logDir: join(root, "logs"),
          label: testLabel("linuxabsent"),
          probe: () => false,
        },
      );

      expect(result.status).toBe("missing-scheduler");
    });
  });

  // The cases above inject a probe, so none of them would notice the default
  // probe being reverted to `existsSync(timer) && existsSync(service)`. This
  // one injects nothing. Two unit files are on disk under a label systemd has
  // never heard of, so the old default answers "registered" and the whole
  // check reports ok. The real `systemctl` cannot say "enabled" here on any
  // host: absent on darwin (ENOENT -> probe-failed), and on Linux CI either
  // no D-Bus (probe-failed) or "not-found" (timer-not-enabled). What it must
  // never be is ok.
  test("the DEFAULT probe does not accept unit files on disk as registration", async () => {
    await withPlatform("linux", async () => {
      const root = tempRoot();
      const label = testLabel("defaultprobe");
      const unitDir = writeUnits(root, label);

      const result = await checkSchedulerRegistered(
        { daemon: { interval: "daily", weeklyDay: "sunday" } },
        {
          launchAgentDir: join(root, "LaunchAgents"),
          systemdDir: unitDir,
          logDir: join(root, "logs"),
          label,
        },
      );

      expect(result.detail.plistPresent).toBe(true);
      expect(result.ok).toBe(false);
      expect(["probe-failed", "timer-not-enabled"]).toContain(result.status);
    });
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
        { launchAgentDir: agentDir, systemdDir: join(root, "systemd"), logDir, label, register: true, runAtLoad: false },
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
