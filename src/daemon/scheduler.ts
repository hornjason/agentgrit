import { existsSync, mkdirSync, unlinkSync, statSync as fsStatSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const LABEL = "com.agentgrit.daemon";

export interface SchedulerConfig {
  interval: string;
  command: string;
}

export interface SchedulerStatus {
  installed: boolean;
  running: boolean;
  lastRun?: string;
  platform: string;
}

function parseIntervalSeconds(interval: string): number {
  const match = interval.match(/^(\d+)(s|m|h)$/);
  if (!match) return 1800;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === "s") return value;
  if (unit === "m") return value * 60;
  return value * 3600;
}

// ── macOS LaunchAgent ──

function launchAgentDir(): string {
  return join(homedir(), "Library", "LaunchAgents");
}

function plistPath(): string {
  return join(launchAgentDir(), `${LABEL}.plist`);
}

export function generatePlist(config: SchedulerConfig): string {
  const seconds = parseIntervalSeconds(config.interval);
  const parts = config.command.split(" ");
  const program = parts[0];
  const args = parts.slice(1);

  const argEntries = [program, ...args]
    .map((a) => `      <string>${escapeXml(a)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argEntries}
    </array>
    <key>StartInterval</key>
    <integer>${seconds}</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(join(homedir(), ".agentgrit", "daemon.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(join(homedir(), ".agentgrit", "daemon.err"))}</string>
</dict>
</plist>`;
}

// ── Linux systemd ──

function systemdDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

function servicePath(): string {
  return join(systemdDir(), `${LABEL}.service`);
}

function timerPath(): string {
  return join(systemdDir(), `${LABEL}.timer`);
}

export function generateSystemdService(config: SchedulerConfig): string {
  return `[Unit]
Description=AgentGrit daemon cycle
After=network.target

[Service]
Type=oneshot
ExecStart=${config.command}

[Install]
WantedBy=default.target
`;
}

export function generateSystemdTimer(config: SchedulerConfig): string {
  const seconds = parseIntervalSeconds(config.interval);
  const minutes = Math.max(1, Math.round(seconds / 60));

  return `[Unit]
Description=AgentGrit daemon timer

[Timer]
OnBootSec=${minutes}min
OnUnitActiveSec=${minutes}min
Persistent=true

[Install]
WantedBy=timers.target
`;
}

// ── Cross-platform API ──

export async function installScheduler(config: SchedulerConfig): Promise<void> {
  const platform = process.platform;

  if (platform === "darwin") {
    const dir = launchAgentDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const plist = generatePlist(config);
    await Bun.write(plistPath(), plist);
  } else if (platform === "linux") {
    const dir = systemdDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const service = generateSystemdService(config);
    const timer = generateSystemdTimer(config);
    await Bun.write(servicePath(), service);
    await Bun.write(timerPath(), timer);
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }
}

export async function uninstallScheduler(): Promise<void> {
  const platform = process.platform;

  if (platform === "darwin") {
    const path = plistPath();
    if (existsSync(path)) unlinkSync(path);
  } else if (platform === "linux") {
    const sPath = servicePath();
    const tPath = timerPath();
    if (existsSync(sPath)) unlinkSync(sPath);
    if (existsSync(tPath)) unlinkSync(tPath);
  }
}

export async function getSchedulerStatus(): Promise<SchedulerStatus> {
  const platform = process.platform;
  const status: SchedulerStatus = {
    installed: false,
    running: false,
    platform,
  };

  if (platform === "darwin") {
    status.installed = existsSync(plistPath());

    if (status.installed) {
      const logPath = join(homedir(), ".agentgrit", "daemon.log");
      if (existsSync(logPath)) {
        const stat = fsStatSync(logPath);
        status.lastRun = stat.mtime.toISOString();
        const ageMs = Date.now() - stat.mtimeMs;
        status.running = ageMs < 3_600_000;
      }
    }
  } else if (platform === "linux") {
    status.installed = existsSync(timerPath()) && existsSync(servicePath());
  }

  return status;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
