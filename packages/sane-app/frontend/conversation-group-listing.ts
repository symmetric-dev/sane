import { ConversationListing, conversationQueryKey } from "./conversation-listing";
import type { Availability, Conversation, ConversationGroupPage, ConversationGroupDirectory, SessionCatalogGroup, SessionCatalogGroupsResponse, SessionCatalogQuery } from "./types";
export type { ConversationGroupPage, ConversationGroupDirectory } from "./types";

type Entry = {
  query: SessionCatalogQuery; page: ConversationGroupPage; loaded: boolean; cursor: string | null;
  pinned: boolean; moreError: string; controller?: AbortController; task?: Promise<void>; legacyIds?: string[];
  intentEpoch: number; moreIntent?: Promise<void>;
};
type Directory = ConversationGroupDirectory & { query: SessionCatalogQuery; loaded: boolean; controller?: AbortController; task?: Promise<void> };
type Job = { signal: AbortSignal; start(): void; cancel(): void };
type Options = {
  listing: ConversationListing; nativeDirectory: boolean;
  ready(): boolean; hidden(): boolean; delay(): number; serial(): number; expired(error: unknown): boolean;
  missing(id: string): boolean;
  rows(): readonly Conversation[];
  merge(rows: Conversation[], availability: Availability, serial: number, head: boolean): void;
  available(availability: Availability): void;
  publish(groups: Record<string, ConversationGroupPage>, directory: ConversationGroupDirectory, ids: string[]): void;
};
const emptyPage = (): ConversationGroupPage => ({ ids: [], hasMore: false, loading: false, loadingMore: false, error: "" });
export const conversationGroupPageSize = (mode: SessionCatalogQuery["mode"]) => mode === "history" ? 5 : 3;
const normalize = (query: SessionCatalogQuery): SessionCatalogQuery => ({ ...query, limit: conversationGroupPageSize(query.mode), cursor: undefined });

/** Query/auth-owned sidebar state. Selected-chat generations never own these
 * requests. Only directory + expanded HEADS poll; frozen tails are read on demand. */
export class ConversationGroupListing {
  enabled = false;
  private base: SessionCatalogQuery = normalize({ mode: "chat" });
  private baseKey = conversationQueryKey(this.base);
  private expanded = new Map<string, SessionCatalogQuery>();
  private entries = new Map<string, Entry>();
  private directories = new Map<string, Directory>();
  private timer?: ReturnType<typeof setTimeout>;
  private active = 0;
  private queue: Job[] = [];
  constructor(private options: Options) {}

  configure(base: SessionCatalogQuery, expanded: SessionCatalogQuery[]) {
    const next = normalize(base), key = conversationQueryKey(next);
    const queries = new Map(expanded.map(query => {
      const exact = normalize({ ...next, workspaceId: query.workspaceId ?? "unavailable", worktreeId: query.worktreeId ?? "unavailable" });
      return [conversationQueryKey(exact), exact] as const;
    }));
    const changed = !this.enabled || key !== this.baseKey;
    const added = [...queries.keys()].some(key => !this.expanded.has(key));
    if (changed) this.pause();
    else for (const [key, entry] of this.entries) if (!queries.has(key)) this.abortEntry(entry);
    this.enabled = true; this.base = next; this.baseKey = key; this.expanded = queries;
    this.directory();
    for (const query of queries.values()) this.entry(query);
    this.prune();
    if (changed || added) { this.publish(); this.refresh(); }
    else this.publish();
  }

  disable() { this.pause(); this.enabled = false; }

  /** Authentication teardown, unlike ordinary collapse/scope switching. */
  clear() {
    // Suppress pause's normal cached publication: none of the previous owner's
    // filters, expanded queries, or cached rows may survive an auth boundary.
    this.enabled = false;
    this.pause(); this.entries.clear(); this.directories.clear(); this.expanded.clear();
    this.base = normalize({ mode: "chat" }); this.baseKey = conversationQueryKey(this.base);
    this.enabled = this.options.nativeDirectory;
    if (this.enabled) this.publish();
  }

  pause() {
    clearTimeout(this.timer); this.timer = undefined;
    for (const entry of this.entries.values()) this.abortEntry(entry);
    for (const directory of this.directories.values()) {
      directory.controller?.abort(); directory.controller = undefined; directory.task = undefined; directory.loading = false;
    }
    if (this.enabled) this.publish();
  }

