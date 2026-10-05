import { useMemo, useSyncExternalStore } from "react";
import type { WorkstreamOverview } from "../src/workstreams-contract";
import { catalog } from "./catalog";
import { store } from "./store";
import { loadWorkstreams, subscribeWorkstreamMutations } from "./workstreams-client";
import { WorkspaceError } from "./workspace-client";
import { subscribeWorkspace, workspaceEpoch } from "./workspace-store";

type OverviewState = { overview: WorkstreamOverview | null; loading: boolean; error: string };
type Owner = {
  workspaceId: string; auth: number; key: string; leases: number; disposed: boolean;
  listeners: Set<() => void>; state: OverviewState; serialized: string;
  revision: number; resultRevision: number; settledAt: number;
  promise?: Promise<WorkstreamOverview>; controller?: AbortController; automatic: boolean; paused: boolean;
  timer?: ReturnType<typeof setTimeout>; unsubscribe: () => void;
};
const idle: OverviewState = { overview: null, loading: false, error: "" };
const initial: OverviewState = { overview: null, loading: true, error: "" };
const registry = new Map<string, Owner>();
const POLL_MS = 1500;
const shellReady = () => store.snapshot().phase === "ready";
const automaticPaused = () => catalog.snapshot().navigation.view === "terminal";
const keyFor = (workspaceId: string) => JSON.stringify([workspaceId, workspaceEpoch()]);
const current = (owner: Owner) => !owner.disposed && owner.auth === workspaceEpoch() && registry.get(owner.key) === owner;
const unavailable = () => new WorkspaceError("Workspace changed or unavailable. Choose an available workspace and retry.", 409, "workspace-changed");

function publish(owner: Owner, state: OverviewState) {
  if (owner.state.overview === state.overview && owner.state.loading === state.loading && owner.state.error === state.error) return;
  owner.state = state;
  owner.listeners.forEach(listener => listener());
}

function dispose(owner: Owner) {
  if (owner.disposed) return;
  owner.disposed = true;
  clearTimeout(owner.timer); owner.timer = undefined;
  owner.controller?.abort();
  owner.unsubscribe();
  if (registry.get(owner.key) === owner) registry.delete(owner.key);
  owner.serialized = "";
  publish(owner, idle);
}

function schedule(owner: Owner) {
  clearTimeout(owner.timer); owner.timer = undefined;
  if (!current(owner) || owner.paused || !owner.listeners.size) return;
  owner.timer = setTimeout(() => {
    owner.timer = undefined;
    refreshAutomatically(owner, true);
  }, POLL_MS);
}

function refreshAutomatically(owner: Owner, force: boolean) {
  if (!current(owner) || owner.paused || !owner.listeners.size) return;
  void refresh(owner, force, true).catch(() => {});
}

function pause(owner: Owner) {
  clearTimeout(owner.timer); owner.timer = undefined;
  if (!owner.automatic) return;
  const controller = owner.controller;
  // Detach before aborting so an immediate resume can start a fresh request.
  // The old request's controller fence keeps late responses/finally inert.
  owner.promise = undefined; owner.controller = undefined; owner.automatic = false;
  controller?.abort();
}

function refresh(owner: Owner, force: boolean, automatic = false): Promise<WorkstreamOverview> {
  if (!current(owner)) return Promise.reject(unavailable());
  if (owner.promise) {
    // An explicit caller sharing a background read must not be cancelled by navigation.
    if (!automatic) owner.automatic = false;
    return owner.promise;
  }
  if (!force && owner.state.overview && !owner.state.error && owner.resultRevision === owner.revision && Date.now() - owner.settledAt < POLL_MS) {
    return Promise.resolve(owner.state.overview);
  }
  clearTimeout(owner.timer); owner.timer = undefined;
  const controller = owner.controller = new AbortController();
  owner.automatic = automatic;
  const valid = () => current(owner) && owner.controller === controller && !controller.signal.aborted;
  const promise = Promise.resolve().then(async () => {
    try {
      while (valid()) {
        const revision = owner.revision;
        let overview: WorkstreamOverview;
        try { overview = await loadWorkstreams(owner.workspaceId, AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)])); }
        catch (error) {
          if (!valid()) throw error;
          if (revision !== owner.revision) continue;
          owner.settledAt = Date.now();
          publish(owner, { overview: owner.state.overview, loading: false, error: error instanceof Error ? error.message : "Workstreams are unavailable." });
          if (valid() && revision !== owner.revision) continue;
          throw error;
        }
        if (!valid()) throw unavailable();
        if (revision !== owner.revision) continue;
        const serialized = JSON.stringify(overview);
        const result = owner.state.overview && serialized === owner.serialized ? owner.state.overview : overview;
        owner.serialized = serialized;
        owner.resultRevision = revision; owner.settledAt = Date.now();
        publish(owner, { overview: result, loading: false, error: "" });
        if (!valid()) throw unavailable();
        if (revision !== owner.revision) continue;
        return result;
      }
      throw unavailable();
    } finally {
      if (owner.controller === controller) {
        owner.promise = undefined; owner.controller = undefined; owner.automatic = false;
        schedule(owner);
      }
    }
  });
  owner.promise = promise;
  publish(owner, { overview: owner.state.overview, loading: !owner.state.overview, error: owner.state.error });
  return promise;
}

