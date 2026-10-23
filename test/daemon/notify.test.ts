import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  decideNotification,
  sendNotification,
  runNotify,
  EMPTY_NOTIFY_STATE,
  type NotifyState,
} from "../../src/daemon/notify";
import { runDoctor, type DoctorReport, type CheckStatus } from "../../src/daemon/doctor";
import type { AgentGritConfig } from "../../src/adapters/types";
import { formatCycleHeader } from "../../bin/commands/daemon";

const DAY1 = new Date(2026, 9, 23, 9, 0);
const DAY1_LATER = new Date(2026, 9, 23, 9, 30);
const DAY2 = new Date(2026, 9, 24, 9, 0);

function doctor(...checks: Array<[section: string, name: string, status: CheckStatus, message?: string]>): DoctorReport {
  const sections = new Map<string, DoctorReport["sections"][number]>();
  for (const [section, name, status, message] of checks) {
    const s = sections.get(section) ?? { name: section, status: "ok" as CheckStatus, checks: [] };
    s.checks.push({ name, status, message: message ?? `${name} ${status}` });
    sections.set(section, s);
  }
  return { timestamp: DAY1.toISOString(), overall: "ok", sections: [...sections.values()] };
}

const HEALTHY = doctor(["HEALTH", "context-freshness", "ok"]);

describe("decideNotification", () => {
  test("a healthy cycle on a day with no message yet sends the heartbeat", () => {
    const d = decideNotification({ cycleErrors: [], doctor: HEALTHY, now: DAY1 }, EMPTY_NOTIFY_STATE);
    expect(d.kind).toBe("heartbeat");
    expect(d.state.lastHeartbeatDay).toBe("2026-10-23");
  });

  test("the heartbeat fires at most once per calendar day", () => {
    const first = decideNotification({ cycleErrors: [], doctor: HEALTHY, now: DAY1 }, EMPTY_NOTIFY_STATE);
    const second = decideNotification({ cycleErrors: [], doctor: HEALTHY, now: DAY1_LATER }, first.state);
    expect(second.kind).toBe("none");
    const nextDay = decideNotification({ cycleErrors: [], doctor: HEALTHY, now: DAY2 }, second.state);
    expect(nextDay.kind).toBe("heartbeat");
  });

  test("a cycle error alerts once, with the full error text in the body", () => {
    const d = decideNotification(
      { cycleErrors: ["test-cache: spawnSync bun ETIMEDOUT"], doctor: HEALTHY, now: DAY1 },
      EMPTY_NOTIFY_STATE,
    );
    expect(d.kind).toBe("alert");
    expect(d.body).toContain("test-cache: spawnSync bun ETIMEDOUT");
  });

  test("a doctor error alerts; a doctor warning does not", () => {
    const err = decideNotification(
      { cycleErrors: [], doctor: doctor(["WIRING", "hooks", "error", "hook missing"]), now: DAY1 },
      EMPTY_NOTIFY_STATE,
    );
    expect(err.kind).toBe("alert");
    expect(err.body).toContain("WIRING/hooks: hook missing");

    const warn = decideNotification(
      { cycleErrors: [], doctor: doctor(["WIRING", "hooks", "warning"]), now: DAY1 },
      EMPTY_NOTIFY_STATE,
    );
    expect(warn.kind).toBe("heartbeat");
  });

  test("a CAPTURE warning alerts: a stale signal file means a hook stopped firing", () => {
    const d = decideNotification(
      { cycleErrors: [], doctor: doctor(["CAPTURE", "ratings.jsonl", "warning", "ratings.jsonl last modified 20d ago — hook may not be firing"]), now: DAY1 },
      EMPTY_NOTIFY_STATE,
    );
    expect(d.kind).toBe("alert");
    expect(d.body).toContain("CAPTURE/ratings.jsonl");
  });

  test("an identical failure on the next cycle sends nothing", () => {
    const input = { cycleErrors: ["test-cache: spawnSync bun ETIMEDOUT"], doctor: HEALTHY, now: DAY1 };
    const first = decideNotification(input, EMPTY_NOTIFY_STATE);
    const second = decideNotification({ ...input, now: DAY1_LATER }, first.state);
    expect(second.kind).toBe("none");
  });

  test("the same failing step with different detail is the same failure", () => {
    const first = decideNotification(
      { cycleErrors: ["test-cache: spawnSync bun ENOENT"], doctor: HEALTHY, now: DAY1 },
      EMPTY_NOTIFY_STATE,
    );
    const second = decideNotification(
      { cycleErrors: ["test-cache: spawnSync bun ETIMEDOUT"], doctor: HEALTHY, now: DAY1_LATER },
      first.state,
    );
    expect(second.kind).toBe("none");
  });

  test("a different failure set alerts again", () => {
    const first = decideNotification(
      { cycleErrors: ["test-cache: x"], doctor: HEALTHY, now: DAY1 },
      EMPTY_NOTIFY_STATE,
    );
    const second = decideNotification(
      { cycleErrors: ["test-cache: x", "dashboard-export: y"], doctor: HEALTHY, now: DAY1_LATER },
      first.state,
    );
    expect(second.kind).toBe("alert");
  });

  test("a clean cycle after a failure sends one recovered, then nothing that day", () => {
    const failed = decideNotification({ cycleErrors: ["test-cache: x"], doctor: HEALTHY, now: DAY1 }, EMPTY_NOTIFY_STATE);
    const recovered = decideNotification({ cycleErrors: [], doctor: HEALTHY, now: DAY1_LATER }, failed.state);
    expect(recovered.kind).toBe("recovered");
    const after = decideNotification({ cycleErrors: [], doctor: HEALTHY, now: new Date(2026, 9, 23, 10, 0) }, recovered.state);
    expect(after.kind).toBe("none");
  });

  test("no heartbeat on a day a failure alert was sent", () => {
    const alertState: NotifyState = { errorKey: null, lastAlertDay: "2026-10-23", lastHeartbeatDay: null };
    const d = decideNotification({ cycleErrors: [], doctor: HEALTHY, now: DAY1_LATER }, alertState);
    expect(d.kind).toBe("none");
  });

  test("a failure still present on a new day alerts once more, so silence never means failing", () => {
    const first = decideNotification({ cycleErrors: ["test-cache: x"], doctor: HEALTHY, now: DAY1 }, EMPTY_NOTIFY_STATE);
    const nextDay = decideNotification({ cycleErrors: ["test-cache: x"], doctor: HEALTHY, now: DAY2 }, first.state);
    expect(nextDay.kind).toBe("alert");
    expect(nextDay.title).toContain("still failing");
  });
});

