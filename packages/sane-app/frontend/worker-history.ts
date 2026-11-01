import type { TranscriptCompaction, TranscriptMetadataItem, TranscriptMetadataPage, TranscriptPage } from "../src/transcript-contract";
import type { ConversationClient, Harness, Run } from "./types";
import { ApiError } from "./cc-client";
import { createRun } from "./cc-reducer";
import { equalValue, mergePage, pageMessages, refreshPages, sameRunMetadata, TranscriptCoverageError, type PagedTranscript, type PageRequest } from "./transcript-pages";

export type WorkerHistorySnapshot = {
  pages: PagedTranscript | null;
  runs: Run[];
  loading: boolean;
  error: string;
  metadataError: string;
  busy: string;
  pageErrors: Record<string, string>;
};

export const workerPageKey = (edge: PageRequest) => `${edge.island}:${edge.direction}`;
const resetError = (error: unknown) => error instanceof TranscriptCoverageError || error instanceof ApiError &&
  (error.status === 409 || error.code === "transcript-reset" || error.code === "invalid-cursor" || error.status === 400 && /cursor/i.test(error.message));
const historyError = (error: unknown) => error instanceof ApiError && [404, 405, 501].includes(error.status)
  ? "Paged worker history is unavailable on this bridge. Update the bridge, then retry. Raw event replay is disabled."
  : `${error instanceof Error ? error.message : "Worker history unavailable."} Retry to reload bounded worker history.`;
class MetadataTraversalError extends Error {}
type MetadataProjection = { epoch: string; metadataRevision: string; runs: Run[]; compactions: TranscriptCompaction[] };

/** One reader per selected worker. Message pages/UPSERTs are serialized; a
 * separate coalesced metadata flight keeps status current during long refreshes.
 * Only lightweight metadata is drained, never message cursors. */
export class WorkerHistoryReader {
  private state: WorkerHistorySnapshot = { pages: null, runs: [], loading: true, error: "", metadataError: "", busy: "", pageErrors: {} };
  private lifetime = new AbortController();
  private identity = new AbortController();
  private queue: Promise<unknown> = Promise.resolve();
  private refreshedRevision = "";
  private coverageFence = 0;
  private pageOwner = 0;
  private nativeSessionId: string | undefined;
  private identityKnown = false;
  private metadataProjection?: MetadataProjection;
  private metadataFlight?: { signal: AbortSignal; promise: Promise<void> };
  private epochReload?: { epoch: string; signal: AbortSignal };

  constructor(private client: ConversationClient, private sessionId: string, private harness: Harness, private publish: (snapshot: WorkerHistorySnapshot) => void) {}

  get snapshot() { return this.state; }
  dispose() { this.lifetime.abort(); }

  private update(patch: Partial<WorkerHistorySnapshot>, signal: AbortSignal) {
    signal.throwIfAborted();
    this.state = { ...this.state, ...patch };
    this.publish(this.state);
  }
  private reset(signal: AbortSignal) {
    signal.throwIfAborted();
    this.coverageFence++;
    this.pageOwner++;
    this.refreshedRevision = "";
    this.update({ pages: null, runs: [], loading: true, error: "", busy: "", pageErrors: {} }, signal);
  }
  private serial<T>(signal: AbortSignal, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const combined = AbortSignal.any([signal, this.lifetime.signal]);
    const result = this.queue.then(() => { combined.throwIfAborted(); return read(combined); });
    this.queue = result.catch(() => {});
    return result;
  }
  private available() {
    if (!this.client.transcriptPage || !this.client.transcriptMeta || !this.client.transcriptRefresh) {
      throw new Error("Paged worker history is unavailable. Update the bridge/client, then retry. Raw event replay is disabled.");
    }
  }
  private accept(page: TranscriptPage, signal: AbortSignal, edge?: PageRequest) {
    signal.throwIfAborted();
    if (page.sessionId !== this.sessionId) throw new Error("Worker transcript session identity mismatch.");
    if (this.state.pages && page.epoch !== this.state.pages.summary.epoch) {
      if (edge) throw new ApiError("Worker history changed while loading a page.", 409, "transcript-reset");
      this.reset(signal);
    }
    let pages = mergePage(this.state.pages, page, edge, !edge, !!edge);
    if (edge) this.refreshedRevision = "";
    const metadata = this.metadataProjection;
    if (metadata?.epoch === page.epoch) pages = { ...pages, metadataRevision: metadata.metadataRevision, compactions: metadata.compactions };
    this.update({ pages, loading: false, ...(metadata?.epoch === page.epoch ? { runs: metadata.runs }
      : metadata ? { runs: [], metadataError: "Worker metadata and history epochs differ. Run/compaction status will retry." } : {}) }, signal);
  }