function acquire(workspaceId: string) {
  const key = keyFor(workspaceId);
  let owner = registry.get(key);
  if (!owner) {
    owner = { workspaceId, auth: workspaceEpoch(), key, leases: 0, disposed: false,
      listeners: new Set(), state: initial, serialized: "", revision: 0, resultRevision: -1, settledAt: 0,
      automatic: false, paused: automaticPaused(), unsubscribe: () => {} };
    registry.set(key, owner);
    const entry = owner;
    const unsubscribeWorkspace = subscribeWorkspace(() => {
      if (entry.auth !== workspaceEpoch()) dispose(entry);
    });
    const unsubscribeMutations = subscribeWorkstreamMutations(mutation => {
      if (!current(entry) || mutation.workspaceId !== entry.workspaceId) return;
      entry.revision++;
      refreshAutomatically(entry, true);
    });
    const unsubscribeCatalog = catalog.subscribe(() => {
      if (!current(entry)) return;
      const paused = automaticPaused();
      if (entry.paused === paused) return;
      entry.paused = paused;
      // Keep scoped leases and cached snapshots, including hidden chat consumers.
      if (paused) pause(entry);
      else refreshAutomatically(entry, true);
    });
    entry.unsubscribe = () => { unsubscribeWorkspace(); unsubscribeMutations(); unsubscribeCatalog(); };
  }
  owner.leases++;
  const entry = owner;
  let released = false;
  return { owner: entry, release: () => {
    if (released) return;
    released = true;
    if (--entry.leases === 0) dispose(entry);
  } };
}

export async function refreshWorkstreamOverview(workspaceId: string, options?: { force?: boolean }): Promise<WorkstreamOverview> {
  const lease = acquire(workspaceId);
  try {
    let force = options?.force ?? false;
    while (current(lease.owner)) {
      const overview = await refresh(lease.owner, force);
      if (!current(lease.owner)) throw unavailable();
      if (lease.owner.resultRevision === lease.owner.revision) return overview;
      force = true;
    }
    throw unavailable();
  }
  finally { lease.release(); }
}

export function useWorkstreamOverviewState(workspaceId: string | null, active = true): OverviewState {
  const epoch = useSyncExternalStore(subscribeWorkspace, workspaceEpoch, workspaceEpoch);
  const ready = useSyncExternalStore(store.subscribe, shellReady, shellReady);
  const source = useMemo(() => {
    let owner: Owner | undefined;
    const available = () => !!workspaceId && active && ready && shellReady() && epoch === workspaceEpoch();
    return {
      subscribe: (listener: () => void) => {
        if (!workspaceId || !available()) return () => {};
        let released = false;
        let lease: ReturnType<typeof acquire> | undefined;
        // Workspace 401s notify the epoch before the shell synchronously enters login.
        queueMicrotask(() => {
          if (released || !available()) return;
          lease = acquire(workspaceId);
          owner = lease.owner;
          const entry = owner;
          entry.listeners.add(listener);
          refreshAutomatically(entry, false);
          if (!entry.promise) schedule(entry);
          listener();
        });
        return () => {
          released = true;
          if (!lease) return;
          const entry = lease.owner;
          entry.listeners.delete(listener);
          if (!entry.listeners.size) { clearTimeout(entry.timer); entry.timer = undefined; }
          lease.release();
          if (owner === entry) owner = undefined;
        };
      },
      snapshot: () => {
        if (!workspaceId || !available()) return idle;
        if (owner) return current(owner) ? owner.state : idle;
        return registry.get(keyFor(workspaceId))?.state ?? initial;
      },
      serverSnapshot: () => available() ? initial : idle,
    };
  }, [workspaceId, active, epoch, ready]);
  return useSyncExternalStore(source.subscribe, source.snapshot, source.serverSnapshot);
}

export function useWorkstreamOverview(workspaceId: string | null, active = true): WorkstreamOverview | null {
  return useWorkstreamOverviewState(workspaceId, active).overview;
}
