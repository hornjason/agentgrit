/**
 * #285: the scheduled job ran with launchd's minimal PATH, so the daemon's
 * test-cache step reported `spawnSync bun ENOENT` on every cycle while the
 * identical command worked fine from a terminal.
 *
 * `launchctl getenv PATH` is empty on a default install and a job inherits
 * `/usr/bin:/bin:/usr/sbin:/sbin`. `bun` lives in /opt/homebrew/bin.
 */
import { describe, expect, test } from "bun:test";
import { generatePlist, generateSystemdService, schedulerPath } from "../../src/daemon/scheduler";

const LAUNCHD_DEFAULT = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

describe("the scheduled job gets a usable PATH (#285)", () => {
  test("the captured PATH is carried through", () => {
    const path = schedulerPath("/opt/homebrew/bin:/usr/local/bin");
    expect(path.split(":")).toContain("/opt/homebrew/bin");
    expect(path.split(":")).toContain("/usr/local/bin");
  });

  test("launchd's own defaults are appended, not replaced", () => {
    // A captured PATH can go stale — a homebrew prefix that moved, a version
    // manager shim that was uninstalled. Keeping the system directories on
    // the end means the job degrades to what it would have had anyway rather
    // than to nothing.
    const entries = schedulerPath("/opt/homebrew/bin").split(":");
    for (const dir of LAUNCHD_DEFAULT) expect(entries).toContain(dir);
  });

  test("an absent or empty PATH falls back to launchd's default, not to empty", () => {
    // An empty PATH string in the plist is worse than no PATH key at all: it
    // would take away the four directories the job used to have.
    expect(schedulerPath("")).toBe(LAUNCHD_DEFAULT.join(":"));
    expect(schedulerPath("   ")).toBe(LAUNCHD_DEFAULT.join(":"));
  });

  test("no directory is listed twice", () => {
    const entries = schedulerPath("/usr/bin:/opt/homebrew/bin:/bin").split(":");
    expect(new Set(entries).size).toBe(entries.length);
  });

  test("the plist carries the PATH where launchd will read it", () => {
    const plist = generatePlist({
      interval: "daily",
      command: "/usr/bin/node",
      args: ["/x/agentgrit.js", "daemon", "run"],
      path: "/opt/homebrew/bin",
      label: "com.agentgrit.test.path",
      logDir: "/tmp/agentgrit-test-logs",
    });
    // The key has to be EnvironmentVariables — launchd ignores anything else,
    // so asserting the string appears somewhere in the file would pass over a
    // plist that sets nothing.
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    const envBlock = plist.slice(plist.indexOf("<key>EnvironmentVariables</key>"));
    expect(envBlock).toContain("<key>PATH</key>");
    expect(envBlock).toContain("/opt/homebrew/bin");
  });

  test("the systemd unit carries it too", () => {
    const unit = generateSystemdService({
      interval: "daily",
      command: "/usr/bin/node /x/agentgrit.js daemon run",
      path: "/opt/homebrew/bin",
    });
    const service = unit.slice(unit.indexOf("[Service]"));
    expect(service).toContain("Environment=PATH=");
    expect(service).toContain("/opt/homebrew/bin");
  });
});
