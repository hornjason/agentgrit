/**
 * #277: `daemon start` registered a command that could not run.
 *
 * This is #259 one step further out, and the pair is worth holding in mind
 * because the second was invisible until the first was fixed:
 *
 *   #259 — a plist on disk was treated as proof of a scheduled job.
 *   #277 — a registered job is treated as proof of a working daemon.
 *
 * In both, `daemon status` reports success. The only native evidence of #277 is
 * an exit code in `launchctl list` and a stack trace in a log nobody opens.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { installScheduler } from "../../src/daemon/scheduler";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "agentgrit-runnable-"));
}

describe("installScheduler refuses a command that cannot run (#277)", () => {
  test("a failing probe aborts the install and nothing is registered", async () => {
    const root = tempRoot();
    const calls: string[] = [];
    try {
      await expect(
        installScheduler(
          {
            interval: "daily",
            command: "/usr/bin/node",
            args: ["/repo/bin/agentgrit.ts", "daemon", "run"],
            verifyArgs: ["/repo/bin/agentgrit.ts", "--version"],
            label: "com.agentgrit.test.badpair",
          },
          {
            launchAgentDir: join(root, "LaunchAgents"),
            logDir: join(root, "logs"),
            label: "com.agentgrit.test.badpair",
            // Never touch the developer's real launchd. This is not belt and
            // braces: when the refusal is mutated out to prove this case can
            // fail, the install PROCEEDS — and without this flag it proceeded
            // all the way to `launchctl bootstrap`, leaving two real jobs
            // registered on the machine running the battery. A test that
            // mutates its host while proving a point is worse than the bug.
            register: false,
            verify: () => {
              calls.push("verify");
              // The real failure: node cannot resolve the extensionless
              // TypeScript imports in bin/agentgrit.ts.
              throw new Error("ERR_MODULE_NOT_FOUND: /repo/bin/commands/backfill");
            },
            // Unreachable while `register: false` holds, and that is the
            // point: if a later change makes the install reach launchd
            // despite the refusal, this records it and `calls` stops being
            // exactly ["verify"].
            probe: () => {
              calls.push("register");
              return true;
            },
          },
        ),
      ).rejects.toThrow(/does not run/);

      expect(calls).toEqual(["verify"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the refusal names the command, the probe and the cause", async () => {
    const root = tempRoot();
    try {
      let message = "";
      try {
        await installScheduler(
          {
            interval: "daily",
            command: "/usr/bin/node",
            args: ["/repo/bin/agentgrit.ts", "daemon", "run"],
            verifyArgs: ["/repo/bin/agentgrit.ts", "--version"],
            label: "com.agentgrit.test.msg",
          },
          {
            launchAgentDir: join(root, "LaunchAgents"),
            logDir: join(root, "logs"),
            label: "com.agentgrit.test.msg",
            register: false, // see the note on the case above
            verify: () => {
              throw new Error("ERR_MODULE_NOT_FOUND");
            },
          },
        );
      } catch (err) {
        message = (err as Error).message;
      }

      // An operator who cannot see which pair was rejected cannot act on this.
      expect(message).toContain("/usr/bin/node /repo/bin/agentgrit.ts daemon run");
      expect(message).toContain("/usr/bin/node /repo/bin/agentgrit.ts --version");
      expect(message).toContain("ERR_MODULE_NOT_FOUND");
      expect(message).toContain("Nothing was installed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a passing probe does not block the install", async () => {
    const root = tempRoot();
    const calls: string[] = [];
    try {
      await installScheduler(
        {
          interval: "daily",
          command: "/usr/bin/node",
          args: ["/repo/dist/agentgrit.js", "daemon", "run"],
          verifyArgs: ["/repo/dist/agentgrit.js", "--version"],
          label: "com.agentgrit.test.goodpair",
        },
        {
          launchAgentDir: join(root, "LaunchAgents"),
          logDir: join(root, "logs"),
          label: "com.agentgrit.test.goodpair",
          register: false,
          verify: () => {
            calls.push("verify");
          },
        },
      );
      // Without this the first case would pass against an installScheduler
      // that rejects everything, which is a refusal nobody can distinguish
      // from a broken install path.
      expect(calls).toEqual(["verify"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("omitting verifyArgs skips the probe rather than inventing a verdict", async () => {
    const root = tempRoot();
    let verifyCalled = false;
    try {
      await installScheduler(
        {
          interval: "daily",
          command: "/usr/bin/node",
          args: ["/repo/dist/agentgrit.js", "daemon", "run"],
          label: "com.agentgrit.test.noverify",
        },
        {
          launchAgentDir: join(root, "LaunchAgents"),
          logDir: join(root, "logs"),
          label: "com.agentgrit.test.noverify",
          register: false,
          verify: () => {
            verifyCalled = true;
          },
        },
      );
      expect(verifyCalled).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
