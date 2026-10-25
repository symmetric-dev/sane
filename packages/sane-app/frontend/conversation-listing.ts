import type { ConversationClient, SessionCatalogQuery, SessionCatalogGroupsResponse } from "./types";

type Listing = Awaited<ReturnType<ConversationClient["conversations"]>>;
type Summaries = Awaited<ReturnType<NonNullable<ConversationClient["conversationSummaries"]>>>;
type Value = Listing | Summaries | SessionCatalogGroupsResponse;
type Request = { controller: AbortController; promise: Promise<Value>; consumers: number };

/** Stable scope identity, deliberately independent of snapshot continuation. */
export function conversationQueryKey(query: SessionCatalogQuery = {}): string {
  return JSON.stringify([query.mode ?? "chat", query.workspaceId ?? null, query.worktreeId ?? null,
    query.harness ?? "all", query.status ?? "all", query.workstreamId ?? "", query.phase ?? "",
    query.showDeleted ?? false, query.availableOnly ?? false, query.query ?? "", query.limit ?? 50]);
}

export function validConversationGroups(value: unknown): value is SessionCatalogGroupsResponse {
  const data = value as SessionCatalogGroupsResponse | undefined;
  if (!data || !Array.isArray(data.groups) || typeof data.availability?.canSend !== "boolean") return false;
  const keys = new Set<string>();
  return data.groups.every(group => {
    if (!group || ![group.workspaceId, group.worktreeId].every(id => id === null || typeof id === "string" && !!id)
      || !Number.isSafeInteger(group.total) || group.total < 1) return false;
    const key = JSON.stringify([group.workspaceId, group.worktreeId]);
    if (keys.has(key)) return false;
    keys.add(key); return true;
  });
}

/** Acquisition only: callers retain their own publication and lifecycle fences.
 * Both sidebar pages and direct summaries coalesce without sharing identities. */
export class ConversationListing {
  revision = 0;
  private cached = new Map<string, { value: Value; at: number }>();
  private pending = new Map<string, Request>();
  constructor(private load: ConversationClient["conversations"], private freshnessMs = 1000,
    private now = () => performance.now(), private summaries?: ConversationClient["conversationSummaries"],
    private groups?: ConversationClient["conversationGroups"]) {}

  invalidate() {
    this.revision++; this.cached.clear();
    const pending = [...this.pending.values()]; this.pending.clear();
    pending.forEach(request => request.controller.abort());
  }

  read(signal: AbortSignal, freshnessMs = this.freshnessMs, query?: SessionCatalogQuery): Promise<{ value: Listing; revision: number }> {
    const key = query ? `${conversationQueryKey(query)}:${JSON.stringify(query.cursor ?? null)}` : "legacy";
    return this.acquire(key, signal, freshnessMs, signal => this.load(signal, query)) as Promise<{ value: Listing; revision: number }>;
  }

  readSummaries(ids: string[], signal: AbortSignal, freshnessMs = this.freshnessMs): Promise<{ value: Summaries; revision: number }> {
    if (!this.summaries) throw new Error("Targeted conversation summaries are unavailable.");
    const sorted = [...new Set(ids)].sort();
    return this.acquire(`ids:${JSON.stringify(sorted)}`, signal, freshnessMs, signal => this.summaries!(sorted, signal)) as Promise<{ value: Summaries; revision: number }>;
  }

  readGroups(query: SessionCatalogQuery, signal: AbortSignal, freshnessMs = this.freshnessMs): Promise<{ value: SessionCatalogGroupsResponse; revision: number }> {
    if (!this.groups) throw new Error("Conversation group directory is unavailable.");
    const { cursor: _, ...base } = query;
    return this.acquire(`groups:${conversationQueryKey(base)}`, signal, freshnessMs, signal => this.groups!(base, signal)) as Promise<{ value: SessionCatalogGroupsResponse; revision: number }>;
  }

  private async acquire(key: string, signal: AbortSignal, freshnessMs: number, load: (signal: AbortSignal) => Promise<Value>): Promise<{ value: Value; revision: number }> {
    for (;;) {
      signal.throwIfAborted();
      const revision = this.revision, cached = this.cached.get(key);
      if (cached && this.now() - cached.at < freshnessMs) return { value: cached.value, revision };
      const request = this.pending.get(key) ?? this.start(key, load);
      try {
        const value = await this.join(key, request, signal);
        signal.throwIfAborted();
        if (revision === this.revision) return { value, revision };
      } catch (error) {
        signal.throwIfAborted();
        if (revision === this.revision) throw error;
      }
    }
  }

  private start(key: string, load: (signal: AbortSignal) => Promise<Value>): Request {
    const controller = new AbortController();
    const request: Request = { controller, consumers: 0, promise: Promise.resolve().then(() => { controller.signal.throwIfAborted(); return load(controller.signal); }) };
    this.pending.set(key, request);
    request.promise = request.promise.then(value => {
      if (key.startsWith("groups:")) {
        if (!validConversationGroups(value)) throw new Error("Invalid conversation group directory.");
      } else if (!("conversations" in value) || !Array.isArray(value.conversations) || value.conversations.some(conversation => !conversation || typeof conversation.id !== "string" || !conversation.id)) throw new Error("Invalid conversation listing.");
      if (this.pending.get(key) === request && !controller.signal.aborted) {
        this.cached.delete(key); this.cached.set(key, { value, at: this.now() });
        // Snapshot cursors and arbitrary targeted sets must not grow the cache forever.
        while (this.cached.size > 64) this.cached.delete(this.cached.keys().next().value!);
      }
      return value;
    }).finally(() => { if (this.pending.get(key) === request) this.pending.delete(key); });
    return request;
  }

  private join(key: string, request: Request, signal: AbortSignal): Promise<Value> {
    request.consumers++;
    let abort: () => void;
    return new Promise<Value>((resolve, reject) => {
      abort = () => reject(signal.aborted ? signal.reason : request.controller.signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      request.controller.signal.addEventListener("abort", abort, { once: true });
      request.promise.then(resolve, reject);
      if (signal.aborted || request.controller.signal.aborted) abort();
    }).finally(() => {
      signal.removeEventListener("abort", abort);
      request.controller.signal.removeEventListener("abort", abort);
      if (--request.consumers === 0 && this.pending.get(key) === request) {
        this.pending.delete(key); request.controller.abort();
      }
    });
  }
}
