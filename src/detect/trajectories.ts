import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import type { Trajectory } from "../adapters/types";

const MAX_TRAJECTORIES = 100;
const DEFAULT_STORE_FILE = "trajectories.json";

export const RATING_THRESHOLD = 7;
export const VALID_AGENT_IDS = ["rayford", "marcus", "quinn", "rook", "unknown"] as const;
export type AgentId = (typeof VALID_AGENT_IDS)[number];

// ── Types ──────────────────────────────────────────────────────────────────

interface TrajectoryStore { trajectories: Trajectory[]; }

export interface TrajectoryStoreStats {
  count: number;
  capacity: number;
  avgRating: number;
  domainDistribution: Record<string, number>;
  agentDistribution: Record<string, number>;
  oldestTimestamp: string | null;
  newestTimestamp: string | null;
}

// ── ID generation ──────────────────────────────────────────────────────────

const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

export function generateTrajectoryId(): string {
  let id = "traj-";
  for (let i = 0; i < 6; i++) id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return id;
}

// ── Store I/O ──────────────────────────────────────────────────────────────

function defaultStorePath(signalDir: string): string {
  return join(signalDir, DEFAULT_STORE_FILE);
}

async function loadStore(path: string): Promise<TrajectoryStore> {
  if (!existsSync(path)) return { trajectories: [] };
  try {
    const content = await Bun.file(path).text();
    return JSON.parse(content) as TrajectoryStore;
  } catch { return { trajectories: [] }; }
}

async function saveStore(path: string, store: TrajectoryStore): Promise<void> {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  await Bun.write(path, JSON.stringify(store, null, 2));
}

function domainOverlap(query: string[], candidate: string[]): number {
  if (query.length === 0 || candidate.length === 0) return 0;
  const candidateSet = new Set(candidate);
  let overlap = 0;
  for (const d of query) { if (candidateSet.has(d)) overlap++; }
  const union = new Set([...query, ...candidate]).size;
  return union === 0 ? 0 : overlap / union;
}

// ── Validation ─────────────────────────────────────────────────────────────

export function isQualifiedRating(rating: number): boolean {
  return rating >= RATING_THRESHOLD;
}

export function parseAgentId(raw: string | undefined): AgentId {
  if (!raw) return "unknown";
  const normalized = raw.toLowerCase() as AgentId;
  return (VALID_AGENT_IDS as readonly string[]).includes(normalized) ? normalized : "unknown";
}

// ── Core operations ────────────────────────────────────────────────────────

export async function addTrajectory(t: Trajectory, signalDir: string): Promise<void> {
  const storePath = defaultStorePath(signalDir);
  const store = await loadStore(storePath);
  store.trajectories.push(t);
  if (store.trajectories.length > MAX_TRAJECTORIES) {
    store.trajectories.sort((a, b) => a.rating - b.rating);
    store.trajectories = store.trajectories.slice(store.trajectories.length - MAX_TRAJECTORIES);
  }
  await saveStore(storePath, store);
}

export async function addQualifiedTrajectory(
  t: Trajectory, signalDir: string,
): Promise<{ stored: boolean; reason?: string }> {
  if (!isQualifiedRating(t.rating)) {
    return { stored: false, reason: `Rating ${t.rating} below threshold (${RATING_THRESHOLD})` };
  }
  const trajectory: Trajectory = {
    ...t, id: t.id || generateTrajectoryId(), timestamp: t.timestamp || new Date().toISOString(),
  };
  await addTrajectory(trajectory, signalDir);
  return { stored: true };
}

export async function queryTrajectories(
  domains: string[], signalDir: string, limit: number = 5,
): Promise<Trajectory[]> {
  const store = await loadStore(defaultStorePath(signalDir));
  if (store.trajectories.length === 0) return [];
  return store.trajectories
    .map((t) => ({ trajectory: t, score: domains.length > 0 ? domainOverlap(domains, t.domains) : 1 }))
    .filter((s) => domains.length === 0 || s.score > 0)
    .sort((a, b) => { if (b.score !== a.score) return b.score - a.score; return b.trajectory.rating - a.trajectory.rating; })
    .slice(0, limit)
    .map((s) => s.trajectory);
}

export async function queryByAgent(agentId: string, signalDir: string, limit: number = 5): Promise<Trajectory[]> {
  const store = await loadStore(defaultStorePath(signalDir));
  if (store.trajectories.length === 0) return [];
  const normalized = parseAgentId(agentId);
  return store.trajectories
    .filter((t) => (t.agentId ?? "unknown") === normalized)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, limit);
}

export async function listTrajectories(signalDir: string): Promise<Trajectory[]> {
  const store = await loadStore(defaultStorePath(signalDir));
  return [...store.trajectories].sort((a, b) => b.rating - a.rating);
}

export async function trajectoryStats(signalDir: string): Promise<TrajectoryStoreStats> {
  const store = await loadStore(defaultStorePath(signalDir));
  const trajs = store.trajectories;
  if (trajs.length === 0) {
    return { count: 0, capacity: MAX_TRAJECTORIES, avgRating: 0, domainDistribution: {}, agentDistribution: {}, oldestTimestamp: null, newestTimestamp: null };
  }
  const avgRating = trajs.reduce((sum, t) => sum + t.rating, 0) / trajs.length;
  const domainDistribution: Record<string, number> = {};
  for (const t of trajs) for (const d of t.domains) domainDistribution[d] = (domainDistribution[d] ?? 0) + 1;
  const agentDistribution: Record<string, number> = {};
  for (const t of trajs) { const a = t.agentId ?? "unknown"; agentDistribution[a] = (agentDistribution[a] ?? 0) + 1; }
  const timestamps = trajs.map((t) => t.timestamp).filter(Boolean).sort();
  return {
    count: trajs.length, capacity: MAX_TRAJECTORIES,
    avgRating: Math.round(avgRating * 100) / 100,
    domainDistribution, agentDistribution,
    oldestTimestamp: timestamps[0] ?? null,
    newestTimestamp: timestamps[timestamps.length - 1] ?? null,
  };
}

export async function gcTrajectories(signalDir: string): Promise<number> {
  const storePath = defaultStorePath(signalDir);
  const store = await loadStore(storePath);
  if (store.trajectories.length <= MAX_TRAJECTORIES) return 0;
  const before = store.trajectories.length;
  store.trajectories.sort((a, b) => a.rating - b.rating);
  store.trajectories = store.trajectories.slice(store.trajectories.length - MAX_TRAJECTORIES);
  const evicted = before - store.trajectories.length;
  await saveStore(storePath, store);
  return evicted;
}