  refresh = () => {
    if (!this.enabled || !this.options.ready() || this.options.hidden()) return;
    clearTimeout(this.timer); this.timer = undefined;
    // Start independently: a slow/failed directory never gates panel or chat reads.
    void this.refreshDirectory();
    for (const query of this.expanded.values()) void this.head(this.entry(query));
    this.timer = setTimeout(this.refresh, this.options.delay());
  };

  retryDirectory() {
    if (!this.enabled) return;
    const directory = this.directory();
    directory.controller?.abort(); directory.controller = undefined; directory.task = undefined;
    void this.refreshDirectory(0);
  }

  retry(query: SessionCatalogQuery) {
    const entry = this.visibleEntry(query);
    if (!entry || !this.options.ready() || this.options.hidden()) return;
    if (entry.moreError && entry.cursor) { void this.more(query, 0); return; }
    this.reset(entry); void this.head(entry, 0);
  }

  async more(query: SessionCatalogQuery, freshness = 1000): Promise<void> {
    const entry = this.visibleEntry(query);
    if (!entry || !this.options.ready() || this.options.hidden()) return;
    if (entry.moreIntent) return entry.moreIntent;
    if (entry.task && entry.page.loadingMore) return entry.task;
    if (!entry.cursor) return;
    const epoch = entry.intentEpoch;
    const current = () => entry.intentEpoch === epoch && this.visibleEntry(query) === entry && this.options.ready() && !this.options.hidden();
    // A background head leaves Show More enabled. Retain one explicit intent,
    // rather than dropping clicks or turning repeated clicks into a page drain.
    const intent = Promise.resolve().then(async () => {
      if (!current()) return;
      while (entry.task) {
        const continuation = entry.page.loadingMore;
        await entry.task;
        if (!current() || continuation) return;
      }
      if (entry.cursor && current()) await this.read(entry, true, freshness);
    }).finally(() => { if (entry.moreIntent === intent) entry.moreIntent = undefined; });
    entry.moreIntent = intent;
    return intent;
  }

  /** Fresh presentation can disqualify frozen-tail members without changing
   * snapshot offsets or removing summaries needed by open chats/history. */
  reconcileRows(rows: readonly Conversation[]) {
    if (this.pruneRows(rows) && this.enabled) this.publish();
  }

  private eligible(query: SessionCatalogQuery, row: Conversation): boolean {
    const history = query.mode === "history";
    if (!history && (row.worker || row.agentKind === "worker" || row.replacedBy)) return false;
    // Replaced history is intentionally visible even when its summary is
    // projected hidden; this is the catalog's explicit history exception.
    return !!query.showDeleted || !row.hidden || history && !!row.replacedBy;
  }

  private pruneRows(rows: readonly Conversation[]): boolean {
    const byId = new Map(rows.map(row => [row.id, row]));
    let changed = false;
    for (const entry of this.entries.values()) {
      const ids = entry.page.ids.filter(id => {
        const row = byId.get(id);
        return !row || this.eligible(entry.query, row);
      });
      if (ids.length !== entry.page.ids.length) {
        entry.page = { ...entry.page, ids }; changed = true;
      }
    }
    return changed;
  }

  forget(ids: string[]) {
    const missing = new Set(ids);
    for (const entry of this.entries.values()) {
      entry.page = { ...entry.page, ids: entry.page.ids.filter(id => !missing.has(id)) };
    }
    if (this.enabled) this.publish();
  }

