import { describe, test, expect } from "bun:test";
import {
  generatePlist,
  generateSystemdService,
  generateSystemdTimer,
} from "../../src/daemon/scheduler";

describe("plist generation", () => {
  test("generates valid XML plist", () => {
    const plist = generatePlist({ interval: "30m", command: "agentgrit daemon run" });

    expect(plist).toContain('<?xml version="1.0"');
    expect(plist).toContain("com.agentgrit.daemon");
    expect(plist).toContain("<integer>1800</integer>");
    expect(plist).toContain("<string>agentgrit</string>");
    expect(plist).toContain("<string>daemon</string>");
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain("<true/>");
  });

  test("respects interval in seconds", () => {
    const plist = generatePlist({ interval: "60s", command: "test" });
    expect(plist).toContain("<integer>60</integer>");
  });

  test("respects interval in hours", () => {
    const plist = generatePlist({ interval: "2h", command: "test" });
    expect(plist).toContain("<integer>7200</integer>");
  });

  test("defaults to 1800s for unrecognized intervals", () => {
    const plist = generatePlist({ interval: "invalid", command: "test" });
    expect(plist).toContain("<integer>1800</integer>");
  });

  test("includes stdout and stderr paths", () => {
    const plist = generatePlist({ interval: "30m", command: "test" });
    expect(plist).toContain("daemon.log");
    expect(plist).toContain("daemon.err");
  });

  test("escapes XML special characters", () => {
    const plist = generatePlist({ interval: "30m", command: "test <arg>" });
    expect(plist).toContain("&lt;arg&gt;");
    expect(plist).not.toContain("<arg>");
  });
});

describe("systemd service generation", () => {
  test("generates valid unit file", () => {
    const service = generateSystemdService({ interval: "30m", command: "agentgrit daemon run" });

    expect(service).toContain("[Unit]");
    expect(service).toContain("[Service]");
    expect(service).toContain("[Install]");
    expect(service).toContain("Type=oneshot");
    expect(service).toContain("ExecStart=agentgrit daemon run");
  });
});

describe("systemd timer generation", () => {
  test("generates valid timer file", () => {
    const timer = generateSystemdTimer({ interval: "30m", command: "test" });

    expect(timer).toContain("[Unit]");
    expect(timer).toContain("[Timer]");
    expect(timer).toContain("[Install]");
    expect(timer).toContain("OnBootSec=30min");
    expect(timer).toContain("OnUnitActiveSec=30min");
    expect(timer).toContain("Persistent=true");
  });

  test("converts seconds interval to minutes", () => {
    const timer = generateSystemdTimer({ interval: "120s", command: "test" });
    expect(timer).toContain("OnUnitActiveSec=2min");
  });

  test("converts hours to minutes", () => {
    const timer = generateSystemdTimer({ interval: "1h", command: "test" });
    expect(timer).toContain("OnUnitActiveSec=60min");
  });

  test("minimum interval is 1 minute", () => {
    const timer = generateSystemdTimer({ interval: "10s", command: "test" });
    expect(timer).toContain("OnUnitActiveSec=1min");
  });
});

describe("install/uninstall/status", () => {
  test("getSchedulerStatus returns platform info", async () => {
    const { getSchedulerStatus } = await import("../../src/daemon/scheduler");
    const status = await getSchedulerStatus();

    expect(status).toHaveProperty("installed");
    expect(status).toHaveProperty("running");
    expect(status).toHaveProperty("platform");
    expect(typeof status.installed).toBe("boolean");
    expect(typeof status.running).toBe("boolean");
  });

  test("uninstallScheduler does not throw on clean system", async () => {
    const { uninstallScheduler } = await import("../../src/daemon/scheduler");
    await expect(uninstallScheduler()).resolves.toBeUndefined();
  });
});
