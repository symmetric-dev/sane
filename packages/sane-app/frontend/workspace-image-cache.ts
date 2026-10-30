import type { WorktreeResolution } from "../src/catalog-contract";
import { catalog } from "./catalog";
import { subscribeWorkspaceMutations, workspaceClient } from "./workspace-client";
import type { WorktreeDirectories } from "./workspace-directory-cache";
import { pathFence, requestFence, rootState, subscribeWorkspace, workspaceEpoch, workspaceFailure } from "./workspace-store";

export const IMAGE_CACHE_LIMITS = { items: 5, bytes: 50 * 1024 * 1024, requests: 2, refreshMs: 5000 } as const;
type Scope = { id: string; workspace: WorktreeResolution; auth: number; reader: Pick<WorktreeDirectories, "current"> };
type Preview = { src?: string; error?: string; checking?: boolean };
type Source = { key: string; scopeId: string; binding: string; path: string; current: () => boolean };
type Request = { controller: AbortController };
type Entry = Source & { users: number; preview: Preview; blob?: Blob; version?: string; request?: Request };
type Job = { entry: Entry; request: Request };

function source(scope: Scope, path: string): Source {
  const workspace = scope.workspace, root = rootState(workspace), unchanged = pathFence(root, path);
  const revision = root.buffers.get(path)?.file.revision ?? null;
  const valid = requestFence(workspace, () => {
    if (scope.auth !== workspaceEpoch() || !unchanged()) return false;
    const buffer = root.buffers.get(path);
    if (buffer?.missing || buffer?.error || root.mutations.has(path) || (buffer?.file.revision ?? null) !== revision) return false;
    const tree = catalog.state.workspaces.find(item => item.workspaceId === workspace.catalogWorkspaceId)?.worktrees.find(item => item.worktreeId === workspace.worktreeId);
    // Cache lifetime is independent of a browsing lease; leaving Files does not
    // discard images. A changed catalog binding or authentication still does.
    return catalog.state.ready ? tree?.state === "available" && tree.bindingRevision === workspace.bindingRevision && tree.root === workspace.root : scope.reader.current();
  });
  return { key: JSON.stringify([scope.id, workspace.bindingRevision, workspace.root, scope.auth, root.generation, path, root.pathVersions.get(path), revision]),
    scopeId: scope.id, binding: workspace.workspaceId, path, current: valid };
}

/** Keeps compressed bytes/object URLs, never mounted images or decoded bitmaps.
 * Requests belong to this bounded cache, not to whichever file is on screen. */
class WorkspaceImageCache {
  private entries = new Map<string, Entry>();
  private queue: Job[] = [];
  private running = 0;
  private bytes = 0;
  private revision = 0;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.revision;
  private notify() { this.revision++; this.listeners.forEach(listener => listener()); }

  peek(scope: Scope, path: string): Preview | undefined {
    const entry = this.entries.get(source(scope, path).key);
    return entry?.current() ? entry.preview : undefined;
  }
  acquire(scope: Scope, path: string) {
    const input = source(scope, path);
    if (!input.current()) return () => {};
    let entry = this.entries.get(input.key);
    if (entry && !entry.current()) { this.remove(entry); entry = undefined; }
    if (!entry) entry = { ...input, users: 0, preview: {} };
    const owner = entry;
    owner.current = input.current;
    owner.users++;
    // Map insertion order is last-viewed order, not download-completion order.
    this.entries.delete(owner.key); this.entries.set(owner.key, owner);
    this.enqueue(owner); this.trim();
    let released = false;
    return () => {
      if (released) return;
      released = true; owner.users--;
      // Keep pending reads alive for quick back-and-forth navigation.
      this.trim();
    };
  }
  revalidate(scope: Scope, path: string) {
    const entry = this.entries.get(source(scope, path).key);
    if (entry) this.enqueue(entry);
  }
  invalidate(scopeId: string, binding: string, paths: readonly string[]) {
    for (const entry of [...this.entries.values()]) {
      if (entry.scopeId !== scopeId || entry.binding !== binding || !paths.includes(entry.path)) continue;
      if (!entry.users || !entry.current()) { this.remove(entry); continue; }
      this.cancel(entry);
      this.releaseBytes(entry); entry.preview = {};
      this.enqueue(entry);
    }
  }
  prune = () => {
    for (const entry of [...this.entries.values()]) if (!entry.current()) this.remove(entry);
  };
  clear = () => { for (const entry of [...this.entries.values()]) this.remove(entry); };

