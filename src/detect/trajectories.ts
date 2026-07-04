import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { Trajectory } from "../adapters/types";

const MAX_TRAJECTORIES = 100;
const DEFAULT_STORE_FILE = "trajectories.json";

interface TrajectoryStore {
  trajectories: Trajectory[];
}

function defaultStorePath(signalDir: string): string {
  return join(signalDir, DEFAULT_STORE_FILE);
}

async function loadStore(path: string): Promise<TrajectoryStore> {
  if (!existsSync(path)) return { trajectories: [] };
  try {
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content) as TrajectoryStore;
  } catch {
    return { trajectories: [] };
  }
}

async function saveStore(path: string, store: TrajectoryStore): Promise<void> {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2));
}

function domainOverlap(query: string[], candidate: string[]): number {
  if (query.length === 0 || candidate.length === 0) return 0;
  const candidateSet = new Set(candidate);
  let overlap = 0;
  for (const d of query) {
    if (candidateSet.has(d)) overlap++;
  }
  const union = new Set([...query, ...candidate]).size;
  return union === 0 ? 0 : overlap / union;
}

export async function addTrajectory(
  t: Trajectory,
  signalDir: string,
): Promise<void> {
  const storePath = defaultStorePath(signalDir);
  const store = await loadStore(storePath);

  store.trajectories.push(t);

  if (store.trajectories.length > MAX_TRAJECTORIES) {
    store.trajectories.sort((a, b) => a.rating - b.rating);
    store.trajectories = store.trajectories.slice(
      store.trajectories.length - MAX_TRAJECTORIES,
    );
  }

  await saveStore(storePath, store);
}

export async function queryTrajectories(
  domains: string[],
  signalDir: string,
  limit: number = 5,
): Promise<Trajectory[]> {
  const storePath = defaultStorePath(signalDir);
  const store = await loadStore(storePath);

  if (store.trajectories.length === 0) return [];

  return store.trajectories
    .map((t) => ({
      trajectory: t,
      score: domains.length > 0 ? domainOverlap(domains, t.domains) : 1,
    }))
    .filter((s) => domains.length === 0 || s.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.trajectory.rating - a.trajectory.rating;
    })
    .slice(0, limit)
    .map((s) => s.trajectory);
}

export async function gcTrajectories(
  signalDir: string,
): Promise<number> {
  const storePath = defaultStorePath(signalDir);
  const store = await loadStore(storePath);

  if (store.trajectories.length <= MAX_TRAJECTORIES) return 0;

  const before = store.trajectories.length;
  store.trajectories.sort((a, b) => a.rating - b.rating);
  store.trajectories = store.trajectories.slice(
    store.trajectories.length - MAX_TRAJECTORIES,
  );
  const evicted = before - store.trajectories.length;

  await saveStore(storePath, store);
  return evicted;
}
