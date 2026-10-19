/**
 * #281: a test reached the developer's real launchd job and deleted it.
 *
 * `uninstallScheduler()` takes every argument optionally, so reaching the real
 * scheduler is what you get by passing nothing at all — and a suite that does
 * that is green, silent, and has edited the machine. The live
 * `com.agentgrit.daemon` job and its plist were removed by one such call, and
 * the only evidence was a kickstart failing an hour later.
 *
 * `hostSchedulerEscape` is the single binding that decides, so there is one
 * thing to mutate and these cases point at the decision rather than at a
 * message someone could reword.
 */
import { describe, expect, test } from "bun:test";
import { homedir } from "os";
import { join } from "path";
import { hostSchedulerEscape } from "../../src/daemon/scheduler";

const REAL_DIR = join(homedir(), "Library", "LaunchAgents");

describe("tests cannot reach the real scheduler (#281)", () => {
  test("the no-argument call — the one that caused this — is refused", () => {
    const escape = hostSchedulerEscape({}, "test");
    expect(escape).not.toBeNull();
    expect(escape).toContain("com.agentgrit.daemon");
    expect(escape).toContain(REAL_DIR);
  });

  // The two cases below replace a pair that asserted each of these was
  // ALLOWED. They were written with the first version of the guard and they
  // encoded its hole as intended behaviour — a check certifying the defect it
  // was written to block. Both are now refusals (#283).

  test("scoping only the directory is refused: launchd is addressed by label", () => {
    // The HIGH one. `uninstallScheduler({ launchAgentDir: "/tmp/x" })` keeps
    // DEFAULT_LABEL, and `bootoutQuiet(label)` removes the live launchd job
    // no matter which directory the plist was written to. The unlink lands
    // harmlessly in /tmp; the bootout has already happened.
    const escape = hostSchedulerEscape(
      { launchAgentDir: "/tmp/agentgrit-scoped", logDir: "/tmp/agentgrit-scoped/logs" },
      "test",
    );
    expect(escape).not.toBeNull();
    expect(escape).toContain("com.agentgrit.daemon");
  });

  test("scoping only the label is refused: the plist lands in the user's real dir", () => {
    const escape = hostSchedulerEscape(
      { label: "com.agentgrit.test.scoped", logDir: "/tmp/agentgrit-scoped/logs" },
      "test",
    );
    expect(escape).not.toBeNull();
    expect(escape).toContain(REAL_DIR);
  });

  test("a real logDir is refused on its own", () => {
    const escape = hostSchedulerEscape(
      { label: "com.agentgrit.test.scoped", launchAgentDir: "/tmp/agentgrit-scoped" },
      "test",
    );
    expect(escape).not.toBeNull();
    expect(escape).toContain("logDir");
  });

  test("the real directory spelled differently is still the real directory", () => {
    // A guard comparing strings rather than paths is bypassed by a trailing
    // slash, a `..`, or a symlink — the comparison has to be by value.
    const escape = hostSchedulerEscape(
      {
        label: "com.agentgrit.test.scoped",
        launchAgentDir: `${REAL_DIR}/`,
        logDir: "/tmp/agentgrit-scoped/logs",
      },
      "test",
    );
    expect(escape).not.toBeNull();
    expect(escape).toContain(REAL_DIR);
  });

  test("all three scoped is allowed — the guard is not simply a refusal", () => {
    expect(
      hostSchedulerEscape(
        {
          label: "com.agentgrit.test.scoped",
          launchAgentDir: "/tmp/agentgrit-scoped",
          logDir: "/tmp/agentgrit-scoped/logs",
        },
        "test",
      ),
    ).toBeNull();
  });

  test("outside a test run the real scheduler is reachable, which is the point of it", () => {
    // Without this the guard could be `return "refused"` for every caller and
    // the three cases above would still pass — and `agentgrit daemon start`
    // would be dead. This is the case that says the guard is scoped rather
    // than absolute.
    //
    // `null`, not `undefined`, for the unset case: a default parameter is
    // applied when the argument is `undefined`, so passing `undefined` reads
    // process.env.NODE_ENV — which is "test" in here — and this case failed
    // against correct code until the signature could express "no NODE_ENV".
    expect(hostSchedulerEscape({}, null)).toBeNull();
    expect(hostSchedulerEscape({}, "production")).toBeNull();
  });

  test("the live suite cannot construct the refused combination by accident", async () => {
    // The guard is only worth having if it fires through the real entry
    // points, not merely when called directly. NODE_ENV is "test" here, so a
    // no-argument uninstall must throw rather than touch the host.
    const { uninstallScheduler } = await import("../../src/daemon/scheduler");
    await expect(uninstallScheduler()).rejects.toThrow(/Refusing to touch the real scheduler/);
  });
});