  private releaseBytes(entry: Entry) {
    if (entry.preview.src) URL.revokeObjectURL(entry.preview.src);
    this.bytes -= entry.blob?.size ?? 0;
    entry.blob = undefined; entry.version = undefined;
  }
  private cancel(entry: Entry) {
    entry.request?.controller.abort(); entry.request = undefined;
    this.queue = this.queue.filter(job => job.entry !== entry);
  }
  private remove(entry: Entry) {
    if (this.entries.get(entry.key) !== entry) return;
    this.entries.delete(entry.key);
    this.cancel(entry);
    this.releaseBytes(entry); entry.preview = {};
    this.notify();
  }
  private trim() {
    while (this.entries.size > IMAGE_CACHE_LIMITS.items || this.bytes > IMAGE_CACHE_LIMITS.bytes) {
      // Do not revoke the currently displayed resource to make room for a hidden one.
      const oldest = [...this.entries.values()].find(entry => !entry.users);
      if (!oldest) break;
      this.remove(oldest);
    }
  }
  private enqueue(entry: Entry) {
    if (entry.request || this.entries.get(entry.key) !== entry) return;
    if (!entry.current()) { this.remove(entry); return; }
    const request = { controller: new AbortController() };
    entry.request = request;
    entry.preview = { src: entry.preview.src, checking: true };
    this.queue.push({ entry, request });
    this.notify(); this.drain();
  }
  private drain() {
    while (this.running < IMAGE_CACHE_LIMITS.requests && this.queue.length) {
      const job = this.queue.shift()!;
      if (job.entry.request !== job.request) continue;
      if (!job.entry.current()) { this.remove(job.entry); continue; }
      this.running++;
      void this.read(job).finally(() => {
        if (job.entry.request === job.request) {
          job.entry.request = undefined;
          if (!job.entry.current()) this.remove(job.entry);
        }
        this.running--; this.drain();
      });
    }
  }
  private async read({ entry, request }: Job) {
    const signal = AbortSignal.any([request.controller.signal, AbortSignal.timeout(30000)]);
    const current = () => !request.controller.signal.aborted && entry.request === request && this.entries.get(entry.key) === entry && entry.current();
    try {
      if (entry.version && entry.preview.src) {
        const version = await workspaceClient.imageVersion(entry.scopeId, entry.binding, entry.path, signal);
        if (!current()) return;
        if (entry.version === version) {
          entry.preview = { src: entry.preview.src }; this.notify(); return;
        }
        this.releaseBytes(entry); entry.preview = { checking: true }; this.notify();
      }
      const { blob, version } = await workspaceClient.image(entry.scopeId, entry.binding, entry.path, signal);
      if (!current()) return;
      if (blob.size > IMAGE_CACHE_LIMITS.bytes) throw new Error("Image exceeds the preview memory limit.");
      const src = URL.createObjectURL(blob);
      entry.blob = blob; entry.version = version; this.bytes += blob.size;
      entry.preview = { src }; this.notify(); this.trim();
    } catch (error) {
      if (!current()) return;
      // Failed access/version checks must not leave a stale image displayed.
      this.releaseBytes(entry);
      const message = workspaceFailure(error);
      if (!current()) return;
      entry.preview = { error: message }; this.notify();
    }
  }
}

export const workspaceImageCache = new WorkspaceImageCache();
// Global invalidation also covers cached images that have no mounted reader.
subscribeWorkspaceMutations(mutation => workspaceImageCache.invalidate(mutation.scopeId, mutation.workspaceId, mutation.paths));
subscribeWorkspace(workspaceImageCache.prune);
catalog.subscribe(workspaceImageCache.prune);