  private publishMetadata(metadata: MetadataProjection, signal: AbortSignal) {
    // Always reconcile against CURRENT coverage. This channel must never restore
    // the pages/summary it observed before an awaited metadata request.
    const pages = this.state.pages;
    if (pages && pages.summary.epoch !== metadata.epoch) {
      this.update({ metadataError: "Worker history changed. Reopening latest history; run/compaction status will retry." }, signal);
      this.requestEpochReload(metadata.epoch, signal);
      return;
    }
    this.update({ runs: metadata.runs, metadataError: "", ...(pages ? { pages: { ...pages,
      metadataRevision: metadata.metadataRevision, compactions: metadata.compactions } } : {}) }, signal);
    if (!pages) this.requestEpochReload(metadata.epoch, signal);
  }

  private requestEpochReload(epoch: string, signal: AbortSignal) {
    if (this.epochReload?.epoch === epoch && !this.epochReload.signal.aborted) return;
    const request = this.epochReload = { epoch, signal };
    const fence = this.coverageFence, expectedEpoch = this.state.pages?.summary.epoch;
    // Metadata only NOTIFIES the message channel. A fresh serialized tail must
    // confirm an epoch change before resetting coverage; an older metadata
    // observation must not erase a newer tail's still-valid loaded islands.
    void this.serial(signal, async signal => {
      if (this.metadataProjection?.epoch !== epoch) return;
      if (this.state.pages?.summary.epoch === epoch) return;
      if (fence !== this.coverageFence || expectedEpoch !== this.state.pages?.summary.epoch) return;
      await this.latest(signal);
    }).catch(() => { /* Cancellation is fenced; latest publishes read failures. */ }).finally(() => {
      if (this.epochReload === request) this.epochReload = undefined;
    });
  }

