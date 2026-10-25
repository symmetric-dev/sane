import type { CatalogResponse, NavigationBookmark, RegistrationResponse, WorkspaceRecord, WorkspaceCreationInput } from "../src/catalog-contract";
import { WorkspaceError } from "./workspace-client";
import { coalescedFetch } from "./request-coalescing";
import { workspaceEpoch, workspaceFailure } from "./workspace-store";

const empty = (): NavigationBookmark => ({ revision: 0, workspaceId: null, worktreeId: null, conversationId: null, view: "chat", filePath: null, comparison: null });
export type CatalogNavigation = NavigationBookmark;
type CatalogState = { workspaces: WorkspaceRecord[]; navigation: CatalogNavigation; ready: boolean; loading: boolean; error: string };
type Hydration = { epoch: number; auth: number; intent: number; restore: (bookmark: NavigationBookmark) => void; current: () => boolean; complete: () => void; cleanup: () => void };
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const deadline = AbortSignal.timeout(25000);
  const response = await coalescedFetch(path, { credentials: "same-origin", cache: "no-store", ...init, signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline, headers: { "Content-Type": "application/json" } });
  let body;
  try { body = await response.json(); }
  catch (error) {
    // Successful responses must not turn invalid JSON into a ready, empty catalog.
    if (response.ok) throw error;
    throw new WorkspaceError(`Request failed (${response.status}).`, response.status);
  }
  if (!response.ok) throw new WorkspaceError(body?.error || `Request failed (${response.status}).`, response.status, body?.code);
  return body;
}
class CatalogStore {
  private listeners = new Set<() => void>();
  private epoch = 0;
  private intent = 0;
  private registration = 0;
  private revision = 0;
  private pending: NavigationBookmark | null = null;
  private busy = false;
  private timer?: ReturnType<typeof setTimeout>;
  private hydration?: Hydration;
  private hydrationTimer?: ReturnType<typeof setTimeout>;
  private hydrationController?: AbortController;
  private hydrationFailures = 0;
  state: CatalogState = { workspaces: [], navigation: empty(), ready: false, loading: false, error: "" };
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = () => this.state;
  private update(patch: Partial<CatalogState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()); }
  invalidate = () => {
    this.epoch++; this.intent++;
    this.hydration?.cleanup(); this.hydration = undefined;
    this.pauseHydration(); this.hydrationFailures = 0;
    clearTimeout(this.timer); this.pending = null; this.busy = false;
    this.update({ ready: false, loading: false });
  };
  private hydrationAvailable() { return !document.hidden && navigator.onLine !== false; }
  private hydrationCurrent(hydration: Hydration) { return this.hydration === hydration && hydration.epoch === this.epoch && hydration.auth === workspaceEpoch() && hydration.current(); }
  private pauseHydration() {
    clearTimeout(this.hydrationTimer); this.hydrationTimer = undefined;
    const controller = this.hydrationController; this.hydrationController = undefined;
    controller?.abort();
    if (this.state.loading) this.update({ loading: false });
  }
  /** One restore owner per authenticated config; retries never capture a newer intent. */
  startHydration = (restore: Hydration["restore"], current: Hydration["current"], complete: Hydration["complete"]) => {
    this.hydration?.cleanup(); this.hydration = undefined;
    this.pauseHydration(); this.hydrationFailures = 0;
    const resume = () => {
      if (!this.hydrationAvailable()) { this.pauseHydration(); return; }
      this.retryHydration();
    };
    const cleanup = () => {
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", resume);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("pagehide", pause);
      document.removeEventListener("visibilitychange", resume);
    };
    const pause = () => this.pauseHydration();
    const hydration: Hydration = { epoch: this.epoch, auth: workspaceEpoch(), intent: this.intent, restore, current, complete, cleanup };
    this.hydration = hydration;
    window.addEventListener("online", resume);
    window.addEventListener("offline", resume);
    window.addEventListener("pageshow", resume);
    window.addEventListener("pagehide", pause);
    document.addEventListener("visibilitychange", resume);
    if (this.state.ready && this.hydrationCurrent(hydration)) complete();
    else resume();
    return () => { cleanup(); if (this.hydration === hydration) this.invalidate(); };
  };
  retryHydration = () => {
    clearTimeout(this.hydrationTimer); this.hydrationTimer = undefined;
    void this.hydrate();
  };
  private scheduleHydration(hydration: Hydration) {
    if (!this.hydrationCurrent(hydration) || !this.hydrationAvailable() || this.state.ready || this.state.loading) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.hydrationFailures - 1, 5));
    clearTimeout(this.hydrationTimer);
    this.hydrationTimer = setTimeout(() => { this.hydrationTimer = undefined; void this.hydrate(); }, delay);
  }
  private async hydrate() {
    const hydration = this.hydration;
    if (!hydration || !this.hydrationCurrent(hydration) || !this.hydrationAvailable() || this.state.loading || this.state.ready) return;
    const controller = this.hydrationController = new AbortController();
    const current = () => this.hydrationCurrent(hydration) && this.hydrationController === controller && !controller.signal.aborted;
    this.update({ loading: true, error: "" });
    try {
      if (!current()) return;
      const [catalog, navigation] = await Promise.all([request<CatalogResponse>("/api/workspaces", { signal: controller.signal }), request<NavigationBookmark>("/api/navigation", { signal: controller.signal })]);
      if (!current()) return;
      this.revision = navigation.revision;
      this.hydrationFailures = 0;
      // Publish readiness with the restored bookmark, never with a stale browsing
      // pair that could erase client-side context while hydration is in progress.
      if (hydration.intent === this.intent) {
        this.update({ workspaces: catalog.workspaces, ready: true, loading: false, navigation });
        if (current() && hydration.intent === this.intent) hydration.restore(navigation);
      }
      else { this.update({ workspaces: catalog.workspaces, ready: true, loading: false }); if (this.pending) this.schedule(); }
      if (current()) hydration.complete();
    } catch (error) {
      if (!current()) return;
      const message = workspaceFailure(error);
      // A 401 synchronously invalidates this owner through the shell's auth handler.
      if (!current()) return;
      this.update({ loading: false, error: message });
      this.hydrationFailures++;
      this.scheduleHydration(hydration);
    } finally {
      if (this.hydrationController === controller) this.hydrationController = undefined;
      controller.abort();
    }
  }
  navigate = (patch: Partial<Omit<CatalogNavigation, "revision">>) => {
    this.intent++;
    const navigation = { ...this.state.navigation, ...patch };
    this.update({ navigation });
    this.pending = navigation;
    if (this.state.ready) this.schedule();
  };
  private schedule() { clearTimeout(this.timer); this.timer = setTimeout(() => void this.flush(), 300); }
  private async flush() {
    if (this.busy || !this.pending || !this.state.ready) return;
    const navigation = this.pending, epoch = this.epoch;
    this.pending = null; this.busy = true;
    try {
      const { revision: _, ...bookmark } = navigation;
      const result = await request<NavigationBookmark>("/api/navigation", { method: "PUT", body: JSON.stringify({ ...bookmark, expectedRevision: this.revision }) });
      if (epoch === this.epoch) { this.revision = result.revision; this.update({ error: "" }); }
    } catch (error) {
      if (epoch !== this.epoch) return;
      // A conflict never replays stale intent. The next explicit action can save against the fresh revision.
      this.pending = null;
      if (error instanceof WorkspaceError && error.status === 409) {
        try { const latest = await request<NavigationBookmark>("/api/navigation"); if (epoch === this.epoch) this.revision = latest.revision; } catch { /* Keep local navigation. */ }
      }
      if (epoch === this.epoch) this.update({ error: `Navigation was not saved. Your local selection is preserved. ${workspaceFailure(error)}` });
    } finally { if (epoch === this.epoch) { this.busy = false; if (this.pending) this.schedule(); } }
  }
  open = async (cwd: string, canActivate: () => boolean = () => true, activate?: (result: RegistrationResponse) => boolean) => {
    const epoch = this.epoch, intent = ++this.intent, registration = ++this.registration, auth = workspaceEpoch();
    try {
      const result = await request<RegistrationResponse>("/api/workspaces", { method: "POST", body: JSON.stringify({ cwd }) });
      if (epoch !== this.epoch || registration !== this.registration || auth !== workspaceEpoch()) return false;
      this.update({ workspaces: [...this.state.workspaces.filter(w => w.workspaceId !== result.workspaceId), result.workspace], error: "" });
      if (intent !== this.intent || !canActivate()) return false;
      if (epoch !== this.epoch || registration !== this.registration || auth !== workspaceEpoch() || intent !== this.intent) return false;
      if (activate) return activate(result);
      this.navigate({ workspaceId: result.workspaceId, worktreeId: result.worktreeId, filePath: null, comparison: null });
      return true;
    } catch (error) { if (epoch === this.epoch && registration === this.registration) this.update({ error: workspaceFailure(error) }); return false; }
  };
  create = async (input: WorkspaceCreationInput, canActivate: () => boolean, activate?: (result: RegistrationResponse) => boolean): Promise<"activated" | "created" | "failed" | "unconfirmed"> => {
    const epoch = this.epoch, intent = ++this.intent, registration = ++this.registration, auth = workspaceEpoch();
    const current = () => epoch === this.epoch && registration === this.registration && auth === workspaceEpoch();
    try {
      const result = await request<RegistrationResponse>("/api/workspaces/create", { method: "POST", body: JSON.stringify(input) });
      if (!current()) return "created";
      this.update({ workspaces: [...this.state.workspaces.filter(w => w.workspaceId !== result.workspaceId), result.workspace], error: "" });
      if (intent !== this.intent || !canActivate() || !current()) return "created";
      if (activate) return activate(result) ? "activated" : "created";
      this.navigate({ workspaceId: result.workspaceId, worktreeId: result.worktreeId, filePath: null, comparison: null });
      return "activated";
    } catch (error) {
      const unconfirmed = !(error instanceof WorkspaceError);
      if (current()) this.update({ error: unconfirmed ? "Creation outcome is unconfirmed. Check creation using the same request before trying another destination." : workspaceFailure(error) });
      return unconfirmed ? "unconfirmed" : "failed";
    }
  };
  refresh = async (workspaceId: string, cwd: string) => {
    const epoch = this.epoch, registration = ++this.registration;
    try {
      // Re-register the same checkout to discover worktrees, never activate the returned checkout.
      const result = await request<RegistrationResponse>("/api/workspaces", { method: "POST", body: JSON.stringify({ cwd }) });
      if (epoch !== this.epoch || registration !== this.registration) return false;
      if (result.workspaceId !== workspaceId) throw new Error("This directory now belongs to a different workspace. Open it explicitly to switch.");
      this.update({ workspaces: this.state.workspaces.map(w => w.workspaceId === workspaceId ? result.workspace : w), error: "" });
      return true;
    } catch (error) { if (epoch === this.epoch && registration === this.registration) this.update({ error: workspaceFailure(error) }); return false; }
  };
  setAlias = async (workspaceId: string, worktreeId: string, alias: string | null) => {
    try {
      const result = await request<{ workspace: WorkspaceRecord }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/worktrees/${encodeURIComponent(worktreeId)}/alias`, { method: "PUT", body: JSON.stringify({ alias }) });
      this.update({ workspaces: this.state.workspaces.map(w => w.workspaceId === workspaceId ? result.workspace : w), error: "" });
      return true;
    } catch (error) { this.update({ error: workspaceFailure(error) }); return false; }
  };
  removeWorktree = async (workspaceId: string, worktreeId: string, force = false): Promise<{ ok: true; fallbackWorktreeId: string } | { ok: false; code?: string; error: string }> => {
    try {
      const result = await request<{ workspace: WorkspaceRecord; fallbackWorktreeId: string }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/worktrees/${encodeURIComponent(worktreeId)}`,
        { method: "DELETE", body: JSON.stringify({ force }) },
      );
      this.update({ workspaces: this.state.workspaces.map(w => w.workspaceId === workspaceId ? result.workspace : w), error: "" });
      if (this.state.navigation.workspaceId === workspaceId && this.state.navigation.worktreeId === worktreeId) {
        this.navigate({ workspaceId, worktreeId: result.fallbackWorktreeId, filePath: null, comparison: null });
      }
      return { ok: true, fallbackWorktreeId: result.fallbackWorktreeId };
    } catch (error) {
      const code = error instanceof WorkspaceError ? error.code : undefined;
      return { ok: false, code, error: workspaceFailure(error) };
    }
  };
}
export const catalog = new CatalogStore();
export const worktreeScope = (workspaceId: string, worktreeId: string) => JSON.stringify([workspaceId, worktreeId]);
