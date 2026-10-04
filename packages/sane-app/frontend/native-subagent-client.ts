import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { NativeSubagentKey, NativeSubagentList, NativeSubagentPage, NativeSubagentSummary } from "../src/native-subagent-contract";
import { ApiError, request } from "./cc-client";
import { nativeSubagentId } from "./native-subagent-presentation";

export type NativeSubagentSnapshot = NativeSubagentPage & { pages: number };
type State = { summaries: Map<string, NativeSubagentSummary>; revision?: string; nextCursor: string | null; loading: boolean; error?: string; details: Map<string, NativeSubagentSnapshot>; detailLoading: boolean; detailError?: string };
const failure = (error: unknown) => error instanceof Error ? error.message : "Native subagent activity unavailable";
const reset = (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === "native-subagent-reset";

export class NativeSubagentClient {
  private state: State = { summaries: new Map(), nextCursor: null, loading: false, details: new Map(), detailLoading: false };
  private listeners = new Set<() => void>();
  private listController?: AbortController;
  private detailController?: AbortController;
  private listPages = 1;
  private listKeys: string[] = [];
  private requestGeneration = 0;
  private summaryGenerations = new Map<string, number>();
  private desiredPages = 1;
  private active: NativeSubagentKey | null = null;
  private listTimer?: ReturnType<typeof setTimeout>;
  private detailTimer?: ReturnType<typeof setTimeout>;
  private running = false;
  constructor(readonly sessionId: string) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private publish(value: Partial<State>) { this.state = { ...this.state, ...value }; this.listeners.forEach(listener => listener()); }
  private mergeSummaries(incoming: NativeSubagentSummary[], generation: number) {
    // List paging must not discard known detail-only summaries.
    const summaries = new Map(this.state.summaries);
    for (const summary of incoming) {
      const id = nativeSubagentId(summary), previous = summaries.get(id);
      const seq = summary.statusEvidence?.seq, previousSeq = previous?.statusEvidence?.seq;
      // Native evidence orders independent list/detail streams. Equal or absent
      // sequences use request freshness, including parent-end resets to unknown.
      if (previous && (seq !== undefined && previousSeq !== undefined && seq !== previousSeq
        ? seq < previousSeq
        : generation < (this.summaryGenerations.get(id) ?? 0))) continue;
      summaries.set(id, summary); this.summaryGenerations.set(id, generation);
    }
    return summaries;
  }
  private url(key?: NativeSubagentKey, cursor?: string) {
    const base = `/api/sessions/${encodeURIComponent(this.sessionId)}/native-subagents`;
    return `${base}${key ? `/${encodeURIComponent(key.runId)}/${encodeURIComponent(key.parentToolUseId)}` : ""}?${new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) })}`;
  }
  private async fetchPage<T>(key: NativeSubagentKey | undefined, cursor: string | undefined, signal: AbortSignal): Promise<T> {
    return request(this.url(key, cursor), { signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]) });
  }
  start() {
    if (this.running || !this.sessionId) return;
    this.running = true;
    void this.refreshList();
  }
  stop() {
    this.running = false;
    this.listController?.abort(); this.detailController?.abort();
    clearTimeout(this.listTimer); clearTimeout(this.detailTimer);
  }
  loadMoreSummaries = () => { if (!this.state.loading && this.state.nextCursor) { this.listPages++; void this.refreshList(); } };
  retryList = () => { if (!this.state.loading) void this.refreshList(); };
  private async refreshList() {
    clearTimeout(this.listTimer);
    const controller = new AbortController();
    this.listController?.abort(); this.listController = controller;
    const generation = ++this.requestGeneration;
    // Detail-only tuples belong in the canonical map, not the list paging anchor.
    const previousLast = this.listKeys.at(-1);
    this.publish({ loading: true });
    try {
      let complete: (NativeSubagentList & { pages: number }) | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          let page = await this.fetchPage<NativeSubagentList>(undefined, undefined, controller.signal);
          const revision = page.revision, subagents = [...page.subagents];
          let pages = 1;
          while (page.nextCursor && (pages < this.listPages || previousLast && !subagents.some(summary => nativeSubagentId(summary) === previousLast))) {
            page = await this.fetchPage<NativeSubagentList>(undefined, page.nextCursor, controller.signal);
            if (page.revision !== revision) throw new ApiError("Native subagent history changed. Reloading a coherent snapshot.", 409, "native-subagent-reset");
            subagents.push(...page.subagents);
            pages++;
          }
          if (subagents.some(summary => summary.parentSessionId !== this.sessionId)) throw new Error("Native subagent summaries did not match the requested parent.");
          complete = { ...page, revision, subagents, pages }; break;
        } catch (error) { if (!reset(error) || attempt === 2) throw error; }
      }
      if (!controller.signal.aborted && complete) {
        this.listPages = Math.max(this.listPages, complete.pages);
        this.listKeys = complete.subagents.map(nativeSubagentId);
        this.publish({ summaries: this.mergeSummaries(complete.subagents, generation), revision: complete.revision, nextCursor: complete.nextCursor, error: undefined });
      }
    } catch (error) { if (!controller.signal.aborted) this.publish({ error: failure(error) }); }
    finally {
      if (!controller.signal.aborted) {
        this.publish({ loading: false });
        if (this.running) this.listTimer = setTimeout(() => void this.refreshList(), 2000);
      }
    }
  }
  activate(key: NativeSubagentKey | null) {
    this.detailController?.abort(); clearTimeout(this.detailTimer);
    this.active = key;
    this.desiredPages = key ? this.state.details.get(nativeSubagentId(key))?.pages ?? 1 : 1;
    this.publish({ detailError: undefined, detailLoading: false });
    if (key) void this.refreshDetail();
  }
  loadEarlier = () => {
    if (!this.active || this.state.detailLoading || !this.state.details.get(nativeSubagentId(this.active))?.nextCursor) return;
    this.desiredPages++; void this.refreshDetail();
  };
  retryDetail = () => { if (this.active && !this.state.detailLoading) void this.refreshDetail(); };
  private async refreshDetail() {
    const key = this.active;
    if (!key) return;
    clearTimeout(this.detailTimer);
    const controller = new AbortController();
    this.detailController?.abort(); this.detailController = controller;
    const generation = ++this.requestGeneration;
    const id = nativeSubagentId(key), previous = this.state.details.get(id);
    this.publish({ detailLoading: true });
    try {
      let complete: NativeSubagentSnapshot | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          let page = await this.fetchPage<NativeSubagentPage>(key, undefined, controller.signal);
          if (nativeSubagentId(page.subagent) !== id) throw new Error("Native subagent identity did not match the requested activity.");
          if (previous && page.revision === previous.revision && this.desiredPages <= previous.pages) { complete = { ...previous, subagent: page.subagent }; break; }
          const revision = page.revision;
          let pages = 1;
          let messages = page.messages;
          const subagent = page.subagent;
          while (page.nextCursor && (pages < this.desiredPages || previous?.messages[0] && !messages.some(message => message.id === previous.messages[0]!.id))) {
            page = await this.fetchPage<NativeSubagentPage>(key, page.nextCursor, controller.signal);
            if (page.revision !== revision) throw new ApiError("Native subagent history changed. Reloading a coherent snapshot.", 409, "native-subagent-reset");
            if (nativeSubagentId(page.subagent) !== id) throw new Error("Native subagent identity did not match the requested activity.");
            messages = [...page.messages, ...messages]; pages++;
          }
          complete = { ...page, subagent, revision, messages, pages }; break;
        } catch (error) { if (!reset(error) || attempt === 2) throw error; }
      }
      if (!controller.signal.aborted && complete) {
        this.desiredPages = Math.max(this.desiredPages, complete.pages);
        const details = new Map(this.state.details); details.set(id, complete);
        this.publish({ summaries: this.mergeSummaries([complete.subagent], generation), details, detailError: undefined });
      }
    } catch (error) { if (!controller.signal.aborted) this.publish({ detailError: failure(error) }); }
    finally {
      if (!controller.signal.aborted) {
        this.publish({ detailLoading: false });
        if (this.running && this.active) this.detailTimer = setTimeout(() => void this.refreshDetail(), 1500);
      }
    }
  }
}

export function useNativeSubagentClient(sessionId: string, enabled: boolean, identity: string) {
  const client = useMemo(() => new NativeSubagentClient(sessionId), [sessionId, identity]);
  const state = useSyncExternalStore(client.subscribe, client.snapshot);
  useEffect(() => { if (enabled) client.start(); return () => client.stop(); }, [client, enabled]);
  return { client, state };
}