describe("stale capture hooks, through the real doctor", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ag-notify-capture-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const SIGNALS = ["ratings.jsonl", "corrections.jsonl", "sentiment.jsonl", "skills.jsonl"];
  const configFor = (signalDir: string) =>
    ({
      signalDir,
      adapter: "local",
      rubrics: [],
      rules: { globalBudget: 25, projectBudget: 25, autoPromote: false },
      daemon: { interval: "30m", weeklyDay: "sunday" },
    }) as AgentGritConfig;

  async function decideWith(staleDays: Record<string, number>) {
    for (const f of SIGNALS) {
      const p = join(dir, f);
      writeFileSync(p, "{}\n");
      const age = (staleDays[f] ?? 0) * 86_400_000;
      const t = new Date(Date.now() - age);
      utimesSync(p, t, t);
    }
    const report = await runDoctor(configFor(dir));
    return decideNotification({ cycleErrors: [], doctor: report, now: new Date() }, EMPTY_NOTIFY_STATE);
  }

  test("a signal file untouched for 20 days alerts and names the file", async () => {
    const d = await decideWith({ "ratings.jsonl": 20 });
    expect(d.kind).toBe("alert");
    expect(d.body).toContain("CAPTURE/ratings.jsonl");
    expect(d.body).toContain("hook may not be firing");
  });

  test("fresh signal files raise no CAPTURE failure", async () => {
    const d = await decideWith({});
    expect(d.body ?? "").not.toContain("CAPTURE/");
  });
});