  private visibleEntry(query: SessionCatalogQuery) {
    if (!this.enabled) return;
    const key = conversationQueryKey(normalize({ ...query, workspaceId: query.workspaceId ?? "unavailable", worktreeId: query.worktreeId ?? "unavailable" }));
    return this.expanded.has(key) ? this.entries.get(key) : undefined;
  }
  private entry(query: SessionCatalogQuery): Entry {
    const key = conversationQueryKey(query);
    let entry = this.entries.get(key);
    if (!entry) entry = { query, page: emptyPage(), loaded: false, cursor: null, pinned: false, moreError: "", intentEpoch: 0 };
    this.entries.delete(key); this.entries.set(key, entry);
    return entry;
  }
  private directory(): Directory {
    let directory = this.directories.get(this.baseKey);
    if (!directory) directory = { queryKey: this.baseKey, query: this.base, groups: [], loading: false, error: "", loaded: false };
    this.directories.delete(this.baseKey); this.directories.set(this.baseKey, directory);
    return directory;
  }
  private prune() {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= 128) break;
      if (this.expanded.has(key)) continue;
      this.abortEntry(entry); this.entries.delete(key);
    }
    for (const [key, directory] of this.directories) {
      if (this.directories.size <= 32) break;
      if (key === this.baseKey) continue;
      directory.controller?.abort(); this.directories.delete(key);
    }
  }
  private abortEntry(entry: Entry) {
    entry.intentEpoch++; entry.moreIntent = undefined;
    entry.controller?.abort(); entry.controller = undefined; entry.task = undefined;
    if (entry.page.loading || entry.page.loadingMore) entry.page = { ...entry.page, loading: false, loadingMore: false };
  }
  private reset(entry: Entry) {
    this.abortEntry(entry); entry.page = emptyPage(); entry.loaded = false;
    entry.cursor = null; entry.pinned = false; entry.moreError = ""; entry.legacyIds = undefined;
    this.publish();
  }
  private publish() {
    if (!this.enabled) return;
    const groups = Object.fromEntries([...this.entries].map(([key, entry]) => [key, entry.page]));
    const directory = this.directory();
    const ids = [...new Set([...this.expanded.keys()].flatMap(key => groups[key]?.ids ?? []))];
    this.options.publish(groups, { queryKey: directory.queryKey, groups: directory.groups, loading: directory.loading, error: directory.error }, ids);
  }
  private owner(controller: AbortController, baseKey: string) {
    return !controller.signal.aborted && this.enabled && this.baseKey === baseKey && this.options.ready();
  }

  private refreshDirectory(freshness = 1000): Promise<void> {
    if (!this.enabled || !this.options.ready() || this.options.hidden()) return Promise.resolve();
    const directory = this.directory();
    if (directory.task) return directory.task;
    const controller = directory.controller = new AbortController(), baseKey = this.baseKey;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]);
    const current = () => this.owner(controller, baseKey) && directory.controller === controller;
    directory.loading = !directory.loaded; this.publish();
    const task = (async () => {
      try {
        const data = await this.schedule(signal, async () => {
          if (this.options.nativeDirectory) {
            const acquired = await this.options.listing.readGroups(directory.query, signal, freshness);
            if (acquired.revision !== this.options.listing.revision) throw new Error("Conversation directory invalidated; retrying automatically.");
            return acquired.value;
          }
          const data = await this.legacy(directory.query, signal, freshness);
          const groups = new Map<string, SessionCatalogGroup>();
          for (const row of data.conversations) {
            const workspaceId = row.workspaceId ?? null, worktreeId = row.worktreeId ?? null;
            const key = JSON.stringify([workspaceId, worktreeId]);
            const group = groups.get(key);
            if (group) group.total++;
            else groups.set(key, { workspaceId, worktreeId, total: 1 });
          }
          return { groups: [...groups.values()], availability: data.availability } satisfies SessionCatalogGroupsResponse;
        });
        signal.throwIfAborted(); if (!current()) return;
        directory.groups = data.groups; directory.loaded = true; directory.error = "";
        this.options.available(data.availability);
      } catch (error) {
        if (current() && !this.options.expired(error)) directory.error = error instanceof Error ? error.message : "Conversation groups unavailable.";
      } finally {
        if (current()) { directory.loading = false; directory.controller = undefined; directory.task = undefined; this.publish(); }
      }
    })();
    directory.task = task; return task;
  }

  private head(entry: Entry, freshness = 1000): Promise<void> {
    if (entry.task) return entry.task;
    return this.read(entry, false, freshness);
  }
  private read(entry: Entry, more: boolean, freshness: number): Promise<void> {
    const controller = entry.controller = new AbortController(), baseKey = this.baseKey;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]);
    const current = () => this.owner(controller, baseKey) && entry.controller === controller && this.expanded.has(conversationQueryKey(entry.query));
    const cursor = more ? entry.cursor : null;
    if (more) { entry.pinned = true; entry.moreError = ""; }
    entry.page = { ...entry.page, loading: !more && !entry.loaded, loadingMore: more, ...(more ? { error: "" } : {}) };
    this.publish();
    const task = (async () => {
      try {
        const { data, serial } = await this.schedule(signal, async () => {
          const serial = this.options.serial();
          if (!this.options.nativeDirectory) {
            const all = await this.legacy(entry.query, signal, freshness);
            signal.throwIfAborted(); if (!current()) throw new Error("Conversation group invalidated.");
            const offset = cursor ? Number(cursor.slice("legacy:".length)) : 0;
            if (!more && !entry.pinned) entry.legacyIds = all.conversations.map(row => row.id);
            const ids = more ? entry.legacyIds ?? [] : all.conversations.map(row => row.id);
            const byId = new Map(all.conversations.map(row => [row.id, row]));
            const end = offset + conversationGroupPageSize(entry.query.mode), nextCursor = end < ids.length ? `legacy:${end}` : null;
            return { serial, data: { conversations: ids.slice(offset, end).flatMap(id => byId.get(id) ?? []), availability: all.availability,
              page: { kind: "partial" as const, nextCursor, hasMore: nextCursor !== null } } };
          }
          const acquired = await this.options.listing.read(signal, freshness, { ...entry.query, ...(cursor ? { cursor } : {}) });
          if (acquired.revision !== this.options.listing.revision) throw new Error("Conversation group invalidated; retrying automatically.");
          if (!acquired.value.page) throw new Error("This bridge does not support per-worktree conversation pagination.");
          return { data: acquired.value, serial };
        });
        signal.throwIfAborted(); if (!current()) return;
        const page = data.page!;
        const tail = more || entry.pinned ? entry.page.ids : [];
        if (more || !entry.pinned) { entry.cursor = page.nextCursor; if (!page.hasMore) entry.pinned = true; }
        this.options.merge(data.conversations, data.availability, serial, !more);
        if (!current()) return;
        const head = data.conversations.map(row => row.id);
        const ids = [...new Set(more ? [...tail, ...head] : [...head, ...tail])].filter(id => !this.options.missing(id));
        entry.loaded = true;
        entry.page = { ids, hasMore: entry.cursor !== null, loading: false, loadingMore: false, error: entry.moreError };
        // A stale snapshot row must not reinsert a member that a newer targeted
        // summary or explicit visibility change has already disqualified.
        this.pruneRows(this.options.rows());
        this.options.available(data.availability);
      } catch (error) {
        if (!current() || this.options.expired(error)) return;
        const api = error as { status?: number; code?: string };
        if (more && api.status === 409 && api.code === "session-catalog-reset") {
          // No global invalidation: other panels retain their frozen traversal.
          this.reset(entry); await this.head(entry, 0); return;
        }
        const message = error instanceof Error ? error.message : "Conversations unavailable.";
        if (more) entry.moreError = message;
        entry.page = { ...entry.page, error: message };
      } finally {
        if (current()) {
          entry.page = { ...entry.page, loading: false, loadingMore: false };
          entry.controller = undefined; entry.task = undefined; this.publish();
        }
      }
    })();
    entry.task = task; return task;
  }

  /** Optional-client compatibility only. Never silently treat a paginated
   * response as a complete directory, and never drain a global traversal. */
  private async legacy(query: SessionCatalogQuery, signal: AbortSignal, freshness: number) {
    if (query.query || query.workstreamId && query.workstreamId !== "all" || query.phase && query.phase !== "all") {
      throw new Error("This legacy conversation client cannot group by search or workstream filters.");
    }
    const acquired = await this.options.listing.read(signal, freshness);
    if (acquired.revision !== this.options.listing.revision) throw new Error("Conversation listing invalidated; retrying automatically.");
    if (acquired.value.page) throw new Error("Grouped browsing requires a conversation group directory; this legacy client returned only a partial listing.");
    const matches = (filter: string | null | undefined, value: string | null | undefined) => !filter || filter === "all" || (filter === "unavailable" ? !value : filter === value);
    return { ...acquired.value, conversations: acquired.value.conversations.filter(row =>
      matches(query.workspaceId, row.workspaceId) && matches(query.worktreeId, row.worktreeId)
      && (!query.harness || query.harness === "all" || row.harness === query.harness)
      && (!query.status || query.status === "all" || row.status === query.status)
      && (!query.availableOnly || row.association === "resolved")
      && this.eligible(query, row)) };
  }

  /** One small shared pool, including directory and continuation requests. Queue
   * cancellation removes collapsed/superseded work before it reaches the wire. */
  private schedule<T>(signal: AbortSignal, load: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        signal,
        cancel: () => {
          const index = this.queue.indexOf(job);
          if (index >= 0) this.queue.splice(index, 1);
          signal.removeEventListener("abort", job.cancel); reject(signal.reason);
        },
        start: () => {
          signal.removeEventListener("abort", job.cancel); this.active++;
          void Promise.resolve().then(() => { signal.throwIfAborted(); return load(); }).then(resolve, reject)
            .finally(() => { this.active--; this.pump(); });
        },
      };
      if (signal.aborted) { reject(signal.reason); return; }
      signal.addEventListener("abort", job.cancel, { once: true });
      this.queue.push(job); this.pump();
    });
  }
  private pump() {
    while (this.active < 3 && this.queue.length) {
      const job = this.queue.shift()!;
      if (job.signal.aborted) job.cancel(); else job.start();
    }
  }
}
