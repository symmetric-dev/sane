import { useEffect, useSyncExternalStore } from "react";
import { request } from "./cc-client";
import { WORKER_STATE_BATCH_LIMIT, type WorkerRecord, type WorkerDelivery, type WorkerStateSnapshot, type WorkerStateBatch } from "../src/worker-contract";
import type { WorkerSessionMetadata } from "./types";
import { pollWhileVisible } from "./visibility";

export type WorkerProjection = { workers: WorkerRecord[]; deliveries: WorkerDelivery[]; continuationSuppressed: boolean; error?: string };
export type WorkerStop = { ids: string[]; includeDescendants?: boolean } | { all: true };
const empty: WorkerProjection = { workers: [], deliveries: [], continuationSuppressed: false };
let projections: Record<string, WorkerProjection> = {};
type WorkerStateRead = { snapshot?: WorkerStateSnapshot; loading: boolean; error: string; identity?: string };
const emptyState: WorkerStateRead = { loading: false, error: "" };
let states: Record<string, WorkerStateRead> = {};
type StateFlight = { identity: string; done: Promise<void> };
const stateFlights = new Map<string, StateFlight>();
const stateControllers = new Set<AbortController>();
let stateGeneration = 0;
export const workerStateIdentity = (worker: WorkerRecord) => JSON.stringify([worker.id, worker.sessionId, worker.parent.sessionId]);
const sameWorker = (left: WorkerRecord, right: WorkerRecord) => workerStateIdentity(left) === workerStateIdentity(right);
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
  states: (id: string, ids: string[], signal?: AbortSignal): Promise<WorkerStateBatch> => request(`/api/sessions/${encodeURIComponent(id)}/workers/state`, { method: "POST", body: JSON.stringify({ ids }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : undefined }),
};
export function clearWorkerStates() {
  ++stateGeneration;
  for (const controller of stateControllers) controller.abort();
  stateControllers.clear(); stateFlights.clear(); states = {}; emit();
}
const stateFor = (worker: WorkerRecord) => states[worker.id]?.identity === workerStateIdentity(worker) ? states[worker.id]! : emptyState;
export function useWorkerState(worker: WorkerRecord) { return useSyncExternalStore(subscribe, () => stateFor(worker)); }
export function useWorkerStatesLoading(workers: readonly WorkerRecord[]) { return useSyncExternalStore(subscribe, () => workers.some(worker => stateFor(worker).loading)); }
export function useWorkerStateGeneration() { return useSyncExternalStore(subscribe, () => stateGeneration); }
/** Explicit targets only. Overlapping groups and singleton callers share each worker's flight. */
export async function refreshWorkerStates(sessionId: string, workers: readonly WorkerRecord[]) {
  if (!sessionId) return;
  const pending: WorkerRecord[] = [], waiting = new Set<Promise<void>>();
  for (const worker of new Map(workers.map(worker => [worker.id, worker])).values()) {
    const flight = stateFlights.get(worker.id);
    if (flight?.identity === workerStateIdentity(worker)) waiting.add(flight.done);
    else pending.push(worker);
  }
  for (let index = 0; index < pending.length; index += WORKER_STATE_BATCH_LIMIT) {
    waiting.add(refreshWorkerStateChunk(sessionId, pending.slice(index, index + WORKER_STATE_BATCH_LIMIT)));
  }
  await Promise.all(waiting);
}
/** Non-chat surfaces may explicitly refresh a singleton, never its session tree. */
export function refreshWorkerState(worker: WorkerRecord) { return refreshWorkerStates(worker.parent.sessionId, [worker]); }
async function refreshWorkerStateChunk(sessionId: string, workers: WorkerRecord[]) {
  const controller = new AbortController(), generation = stateGeneration;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const flights = new Map(workers.map(worker => [worker.id, { identity: workerStateIdentity(worker), done }]));
  stateControllers.add(controller);
  states = { ...states };
  for (const worker of workers) {
    stateFlights.set(worker.id, flights.get(worker.id)!);
    states[worker.id] = { ...stateFor(worker), identity: workerStateIdentity(worker), loading: true, error: "" };
  }
  emit();
  const current = (worker: WorkerRecord) => generation === stateGeneration && !controller.signal.aborted && stateFlights.get(worker.id) === flights.get(worker.id);
  const fail = (worker: WorkerRecord, error: string) => {
    if (current(worker)) states = { ...states, [worker.id]: { ...states[worker.id], loading: false, error } };
  };
  try {
    const batch = await workerClient.states(sessionId, workers.map(worker => worker.id), controller.signal);
    if (!Array.isArray(batch?.results)) throw new Error("Invalid worker state response.");
    for (const worker of workers) {
      if (!current(worker)) continue;
      const matches = batch.results.filter(result => result?.id === worker.id);
      const result = matches.length === 1 ? matches[0] : undefined;
      if (!result) { fail(worker, "Worker state missing or duplicated in refresh response."); continue; }
      if ("error" in result) { fail(worker, result.error || "Worker refresh unavailable"); continue; }
      const snapshot = result.snapshot;
      if (!snapshot?.worker?.parent || !sameWorker(snapshot.worker, worker)) { fail(worker, "Worker state identity mismatch."); continue; }
      states = { ...states, [worker.id]: { snapshot, identity: workerStateIdentity(worker), loading: false, error: "" } };
      projections = Object.fromEntries(Object.entries(projections).map(([id, projection]) => [id, projection.workers.some(w => sameWorker(w, worker)) ? { ...projection, workers: projection.workers.map(w => sameWorker(w, worker) && w.updatedAt <= snapshot.worker.updatedAt ? snapshot.worker : w) } : projection]));
    }
  } catch (error) {
    for (const worker of workers) fail(worker, error instanceof Error ? error.message : "Worker refresh unavailable");
  } finally {
    for (const worker of workers) if (stateFlights.get(worker.id) === flights.get(worker.id)) stateFlights.delete(worker.id);
    stateControllers.delete(controller); finish();
    if (generation === stateGeneration) emit();
  }
}
export function publishWorkers(id: string, value: WorkerProjection) {
  // Neither a slower pre-refresh listing nor an older poll may regress a record.
  const previous = new Map(projections[id]?.workers.map(worker => [worker.id, worker]));
  value = { ...value, workers: value.workers.map(worker => {
    for (const observed of [previous.get(worker.id), states[worker.id]?.snapshot?.worker]) {
      if (observed && sameWorker(observed, worker) && observed.updatedAt > worker.updatedAt) worker = observed;
    }
    return worker;
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
