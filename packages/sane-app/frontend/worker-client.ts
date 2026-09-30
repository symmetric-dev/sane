import { useEffect, useSyncExternalStore } from "react";
import { request } from "./cc-client";
import type { WorkerRecord, WorkerDelivery } from "../src/worker-contract";
import type { WorkerSessionMetadata } from "./types";

export type WorkerProjection = { workers: WorkerRecord[]; deliveries: WorkerDelivery[]; continuationSuppressed: boolean; error?: string };
export type WorkerStop = { ids: string[]; includeDescendants?: boolean } | { all: true };
const empty: WorkerProjection = { workers: [], deliveries: [], continuationSuppressed: false };
let projections: Record<string, WorkerProjection> = {};
let viewer: WorkerRecord | null = null;
let references: Record<string, WorkerSessionMetadata> = {};
let opening = { sessionId: "", loading: false, error: "" };
let openGeneration = 0;
let navigateToWorker: (sessionId: string) => void = () => {};
export function setWorkerNavigator(navigate: (sessionId: string) => void) { navigateToWorker = navigate; }
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(fn => fn());
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const workerClient = {
  list: (id: string, signal?: AbortSignal): Promise<WorkerProjection> => request(`/api/sessions/${encodeURIComponent(id)}/workers`, { signal }),
  stop: (id: string, input: WorkerStop): Promise<unknown> => request(`/api/sessions/${encodeURIComponent(id)}/workers/cancel`, { method: "POST", body: JSON.stringify(input) }),
};
export function publishWorkers(id: string, value: WorkerProjection) {
  if (JSON.stringify(projections[id]) === JSON.stringify(value)) return;
  projections = { ...projections, [id]: value }; emit();
}
export const workersFor = (id: string) => projections[id] ?? empty;
export const knownWorker = (id: string) => {
  const matches = Object.values(projections).flatMap(p => p.workers).filter(w => w.sessionId === id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return matches[0];
};
export const workerReference = (id: string) => references[id] ?? knownWorker(id);
export function directWorkerCounts(): Map<string, number> {
  const children = new Map<string, Set<string>>();
  const add = (worker: WorkerSessionMetadata) => {
    const ids = children.get(worker.parent.sessionId) ?? new Set<string>();
    ids.add(worker.id); children.set(worker.parent.sessionId, ids);
  };
  Object.values(references).forEach(add);
  Object.values(projections).forEach(projection => projection.workers.forEach(add));
  return new Map([...children].map(([id, workers]) => [id, workers.size]));
}
export function registerWorkerSessions(sessions: { id: string; worker?: WorkerSessionMetadata }[]) {
  const next = Object.fromEntries(sessions.filter(s => s.worker).map(s => [s.id, s.worker!]));
  if (JSON.stringify(references) === JSON.stringify(next)) return;
  references = next; projections = { ...projections }; emit();
}
export async function openWorkerSession(sessionId: string): Promise<void> {
  closeWorker();
  navigateToWorker(sessionId);
}
export function useWorkerOpening() { return useSyncExternalStore(subscribe, () => opening); }
export function useWorkers(id: string) { return useSyncExternalStore(subscribe, () => workersFor(id)); }
export function useWorkerDiscovery() { return useSyncExternalStore(subscribe, () => projections); }
export const openWorker = (worker: WorkerRecord) => {
  references = { ...references, [worker.sessionId]: { id: worker.id, parent: worker.parent } };
  void openWorkerSession(worker.sessionId);
};
export const closeWorker = () => { ++openGeneration; opening = { sessionId: "", loading: false, error: "" }; viewer = null; emit(); };
export function useWorkerViewer() { return useSyncExternalStore(subscribe, () => viewer); }
export function useWorkerPolling(id: string | null) {
  useEffect(() => {
    if (!id) return;
    let current = true, timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try { const result = await workerClient.list(id, controller.signal); if (current) publishWorkers(id, result); }
      catch (e) { if (current) publishWorkers(id, { ...workersFor(id), error: e instanceof Error ? e.message : "Worker status unavailable" }); }
      finally { if (current) timer = setTimeout(() => void poll(), 1500); }
    };
    void poll();
    return () => { current = false; controller.abort(); clearTimeout(timer); };
  }, [id]);
}
