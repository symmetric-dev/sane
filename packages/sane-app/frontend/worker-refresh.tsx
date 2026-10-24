import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { WorkerRecord } from "../src/worker-contract";
import { refreshWorkerState, refreshWorkerStates, useWorkerStateGeneration, useWorkerStatesLoading, workerStateIdentity } from "./worker-client";

type WorkerRefreshGroup = { loading: boolean; disabled: boolean; refresh: () => Promise<void> };
const WorkerRefreshContext = createContext<WorkerRefreshGroup | null>(null);

/** One observation per loaded worker per Chat activation, not per card or list poll. */
export function LoadedWorkerRefreshProvider({ sessionId, scope, enabled, workers, children }: {
  sessionId: string; scope: string; enabled: boolean; workers: readonly WorkerRecord[]; children: ReactNode;
}) {
  const generation = useWorkerStateGeneration();
  const loading = useWorkerStatesLoading(workers);
  const attempted = useRef<{ scope: string; generation: number; ids: Set<string> } | null>(null);
  useEffect(() => {
    if (!enabled || !sessionId) { attempted.current = null; return; }
    if (!attempted.current || attempted.current.scope !== scope || attempted.current.generation !== generation) {
      attempted.current = { scope, generation, ids: new Set() };
    }
    const seen = attempted.current.ids;
    const added = workers.filter(worker => !seen.has(workerStateIdentity(worker)));
    // Mark before starting, including failures. StrictMode's effect replay shares
    // this ref and ongoing manual/singleton refreshes share the client's flights.
    for (const worker of added) seen.add(workerStateIdentity(worker));
    if (added.length) void refreshWorkerStates(sessionId, added);
  }, [enabled, sessionId, scope, generation, workers]);
  const value = useMemo<WorkerRefreshGroup>(() => ({
    loading,
    disabled: !enabled || !sessionId || !workers.length || loading,
    refresh: () => enabled ? refreshWorkerStates(sessionId, workers) : Promise.resolve(),
  }), [enabled, sessionId, workers, loading]);
  return <WorkerRefreshContext.Provider value={value}>{children}</WorkerRefreshContext.Provider>;
}

/** Portals inherit the Chat group, even when their own card is not a target. */
export function useWorkerRefresh(worker: WorkerRecord, loading: boolean) {
  const group = useContext(WorkerRefreshContext);
  return group ? { ...group, label: "Refresh loaded workers", busyLabel: "Refreshing loaded workers" }
    : { loading, disabled: loading, refresh: () => refreshWorkerState(worker), label: "Refresh worker state", busyLabel: "Refreshing worker state" };
}