  private async metadata(signal: AbortSignal) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        this.available();
        const fence = this.coverageFence, startEpoch = this.state.pages?.summary.epoch;
        let cursor: string | undefined, head: TranscriptMetadataPage | undefined;
        const items: TranscriptMetadataItem[] = [], seen = new Set<string>();
        let projection: MetadataProjection | undefined;
        do {
          const page = await this.client.transcriptMeta!(this.sessionId, cursor, signal);
          signal.throwIfAborted();
          if (page.sessionId !== this.sessionId) throw new Error("Worker metadata session identity mismatch.");
          if (head && (page.epoch !== head.epoch || page.metadataRevision !== head.metadataRevision)) throw new MetadataTraversalError("Worker metadata changed during pagination.");
          head ??= page;
          if (!cursor && this.metadataProjection?.epoch === page.epoch && this.metadataProjection.metadataRevision === page.metadataRevision) {
            projection = this.metadataProjection;
            break;
          }
          items.push(...page.items);
          cursor = page.nextCursor ?? undefined;
          if (cursor && seen.has(cursor)) throw new Error("Worker metadata pagination did not advance.");
          if (cursor) seen.add(cursor);
        } while (cursor);
        const currentEpoch = this.state.pages?.summary.epoch;
        if (currentEpoch && currentEpoch !== head!.epoch && (fence !== this.coverageFence || startEpoch !== currentEpoch)) {
          throw new MetadataTraversalError("History reloaded while reading worker metadata.");
        }
        if (!projection) {
          const previous = new Map(this.state.runs.map(run => [run.id, run]));
          const runs = items.flatMap(item => {
            if (item.kind !== "run") return [];
            if (item.run.conversationId !== this.sessionId) throw new Error("Run identity does not match the selected worker.");
            // Never substitute the parent's native conversation for the child.
            const meta = { ...item.run, harness: this.harness, ...(this.nativeSessionId ? { nativeSessionId: this.nativeSessionId } : {}) };
            const old = previous.get(meta.id);
            return [old && sameRunMetadata(old, meta) ? old : { ...createRun(meta), summaryOnly: true as const }];
          }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          const proposed = items.flatMap(item => item.kind === "compaction" ? [item.compaction] : []);
          const old = this.metadataProjection?.compactions;
          projection = { epoch: head!.epoch, metadataRevision: head!.metadataRevision, runs, compactions: old && equalValue(old, proposed) ? old : proposed };
        }
        this.metadataProjection = projection;
        this.publishMetadata(projection, signal);
        return;
      } catch (error) {
        signal.throwIfAborted();
        // 409/mid-traversal churn here invalidates ONLY metadata pagination.
        // A coherent, differing epoch is the sole metadata proof for a reload.
        const unstable = error instanceof MetadataTraversalError || resetError(error);
        if (unstable && attempt < 2) continue;
        this.update({ metadataError: unstable
          ? "Worker run/compaction metadata did not stabilize after three reads. Loaded messages are preserved. Retry worker history to refresh status."
          : `Worker run/compaction status unavailable: ${historyError(error)}` }, signal);
        return;
      }
    }
  }

  private async refreshLoaded(signal: AbortSignal) {
    const pages = this.state.pages!;
    if (this.refreshedRevision === pages.summary.revision) return;
    const requested = pageMessages(pages).map(({ id, version }) => ({ id, version }));
    const { epoch, revision } = pages.summary;
    let stableRevision = revision;
    let tailReadAt = Date.now();
    for (let offset = 0; offset < requested.length;) {
      const batch = requested.slice(offset, offset + 100);
      const refresh = await this.client.transcriptRefresh!(this.sessionId, { epoch, messages: batch }, signal);
      signal.throwIfAborted();
      if (refresh.sessionId !== this.sessionId) throw new Error("Worker refresh session identity mismatch.");
      if (refresh.epoch !== epoch) throw new ApiError("Worker history epoch changed.", 409, "transcript-reset");
      if (!Number.isInteger(refresh.processed) || refresh.processed < 1 || refresh.processed > batch.length) throw new Error("Invalid worker transcript refresh progress.");
      this.update({ pages: refreshPages(this.state.pages!, refresh) }, signal);
      if (refresh.revision !== revision) stableRevision = "";
      offset += refresh.processed;
      // A user may have explicitly loaded many islands. Keep the visible tail
      // current during that finite version pass without following any cursors.
      if (Date.now() - tailReadAt >= 3000) {
        const tail = await this.client.transcriptPage!(this.sessionId, {}, signal);
        signal.throwIfAborted();
        if (tail.epoch !== epoch) throw new ApiError("Worker history epoch changed.", 409, "transcript-reset");
        this.accept(tail, signal);
        tailReadAt = Date.now();
        stableRevision = "";
      }
    }
    this.refreshedRevision = stableRevision;
  }

  private async latest(signal: AbortSignal) {
    // Bounded reset recovery; never drain message cursors or replay event logs.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        this.available();
        this.accept(await this.client.transcriptPage!(this.sessionId, {}, signal), signal);
        // Never await metadata here. Its independent status-cadence flight can
        // publish throughout this potentially long loaded-message refresh pass.
        await this.refreshLoaded(signal);
        this.update({ error: "", loading: false }, signal);
        return;
      } catch (error) {
        signal.throwIfAborted();
        if (resetError(error)) {
          this.reset(signal);
          if (attempt < 2) continue;
        }
        this.update({ loading: false, error: historyError(error) }, signal);
        return;
      }
    }
  }

  private selectIdentity(nativeSessionId: string | undefined, signal: AbortSignal) {
    if (signal.aborted || this.lifetime.signal.aborted) return;
    if (this.identityKnown && this.nativeSessionId !== nativeSessionId) {
      // Invalidate immediately, not when a queued read eventually starts. A
      // newly admitted identity fences even an in-flight old tail/page response.
      this.identity.abort();
      this.identity = new AbortController();
      this.metadataProjection = undefined;
      this.reset(this.lifetime.signal);
      this.update({ metadataError: "" }, this.lifetime.signal);
    }
    this.identityKnown = true;
    this.nativeSessionId = nativeSessionId;
    return this.identity.signal;
  }

  refresh(nativeSessionId: string | undefined, signal: AbortSignal) {
    const identity = this.selectIdentity(nativeSessionId, signal);
    if (!identity) return Promise.resolve();
    return this.serial(AbortSignal.any([signal, identity]), signal => this.latest(signal)).catch(error => {
      // Identity replacement is local cancellation, not a bridge failure.
      if (identity.aborted && !signal.aborted && !this.lifetime.signal.aborted) return;
      throw error;
    });
  }

  refreshMetadata(nativeSessionId: string | undefined, signal: AbortSignal) {
    const identity = this.selectIdentity(nativeSessionId, signal);
    if (!identity) return Promise.resolve();
    const current = this.metadataFlight;
    if (current && !current.signal.aborted) return current.promise;
    const combined = AbortSignal.any([signal, identity, this.lifetime.signal]);
    const promise = this.metadata(combined).catch(error => {
      if (identity.aborted && !signal.aborted && !this.lifetime.signal.aborted) return;
      throw error;
    });
    const flight = this.metadataFlight = { signal: combined, promise };
    void promise.finally(() => { if (this.metadataFlight === flight) this.metadataFlight = undefined; }).catch(() => {});
    return promise;
  }

  load(edge: PageRequest) {
    // Reserve synchronously so repeated clicks cannot enqueue duplicate pages.
    if (this.state.busy || !this.state.pages || this.lifetime.signal.aborted) return Promise.resolve();
    const key = workerPageKey(edge);
    const fence = this.coverageFence, owner = ++this.pageOwner;
    this.update({ busy: key, pageErrors: { ...this.state.pageErrors, [key]: "" } }, this.lifetime.signal);
    return this.serial(this.identity.signal, async signal => {
      try {
        // A tail read ahead of this queued click may have reset coverage. Never
        // reinterpret an old UI edge against a new epoch's coincidentally same ID.
        if (fence !== this.coverageFence) return;
        const island = this.state.pages?.islands.find(island => island.key === edge.island);
        const cursor = edge.direction === "older" ? island?.coverage.olderCursor : island?.coverage.newerCursor;
        if (!cursor) return;
        this.available();
        const page = await this.client.transcriptPage!(this.sessionId, { cursor }, signal);
        this.accept(page, signal, edge);
        await this.refreshLoaded(signal);
      } catch (error) {
        signal.throwIfAborted();
        if (resetError(error)) { this.reset(signal); await this.latest(signal); }
        else this.update({ pageErrors: { ...this.state.pageErrors, [key]: historyError(error) } }, signal);
      } finally {
        if (!signal.aborted && owner === this.pageOwner) this.update({ busy: "" }, signal);
      }
    }).catch(() => { /* Disposal cancels queued/in-flight pages without publication. */ });
  }
}
