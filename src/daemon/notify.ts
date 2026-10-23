/**
 * notify.ts — Opt-in daemon health notifications (#321)
 *
 * After each daemon cycle: alert when something breaks, say "recovered" when
 * it clears, and send one "healthy" heartbeat a day so silence can never mean
 * a dead daemon.
 *
 * Transport is a user-configured shell command (`notify.command`), not a
 * built-in service — push notifications stay out of the package (see
 * timing.ts). Unset means this module does nothing at all.
 *
 * The command receives AGENTGRIT_NOTIFY_TITLE and AGENTGRIT_NOTIFY_BODY in its
 * environment, and the body on stdin.
 */

import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { statePath } from "../adapters/paths";
import { atomicWriteJSON } from "../adapters/atomic-write";
import type { AgentGritConfig } from "../adapters/types";
import { runDoctor as runDoctorDefault, type DoctorReport } from "./doctor";

export interface NotifyState {
  /** Identity of the failure set last alerted on; null when healthy. */
  errorKey: string | null;
  lastAlertDay: string | null;
  lastHeartbeatDay: string | null;
}

export const EMPTY_NOTIFY_STATE: NotifyState = { errorKey: null, lastAlertDay: null, lastHeartbeatDay: null };

export type NotifyKind = "alert" | "recovered" | "heartbeat" | "none";

export interface NotifyDecision {
  kind: NotifyKind;
  title?: string;
  body?: string;
  state: NotifyState;
}

interface Failure {
  /** Stable identity: the failing step or check, not its message. */
  key: string;
  text: string;
}

const STATE_FILE = "notify-state.json";
const DEFAULT_TIMEOUT_MS = 10_000;

/** Local calendar day, YYYY-MM-DD. */
function dayOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function collectFailures(cycleErrors: string[], doctor: DoctorReport): Failure[] {
  // Cycle errors read "<step>: <detail>". The detail carries paths, errnos and
  // timings that change run to run; keying on it would re-alert every cycle.
  const failures: Failure[] = cycleErrors.map((e) => ({ key: `cycle:${e.split(":")[0].trim()}`, text: e }));
  for (const section of doctor.sections) {
    for (const check of section.checks) {
      // A CAPTURE warning is a signal file going stale or missing: a capture
      // hook has stopped firing. Elsewhere a warning is not worth a page.
      const alerting = check.status === "error" || (section.name === "CAPTURE" && check.status === "warning");
      if (!alerting) continue;
      failures.push({ key: `doctor:${section.name}/${check.name}`, text: `${section.name}/${check.name}: ${check.message}` });
    }
  }
  return failures;
}

export function decideNotification(
  input: { cycleErrors: string[]; doctor: DoctorReport; now: Date },
  prev: NotifyState,
): NotifyDecision {
  const today = dayOf(input.now);
  const failures = collectFailures(input.cycleErrors, input.doctor);

  if (failures.length > 0) {
    const errorKey = [...new Set(failures.map((f) => f.key))].sort().join("|");
    const changed = errorKey !== prev.errorKey;
    const newDay = prev.lastAlertDay !== today;
    if (!changed && !newDay) return { kind: "none", state: prev };
    return {
      kind: "alert",
      title: changed ? "AgentGrit: failing" : "AgentGrit: still failing",
      body: failures.map((f) => `- ${f.text}`).join("\n"),
      state: { ...prev, errorKey, lastAlertDay: today },
    };
  }

  if (prev.errorKey !== null) {
    return {
      kind: "recovered",
      title: "AgentGrit: recovered",
      body: `All checks passing as of ${input.now.toISOString()}.`,
      // The recovered message is today's "healthy"; no separate heartbeat.
      state: { ...prev, errorKey: null, lastHeartbeatDay: today },
    };
  }

  if (prev.lastHeartbeatDay === today || prev.lastAlertDay === today) {
    return { kind: "none", state: prev };
  }

  const okSections = input.doctor.sections.filter((s) => s.status === "ok").length;
  return {
    kind: "heartbeat",
    title: "AgentGrit: healthy",
    body: `Daemon cycle finished at ${input.now.toISOString()}. Doctor: ${okSections}/${input.doctor.sections.length} sections ok, 0 errors.`,
    state: { ...prev, lastHeartbeatDay: today },
  };
}

export function sendNotification(
  command: string,
  title: string,
  body: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): { ok: boolean; error?: string } {
  const r = spawnSync("/bin/sh", ["-c", command], {
    input: body,
    env: { ...process.env, AGENTGRIT_NOTIFY_TITLE: title, AGENTGRIT_NOTIFY_BODY: body },
    timeout: timeoutMs,
    stdio: ["pipe", "ignore", "pipe"],
    encoding: "utf-8",
  });
  if (r.error) return { ok: false, error: String(r.error.message ?? r.error) };
  if (r.status !== 0) {
    const stderr = (r.stderr ?? "").trim().slice(0, 200);
    return { ok: false, error: `notify.command exited ${r.status ?? r.signal}${stderr ? `: ${stderr}` : ""}` };
  }
  return { ok: true };
}

function readState(): NotifyState {
  const path = statePath(STATE_FILE);
  if (!existsSync(path)) return EMPTY_NOTIFY_STATE;
  try {
    return { ...EMPTY_NOTIFY_STATE, ...JSON.parse(readFileSync(path, "utf-8")) };
  } catch {
    // A corrupt file must not silence alerts; start over and re-alert.
    return EMPTY_NOTIFY_STATE;
  }
}

export async function runNotify(
  config: AgentGritConfig,
  cycleErrors: string[],
  opts: { now?: Date; runDoctor?: (c: AgentGritConfig) => Promise<DoctorReport> } = {},
): Promise<NotifyDecision & { sent: boolean; error?: string }> {
  const command = config.notify?.command;
  if (!command) return { kind: "none", state: EMPTY_NOTIFY_STATE, sent: false };

  const now = opts.now ?? new Date();
  const errors = [...cycleErrors];
  let doctor: DoctorReport;
  try {
    doctor = await (opts.runDoctor ?? runDoctorDefault)(config);
  } catch (err) {
    errors.push(`doctor: ${(err as Error).message}`);
    doctor = { timestamp: now.toISOString(), overall: "error", sections: [] };
  }

  const decision = decideNotification({ cycleErrors: errors, doctor, now }, readState());
  if (decision.kind === "none") return { ...decision, sent: false };

  const result = sendNotification(command, decision.title!, decision.body!, config.notify?.timeoutMs);
  // Only a delivered message advances the state, so a failed send retries next cycle.
  if (result.ok) atomicWriteJSON(statePath(STATE_FILE), decision.state);
  return { ...decision, sent: result.ok, error: result.error };
}
