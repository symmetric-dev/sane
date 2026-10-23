import { useEffect, useSyncExternalStore } from "react";
import { request } from "./cc-client";
import type { WorkerRecord, WorkerDelivery, WorkerStateSnapshot } from "../src/worker-contract";
import type { WorkerSessionMetadata } from "./types";
import { pollWhileVisible } from "./visibility";

export type WorkerProjection = { workers: WorkerRecord[]; deliveries: WorkerDelivery[]; continuationSuppressed: boolean; error?: string };
export type WorkerStop = { ids: string[]; includeDescendants?: boolean } | { all: true };
const empty: WorkerProjection = { workers: [], deliveries: [], continuationSuppressed: false };
let projections: Record<string, WorkerProjection> = {};
type WorkerStateRead = { snapshot?: WorkerStateSnapshot; loading: boolean; error: string };
const emptyState: WorkerStateRead = { loading: false, error: "" };
let states: Record<string, WorkerStateRead> = {};
const stateFlights = new Map<string, AbortController>();
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
  state: (worker: WorkerRecord, signal?: AbortSignal): Promise<WorkerStateSnapshot> => request(`/api/sessions/${encodeURIComponent(worker.parent.sessionId)}/workers/${encodeURIComponent(worker.id)}/state`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : undefined }),
};
export function clearWorkerStates() {
  for (const controller of stateFlights.values()) controller.abort();
  stateFlights.clear(); states = {}; emit();
}
export function useWorkerState(id: string) { return useSyncExternalStore(subscribe, () => states[id] ?? emptyState); }
/** Explicit clicks only; shared across every instance of the worker's card. */
export async function refreshWorkerState(worker: WorkerRecord) {
  if (stateFlights.has(worker.id)) return;
  const controller = new AbortController(); stateFlights.set(worker.id, controller);
  states = { ...states, [worker.id]: { ...states[worker.id], loading: true, error: "" } }; emit();
  const current = () => stateFlights.get(worker.id) === controller && !controller.signal.aborted;
  try {
    const snapshot = await workerClient.state(worker, controller.signal);
    if (!current()) return;
    if (snapshot.worker.id !== worker.id || snapshot.worker.sessionId !== worker.sessionId || snapshot.worker.parent.sessionId !== worker.parent.sessionId) throw new Error("Worker state identity mismatch.");
    states = { ...states, [worker.id]: { snapshot, loading: false, error: "" } };
    projections = Object.fromEntries(Object.entries(projections).map(([id, projection]) => [id, projection.workers.some(w => w.id === worker.id) ? { ...projection, workers: projection.workers.map(w => w.id === worker.id && w.updatedAt <= snapshot.worker.updatedAt ? snapshot.worker : w) } : projection]));
    emit();
  } catch (error) {
    if (current()) { states = { ...states, [worker.id]: { ...states[worker.id], loading: false, error: error instanceof Error ? error.message : "Worker refresh unavailable" } }; emit(); }
  } finally { if (stateFlights.get(worker.id) === controller) stateFlights.delete(worker.id); }
}
export function publishWorkers(id: string, value: WorkerProjection) {
  // A slower pre-refresh listing must not overwrite the worker just observed.
  value = { ...value, workers: value.workers.map(worker => {
    const refreshed = states[worker.id]?.snapshot?.worker;
    return refreshed && refreshed.sessionId === worker.sessionId && refreshed.updatedAt > worker.updatedAt ? refreshed : worker;
  }) };
  if (JSON.stringify(projections[id]) === JSON.stringify(value)) return;
  projections = { ...projections, [id]: value }; emit();
}
export const workersFor = (id: string) => projections[id] ?? empty;
export const workerInFlight = (worker: WorkerRecord) => ["reserved", "launching", "running", "cancelling"].includes(worker.state)
  || !!worker.continuation && ["reserved", "launching", "running", "cancelling"].includes(worker.continuation.state) || worker.assignment === "closing";
export const workerProjectionInFlight = (projection: WorkerProjection) => projection.workers.some(workerInFlight)
  || projection.deliveries.some(delivery => delivery.state === "claimed" || delivery.state === "acceptance-unknown");
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
    let inFlight = workerProjectionInFlight(workersFor(id)), failures = 0;
    return pollWhileVisible(async signal => {
      try {
        const result = await workerClient.list(id, signal);
        if (!signal.aborted) {
          inFlight = workerProjectionInFlight(result); failures = 0;
          publishWorkers(id, result);
        }
      }
      catch (e) {
        if (!signal.aborted) {
          inFlight ||= workerProjectionInFlight(workersFor(id)); failures++;
          publishWorkers(id, { ...workersFor(id), error: e instanceof Error ? e.message : "Worker status unavailable" });
        }
      }
      return inFlight ? Math.min(1500 * 2 ** Math.min(failures, 4), 15_000) : 60_000;
    }, { sessionIds: [id], onWake: () => { inFlight = true; failures = 0; } });
  }, [id]);
}
