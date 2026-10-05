import type { CatalogResponse, NavigationBookmark, RegistrationResponse, WorkspaceRecord } from "../src/catalog-contract";
import { WorkspaceError } from "./workspace-client";
import { workspaceEpoch, workspaceFailure } from "./workspace-store";

const empty = (): NavigationBookmark => ({ revision: 0, workspaceId: null, worktreeId: null, conversationId: null, view: "chat", filePath: null, comparison: null });
type CatalogState = { workspaces: WorkspaceRecord[]; navigation: NavigationBookmark; ready: boolean; loading: boolean; error: string };
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(25000), ...init, headers: { "Content-Type": "application/json" } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new WorkspaceError(body.error || `Request failed (${response.status}).`, response.status, body.code);
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
  state: CatalogState = { workspaces: [], navigation: empty(), ready: false, loading: false, error: "" };
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = () => this.state;
  private update(patch: Partial<CatalogState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()); }
  invalidate = () => { this.epoch++; this.intent++; clearTimeout(this.timer); this.pending = null; this.busy = false; this.update({ ready: false, loading: false }); };
  hydrate = async (restore: (bookmark: NavigationBookmark) => void) => {
    if (this.state.loading || this.state.ready) return;
    const epoch = this.epoch, intent = this.intent;
    this.update({ loading: true, error: "" });
    try {
      const [catalog, navigation] = await Promise.all([request<CatalogResponse>("/api/workspaces"), request<NavigationBookmark>("/api/navigation")]);
      if (epoch !== this.epoch) return;
      this.revision = navigation.revision;
      // Publish readiness with the restored bookmark, never with a stale browsing
      // pair that could erase client-side context while hydration is in progress.
      if (intent === this.intent) { this.update({ workspaces: catalog.workspaces, ready: true, loading: false, navigation }); restore(navigation); }
      else { this.update({ workspaces: catalog.workspaces, ready: true, loading: false }); if (this.pending) this.schedule(); }
    } catch (error) { if (epoch === this.epoch) this.update({ loading: false, error: workspaceFailure(error) }); }
  };
  navigate = (patch: Partial<Omit<NavigationBookmark, "revision">>) => {
    this.intent++;
    const navigation = { ...this.state.navigation, ...patch };
    this.update({ navigation }); this.pending = navigation;
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
}
export const catalog = new CatalogStore();
export const worktreeScope = (workspaceId: string, worktreeId: string) => JSON.stringify([workspaceId, worktreeId]);