describe("sendNotification", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ag-notify-send-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("passes title and body as env vars and the body on stdin", () => {
    const out = join(dir, "out");
    const r = sendNotification(
      `printf '%s|%s|' "$AGENTGRIT_NOTIFY_TITLE" "$AGENTGRIT_NOTIFY_BODY" > '${out}'; cat >> '${out}'`,
      "T", "B",
    );
    expect(r.ok).toBe(true);
    expect(readFileSync(out, "utf-8")).toBe("T|B|B");
  });

  test("a failing command is reported, never thrown", () => {
    const r = sendNotification("exit 3", "T", "B");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("3");
  });

  test("a hanging command is cut off at the timeout", () => {
    const start = Date.now();
    const r = sendNotification("sleep 5", "T", "B", 300);
    expect(r.ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(3000);
  });
});

describe("runNotify", () => {
  let home: string;
  let prevDir: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ag-notify-run-"));
    prevDir = process.env.AGENTGRIT_DIR;
    process.env.AGENTGRIT_DIR = home;
  });
  afterEach(() => {
    if (prevDir === undefined) delete process.env.AGENTGRIT_DIR;
    else process.env.AGENTGRIT_DIR = prevDir;
    rmSync(home, { recursive: true, force: true });
  });

  const config = (command?: string) =>
    ({ daemon: { interval: "30m", weeklyDay: "sunday" }, ...(command ? { notify: { command } } : {}) }) as unknown as AgentGritConfig;

  test("with notify.command unset, nothing runs and no state is written", async () => {
    let doctorRan = false;
    const r = await runNotify(config(), ["test-cache: x"], {
      now: DAY1,
      runDoctor: async () => { doctorRan = true; return HEALTHY; },
    });
    expect(r.sent).toBe(false);
    expect(doctorRan).toBe(false);
    expect(existsSync(join(home, "state", "notify-state.json"))).toBe(false);
  });

  test("calls the command once per new failure and persists the dedup state", async () => {
    const log = join(home, "calls");
    const cfg = config(`echo "$AGENTGRIT_NOTIFY_TITLE" >> '${log}'`);
    const opts = { now: DAY1, runDoctor: async () => HEALTHY };

    const first = await runNotify(cfg, ["test-cache: x"], opts);
    expect(first.kind).toBe("alert");
    expect(first.sent).toBe(true);
    const second = await runNotify(cfg, ["test-cache: x"], { ...opts, now: DAY1_LATER });
    expect(second.kind).toBe("none");

    expect(readFileSync(log, "utf-8").trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(home, "state", "notify-state.json"), "utf-8")).errorKey).toBe("cycle:test-cache");
  });

  test("a notifier that fails does not throw and does not advance the state", async () => {
    const cfg = config("exit 1");
    const r = await runNotify(cfg, ["test-cache: x"], { now: DAY1, runDoctor: async () => HEALTHY });
    expect(r.sent).toBe(false);
    expect(r.error).toBeTruthy();
    expect(existsSync(join(home, "state", "notify-state.json"))).toBe(false);
  });

  test("a doctor that throws is itself reported as a failure", async () => {
    const log = join(home, "calls");
    const r = await runNotify(config(`cat >> '${log}'`), [], {
      now: DAY1,
      runDoctor: async () => { throw new Error("boom"); },
    });
    expect(r.kind).toBe("alert");
    expect(readFileSync(log, "utf-8")).toContain("doctor: boom");
  });
});

describe("daemon log", () => {
  test("each cycle header carries an ISO timestamp", () => {
    expect(formatCycleHeader(new Date("2026-10-23T13:00:00.000Z"))).toContain("2026-10-23T13:00:00.000Z");
  });
});

describe("timing.ts decision: no push service is built in", () => {
  test("no ntfy URL anywhere in src/ or bin/", () => {
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        const p = join(d, n);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
      });
    const root = join(import.meta.dir, "..", "..");
    const files = [...walk(join(root, "src")), ...walk(join(root, "bin"))];
    expect(files.length).toBeGreaterThan(50);
    expect(files.filter((f) => /ntfy\.sh/i.test(readFileSync(f, "utf-8")))).toEqual([]);
  });
});
