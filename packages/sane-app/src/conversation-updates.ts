import type { Session, Run, Event } from "./history";
import {
  isConversationUpdateBootstrap, isConversationUpdateCandidate, isConversationUpdateCoverage,
  isConversationUpdateSource, updateOccurrenceId, updateSourceKey,
  type ConversationUpdateBootstrap, type ConversationUpdateCandidate, type ConversationUpdateCoverage,
  type ConversationUpdateFeedRequest, type ConversationUpdateSource,
} from "../shared/conversation/conversation-updates";
import {
  ConversationUpdateServiceError, ConversationUpdateStore, isConversationUpdateCommitCurrent, isConversationUpdateExpectedCheckpoint,
  type ConversationUpdateCheckpoint, type ConversationUpdateCommitGuard, type UpdateJson,
} from "./conversation-update-store";

/** The harness adapter owns qualification and its bounded JSON reducer state.
 * A native failure suppresses an App failure ONLY when it is exactly mapped to this run. */
export type ConversationUpdateProjection<State = UpdateJson> = {
  candidates: ConversationUpdateCandidate[];
  state: State;
  suppressAppFailure?: boolean;
};
export type ConversationUpdateProjector<State = UpdateJson> = {
  createState?: () => State;
  project(session: Session, run: Run, event: Event, state: State): ConversationUpdateProjection<State>;
};
export type ConversationUpdateServiceOptions<State = UpdateJson> = {
  projector?: ConversationUpdateProjector<State>;
  /** Synchronous authoritative snapshot, NOT inferred from retained feed rows. */
  bootstrap?: () => ConversationUpdateBootstrap;
  /** Independent live-source readiness, e.g. unqualified OC or stale native adapters. */
  coverage?: () => ConversationUpdateCoverage[];
};
type RunState = {
  projector: UpdateJson;
  suppressAppFailure: boolean;
  terminalIndexed: boolean;
};
type CommittedPrimaryEvent = { session: Session; run: Run; event: Event };
type PrimaryBatch = {
  key: string;
  source: ConversationUpdateSource;
  events: CommittedPrimaryEvent[];
  bytes: number;
  release: () => void;
  timer?: ReturnType<typeof setTimeout>;
  result: Promise<boolean>;
};
const PRIMARY_BATCH_EVENTS = 64, PRIMARY_BATCH_BYTES = 256 * 1024;
export type NativeConversationUpdateBatch = {
  source: ConversationUpdateSource;
  candidates: ConversationUpdateCandidate[];
  /** Source order, NOT the feed transport sequence. Each occurrence carries sourceSequence. */
  through: number;
  baselineThrough?: number;
  state?: UpdateJson;
  coverage?: ConversationUpdateCoverage;
  /** Exact assistant identities newly encountered in this native replay slice. */
  messageIds?: string[];
};
/** Correlation only amends an exact known occurrence. Never infer alias evidence from runId. */
export type ConversationUpdateCorrelation = {
  id: string;
  source: ConversationUpdateSource;
  conversationId: string;
  runId?: string;
  legacyRunId?: string;
};
export function appRunUpdateCheckpointKey(source: ConversationUpdateSource, runId: string) {
  return JSON.stringify(["app-run", updateSourceKey(source), runId]);
}
export function nativeUpdateCheckpointKey(source: ConversationUpdateSource) {
  return JSON.stringify(["native", updateSourceKey(source)]);
}
function sessionSource(session: Session): ConversationUpdateSource | undefined {
  const source = { harness: session.harness, authorityId: session.authorityId, nativeSessionId: session.nativeSessionId };
  return isConversationUpdateSource(source) ? source : undefined;
}
function runState<State>(value: UpdateJson | undefined, projector?: ConversationUpdateProjector<State>): RunState {
  if (value === undefined) return { projector: (projector?.createState?.() ?? null) as UpdateJson, suppressAppFailure: false, terminalIndexed: false };
  if (!value || typeof value !== "object" || Array.isArray(value) || !("projector" in value)
    || typeof value.suppressAppFailure !== "boolean" || typeof value.terminalIndexed !== "boolean") throw new Error("Invalid durable run projector state");
  return { projector: value.projector!, suppressAppFailure: value.suppressAppFailure, terminalIndexed: value.terminalIndexed };
}
function terminalStatus(event: Event): "failed" | "interrupted" | undefined {
  if (event.kind !== "status" || !event.data || typeof event.data !== "object" || Array.isArray(event.data)) return undefined;
  const status = (event.data as { status?: unknown }).status;
  return status === "failed" || status === "interrupted" ? status : undefined;
}

/** Captures accepted primary journal records, then projects on an entirely separate queue.
 * No feed/store error is thrown into launch, journal append, or run completion. */
export class ConversationUpdates<State = UpdateJson> {
  private queue: Promise<unknown> = Promise.resolve();
  /** Only the tail queue entry may collect more events; unrelated work seals it. */
  private primaryBatch?: PrimaryBatch;
  /** Qualified producer checkpoint -> problem; aggregate by source only for coverage. */
  private readonly producerProblems = new Map<string, ConversationUpdateCoverage>();
  private closed = false;
  private closing = false;
  constructor(readonly store: ConversationUpdateStore, private readonly options: ConversationUpdateServiceOptions<State> = {}) {}

  private enqueue(work: (guard?: ConversationUpdateCommitGuard) => Promise<boolean>, source?: ConversationUpdateSource,
    producerKey?: string, recovery = false, guard?: ConversationUpdateCommitGuard): Promise<boolean> {
    this.sealPrimaryBatch();
    if (this.closed || this.closing) return Promise.resolve(false);
    const key = source && (producerKey ?? nativeUpdateCheckpointKey(source));
    // Latch deliberate rejection at the actual guard check, not after persistence:
    // a registration can become stale after a successful synchronous save.
    let cancelled = false;
    const expectedCheckpoint = guard?.expectedCheckpoint;
    const liveGuard = guard === undefined ? undefined : {
      get expectedCheckpoint() {
        // Store-side shape validation can reject before invoking isCurrent;
        // latch that rejection here as well, without any post-save recheck.
        if (expectedCheckpoint !== undefined && !isConversationUpdateExpectedCheckpoint(expectedCheckpoint)) cancelled = true;
        return expectedCheckpoint;
      },
      isCurrent: () => {
        try {
          if (!isConversationUpdateCommitCurrent(guard) || expectedCheckpoint !== undefined
            && (!isConversationUpdateExpectedCheckpoint(expectedCheckpoint) || key !== undefined && expectedCheckpoint.key !== key
              || (this.store.getCheckpoint(expectedCheckpoint.key)?.through ?? null) !== expectedCheckpoint.through)) cancelled = true;
        } catch { cancelled = true; }
        return !cancelled;
      },
    };
    const task = this.queue.then(async () => {
      if (!isConversationUpdateCommitCurrent(liveGuard)) return false;
      if (!recovery && key && this.producerProblems.has(key)) return false;
      try {
        const committed = await work(liveGuard);
        if (committed && recovery && key) this.producerProblems.delete(key);
        if (!committed && !cancelled && source && key && this.store.getHealth().state === "ready") this.producerProblems.set(key, {
          sourceKey: updateSourceKey(source), state: "degraded", reason: "Conversation update evidence or checkpoint exceeded its validated bounds",
        });
        return committed;
      }
      catch {
        if (!cancelled && source && key) this.producerProblems.set(key, { sourceKey: updateSourceKey(source), state: "degraded", reason: "Conversation update projection requires replay or reconciliation" });
        return false;
      }
    });
    this.queue = task.catch(() => undefined);
    return task.catch(() => false);
  }
  /** Fire-and-forget hook, called ONLY AFTER primary journal persistence succeeds. */
  primaryJournalCommitted(session: Session, run: Run, event: Event): void {
    void this.ingestCommitted(session, run, event);
  }
  ingestCommitted(session: Session, run: Run, event: Event): Promise<boolean> {
    if (this.closed || this.closing) return Promise.resolve(false);
    try {
      // Standalone callers may mutate their envelopes immediately after return.
      // Keep this one capture boundary even when the bridge also captured them.
      const captured = structuredClone({ session, run, event }), source = sessionSource(captured.session);
      if (!source) { this.sealPrimaryBatch(); return Promise.resolve(false); }
      const key = appRunUpdateCheckpointKey(source, captured.run.runId);
      // Byte estimation is a batching decision, not a new admission rule for
      // standalone callers with cloneable but non-JSON event payloads.
      let size = PRIMARY_BATCH_BYTES;
      try { size = Buffer.byteLength(JSON.stringify(captured)); } catch { /* Isolate in its own batch. */ }
      let batch = this.primaryBatch;
      if (batch && (batch.key !== key || batch.events.at(-1)!.event.seq + 1 !== captured.event.seq
        || batch.events.length >= PRIMARY_BATCH_EVENTS || batch.bytes + size > PRIMARY_BATCH_BYTES)) {
        this.sealPrimaryBatch(); batch = undefined;
      }
      if (!batch) {
        const ready = Promise.withResolvers<void>();
        batch = { key, source, events: [], bytes: 0, release: () => ready.resolve(), result: Promise.resolve(false) };
        const reserved = batch;
        // Reserve global queue order NOW, not when the timer runs. Nothing from
        // another source/native producer/correlation may overtake these events.
        // Members share one atomic commit result; a rejection leaves the entire
        // producer slice at its old durable checkpoint for explicit replay.
        batch.result = this.enqueue(async () => {
          await ready.promise;
          return this.projectPrimaryBatch(reserved.events, reserved.source);
        }, source, key);
        this.primaryBatch = batch;
        batch.timer = setTimeout(() => this.sealPrimaryBatch(reserved), 0);
      }
      batch.events.push(captured); batch.bytes += size;
      // Oversized single events remain admissible, but never share a batch.
      if (batch.events.length >= PRIMARY_BATCH_EVENTS || batch.bytes >= PRIMARY_BATCH_BYTES) this.sealPrimaryBatch(batch);
      return batch.result;
    } catch { this.sealPrimaryBatch(); return Promise.resolve(false); }
  }
  private sealPrimaryBatch(batch = this.primaryBatch): void {
    if (!batch || this.primaryBatch !== batch) return;
    this.primaryBatch = undefined;
    if (batch.timer !== undefined) clearTimeout(batch.timer);
    batch.release();
  }
  private async projectPrimaryBatch(events: readonly CommittedPrimaryEvent[], source: ConversationUpdateSource): Promise<boolean> {
    const key = appRunUpdateCheckpointKey(source, events[0]!.run.runId), prior = this.store.getCheckpoint(key);
    let through = prior?.through ?? 0;
    let state: RunState | undefined;
    const candidates: ConversationUpdateCandidate[] = [];
    for (const { session, run, event } of events) {
      this.validateEvent(session, run, event);
      if (appRunUpdateCheckpointKey(source, run.runId) !== key) throw new Error("Unqualified primary batch");
      if (event.seq <= through) continue;
      if (event.seq !== through + 1) throw new Error("Replay primary history before advancing its checkpoint");
      state ??= runState(prior?.state, source.harness === "claude-code" ? this.options.projector : undefined);
      // Candidate-free records still carry integrity/framework and reducer
      // evidence. Never discard them or substitute only the last event.
      // A projector may retain/mutate candidate objects in its reducer state.
      // Earlier event publications must remain snapshots of that event.
      const projected = this.reduceEvent(session, run, event, source, state);
      if (projected.length) candidates.push(...structuredClone(projected));
      through = event.seq;
    }
    if (!state) return this.store.getHealth().state === "ready";
    return this.store.commitCandidates(candidates, { key, sourceKey: updateSourceKey(source), through,
      state: { ...state }, coverage: this.runCoverage(source) });
  }
  private validateEvent(session: Session, run: Run, event: Event) {
    if (session.sessionId !== run.sessionId || event.sessionId !== session.sessionId || event.runId !== run.runId
      || !Number.isSafeInteger(event.seq) || event.seq < 1) throw new Error("Unqualified committed event");
  }
  private runCoverage(source: ConversationUpdateSource): ConversationUpdateCoverage {
    return { sourceKey: updateSourceKey(source),
      state: source.harness === "claude-code" && this.options.projector ? "ready" : "unqualified",
      ...(source.harness === "opencode" ? { reason: "Native OpenCode reply updates are not qualified" }
        : source.harness === "grok" ? { reason: "Native Grok reply updates are not qualified" } : {}) };
  }
  private reduceEvent(session: Session, run: Run, event: Event, source: ConversationUpdateSource, state: RunState) {
    let candidates: ConversationUpdateCandidate[] = [];
    if (source.harness === "claude-code" && this.options.projector) {
      const projected = this.options.projector.project(session, run, event, state.projector as State);
      candidates = projected.candidates;
      state.projector = projected.state as UpdateJson;
      if (projected.suppressAppFailure) state.suppressAppFailure = true;
    }
    const status = terminalStatus(event);
    if (status && !state.terminalIndexed) {
      // A qualified CC success never creates a separate App-completed update.
      // OC/Grok remain unqualified for replies, but App failure/interruption is still authoritative.
      const exactTerminal = candidates.some(candidate => candidate.kind === status && candidate.runId === run.runId
        && candidate.legacyRunId === run.runId && candidate.conversationId === session.sessionId
        && updateSourceKey(candidate.source) === updateSourceKey(source));
      if (!exactTerminal && !(status === "failed" && state.suppressAppFailure)) candidates.push(this.appFailure(session, run, source, status, event.seq));
      state.terminalIndexed = true;
    }
    if (!candidates.every(isConversationUpdateCandidate)) throw new Error("Invalid harness projection");
    return candidates;
  }
  private appFailure(session: Session, run: Run, source: ConversationUpdateSource,
    status: "failed" | "interrupted", sourceSequence?: number): ConversationUpdateCandidate {
    return { id: updateOccurrenceId(source, `app-run:${run.runId}:${status}`), source,
      conversationId: session.sessionId, kind: status, runId: run.runId, legacyRunId: run.runId,
      // The accepted terminal record + terminalIndexed marker proves this exact
      // one-to-one legacy outcome; this is not inferred from an arbitrary runId.
      // App status timestamps are not authoritative native boundary timestamps.
      occurredAt: null, ...(sourceSequence === undefined ? {} : { sourceSequence }) };
  }
  /** Failed/interrupted runs stay unsettled until the durable terminal marker exists. Invalid projector state is not settled. */
  private checkpointSettled(session: Session, run: Run, checkpoint: ConversationUpdateCheckpoint | undefined): boolean {
    const source = sessionSource(session);
    if (!source || !checkpoint || !Number.isSafeInteger(checkpoint.through) || checkpoint.through < 1) return false;
    try {
      const state = runState(checkpoint.state, source.harness === "claude-code" ? this.options.projector : undefined);
      return run.status !== "failed" && run.status !== "interrupted" || state.terminalIndexed;
    } catch { return false; }
  }
  /** Tail seq already committed, including a failed/interrupted terminal marker. Startup uses this to avoid rereading a settled journal. */
  replaySettled(session: Session, run: Run, lastSeq: number): boolean {
    const source = sessionSource(session);
    if (!source || !Number.isSafeInteger(lastSeq) || lastSeq < 1) return false;
    const prior = this.store.getCheckpoint(appRunUpdateCheckpointKey(source, run.runId));
    if (!prior || prior.through !== lastSeq) return false;
    return this.checkpointSettled(session, run, prior);
  }
  /** journalBytes is trusted only because it was recorded against a verified through. Size equality alone is not proof. */
  coveredByJournalBytes(session: Session, run: Run, bytes: number): boolean {
    const source = sessionSource(session);
    if (!source || !Number.isSafeInteger(bytes) || bytes < 1) return false;
    const prior = this.store.getCheckpoint(appRunUpdateCheckpointKey(source, run.runId));
    if (!prior || prior.journalBytes !== bytes) return false;
    return this.checkpointSettled(session, run, prior);
  }
  /** One store write for startup length notes. False means the store could not accept the batch. */
  noteJournalBytes(notes: readonly { session: Session; run: Run; through: number; bytes: number }[]): Promise<boolean> {
    this.sealPrimaryBatch();
    if (!notes.length) return Promise.resolve(true);
    if (this.closed || this.closing) return Promise.resolve(false);
    let captured: { session: Session; run: Run; through: number; bytes: number }[];
    try { captured = structuredClone([...notes]); }
    catch { return Promise.resolve(false); }
    const task = this.queue.then(() => {
      if (this.closed || this.store.getHealth().state !== "ready") return false;
      const prepared: { key: string; through: number; bytes: number; session: Session; run: Run }[] = [];
      for (const note of captured) {
        const source = sessionSource(note.session);
        if (!source || !Number.isSafeInteger(note.through) || note.through < 1 || !Number.isSafeInteger(note.bytes) || note.bytes < 1) continue;
        const key = appRunUpdateCheckpointKey(source, note.run.runId);
        const checkpoint = this.store.getCheckpoint(key);
        if (!checkpoint || checkpoint.through !== note.through || !this.checkpointSettled(note.session, note.run, checkpoint)) continue;
        prepared.push({ key, through: note.through, bytes: note.bytes, session: note.session, run: note.run });
      }
      if (!prepared.length) return true;
      const byKey = new Map<string, typeof prepared[number]>();
      for (const note of prepared) if (!byKey.has(note.key)) byKey.set(note.key, note);
      return this.store.noteJournalBytes(prepared.map(({ key, through, bytes }) => ({ key, through, bytes })), checkpoint => {
        const note = byKey.get(checkpoint.key);
        return !!note && note.through === checkpoint.through && this.checkpointSettled(note.session, note.run, checkpoint);
      });
    });
    this.queue = task.catch(() => undefined);
    return task.catch(() => false);
  }
  /** Startup replay requires the complete contiguous journal; durable per-run through/state
   * makes replay idempotent even after all rows for the run have been pruned. */
  replayRun(session: Session, run: Run, events: readonly Event[]): Promise<boolean> {
    try {
      const source = sessionSource(session);
      if (!source) return Promise.resolve(false);
      const last = events.at(-1);
      // Contiguous 1..n already at the checkpoint has nothing to project. A missing
      // terminal marker still falls through so failed/interrupted recovery can commit it.
      if (last && events[0]?.seq === 1 && events.length === last.seq && this.replaySettled(session, run, last.seq)) return Promise.resolve(true);
      const captured = structuredClone({ session, run, events: [...events] });
      return this.enqueue(async () => {
        if (captured.session.sessionId !== captured.run.sessionId) throw new Error("Unqualified replay run");
        const key = appRunUpdateCheckpointKey(source, captured.run.runId), prior = this.store.getCheckpoint(key);
        let lastSequence = 0;
        // Validate the WHOLE range before consulting/projecting reducer state.
        // A gap could omit launch/framework rejection evidence, even when later
        // replies themselves look valid. A truncated journal cannot recover a producer.
        for (const event of captured.events) {
          this.validateEvent(captured.session, captured.run, event);
          if (event.seq !== lastSequence + 1) throw new Error("Replay requires a contiguous journal starting at sequence 1");
          lastSequence = event.seq;
        }
        if (lastSequence < (prior?.through ?? 0)) throw new Error("Replay journal is shorter than its durable checkpoint");
        const state = runState(prior?.state, source.harness === "claude-code" ? this.options.projector : undefined);
        const candidates: ConversationUpdateCandidate[] = [];
        for (const event of captured.events) {
          if (event.seq > (prior?.through ?? 0)) candidates.push(...this.reduceEvent(captured.session, captured.run, event, source, state));
        }
        // Recovery can persist terminal metadata without a terminal status record.
        // Use an explicit durable terminal marker, not an invented journal sequence.
        if (captured.run.status === "failed" || captured.run.status === "interrupted") {
          if (!state.terminalIndexed) {
            if (!(captured.run.status === "failed" && state.suppressAppFailure)) candidates.push(this.appFailure(captured.session, captured.run, source, captured.run.status));
            state.terminalIndexed = true;
          }
        }
        return this.store.commitCandidates(candidates, { key, sourceKey: updateSourceKey(source), through: lastSequence,
          state: { ...state }, coverage: this.runCoverage(source) });
      }, source, appRunUpdateCheckpointKey(source, captured.run.runId), true);
    } catch { return Promise.resolve(false); }
  }
  /** Native adapters must establish/advance the checkpoint in the SAME transaction
   * as their candidates and pending reducer state. Old source positions never resurrect.
   * An optional live guard rejects stale registrations without degrading the source. */
  upsertNativeBatch(batch: NativeConversationUpdateBatch, guard?: ConversationUpdateCommitGuard): Promise<boolean> {
    try {
      const captured = structuredClone(batch);
      if (!isConversationUpdateSource(captured.source)) return Promise.resolve(false);
      return this.enqueue(async liveGuard => {
        const sourceKey = updateSourceKey(captured.source), key = nativeUpdateCheckpointKey(captured.source), prior = this.store.getCheckpoint(key);
        if (!Number.isSafeInteger(captured.through) || captured.through < 0
          || captured.baselineThrough !== undefined && (!Number.isSafeInteger(captured.baselineThrough) || captured.baselineThrough < 0 || captured.baselineThrough > captured.through)
          || captured.coverage && (!isConversationUpdateCoverage(captured.coverage) || captured.coverage.sourceKey !== sourceKey
            || captured.coverage.through !== undefined && captured.coverage.through > captured.through)) throw new Error("Invalid native checkpoint");
        if (prior && captured.through < prior.through) return !this.producerProblems.has(key);
        const baselineThrough = prior?.baselineThrough ?? captured.baselineThrough;
        const state = captured.state === undefined ? prior?.state : captured.state;
        // Only inspect the generic envelope, not the adapter's reducer internals.
        const envelope = state && typeof state === "object" && !Array.isArray(state) ? state : undefined;
        const checkpointState = envelope?.checkpoint && typeof envelope.checkpoint === "object" && !Array.isArray(envelope.checkpoint)
          ? envelope.checkpoint : envelope;
        const progressThrough = checkpointState && "progressThrough" in checkpointState ? checkpointState.progressThrough : envelope?.progressThrough;
        const explicitCoverage = checkpointState?.version === 2 || checkpointState !== undefined && "progressThrough" in checkpointState
          || envelope !== undefined && "progressThrough" in envelope;
        if (explicitCoverage) {
          if (!captured.coverage) throw new Error("Native replay progress requires explicit certified coverage");
          if (progressThrough !== undefined && progressThrough !== captured.through) throw new Error("Native replay progress differs from its checkpoint");
          if (baselineThrough !== undefined && (captured.coverage.through === undefined || baselineThrough > captured.coverage.through)
            || baselineThrough !== undefined && checkpointState!.baselineThrough !== undefined && baselineThrough !== checkpointState!.baselineThrough) throw new Error("Native baseline is not certified");
        }
        const candidates = captured.candidates.filter(candidate => {
          if (!isConversationUpdateCandidate(candidate) || updateSourceKey(candidate.source) !== sourceKey
            || candidate.sourceSequence === undefined || candidate.sourceSequence > captured.through) throw new Error("Native occurrence requires qualified source position");
          const previous = this.store.getUpdate(candidate.id);
          if (previous) return previous.sourceSequence === undefined || candidate.sourceSequence >= previous.sourceSequence;
          return candidate.sourceSequence > (prior?.through ?? -1);
        });
        return this.store.commitCandidates(candidates, { key, sourceKey, through: captured.through,
          ...(baselineThrough === undefined ? {} : { baselineThrough }),
          ...(state === undefined ? {} : { state }),
          coverage: captured.coverage ?? { sourceKey, state: "ready", through: captured.through,
            ...(baselineThrough === undefined ? {} : { baselineThrough }) } }, liveGuard,
          captured.messageIds === undefined ? undefined : { nativeMessages: { sourceKey, ids: captured.messageIds } });
      }, captured.source, nativeUpdateCheckpointKey(captured.source), true, guard);
    } catch { return Promise.resolve(false); }
  }
  /** At most 64 EXACT selectors per request. A missing/pruned occurrence is a no-op;
   * correlation cannot create a new unread occurrence or move its first-observed order. */
  correlate(selectors: readonly ConversationUpdateCorrelation[], guard?: ConversationUpdateCommitGuard): Promise<boolean> {
    try {
      if (selectors.length > 64) return Promise.resolve(false);
      const captured = structuredClone([...selectors]);
      return this.enqueue(async liveGuard => {
        const candidates = new Map<string, ConversationUpdateCandidate>();
        for (const selector of captured) {
          if (!isConversationUpdateSource(selector.source)) throw new Error("Invalid correlation source");
          const prior = candidates.get(selector.id) ?? this.store.getUpdate(selector.id);
          if (!prior) continue;
          if (prior.conversationId !== selector.conversationId || updateSourceKey(prior.source) !== updateSourceKey(selector.source)) throw new Error("Correlation identity mismatch");
          if (selector.runId !== undefined && prior.runId !== undefined && prior.runId !== selector.runId
            || selector.legacyRunId !== undefined && prior.legacyRunId !== undefined && prior.legacyRunId !== selector.legacyRunId) throw new Error("Correlation alias changed");
          const row = this.store.getUpdate(selector.id)!;
          const { sequence: _sequence, occurrenceSequence: _occurrence, revision: _revision, observedAt: _observed, ...original } = row;
          candidates.set(selector.id, { ...original, ...candidates.get(selector.id), ...(selector.runId === undefined ? {} : { runId: selector.runId }),
            ...(selector.legacyRunId === undefined ? {} : { legacyRunId: selector.legacyRunId }) });
        }
        return this.store.commitCandidates([...candidates.values()], undefined, liveGuard);
      }, undefined, undefined, false, guard);
    } catch { return Promise.resolve(false); }
  }
  /** Metadata-only worker attention. Does not admit ordinary worker reply/failed/interrupted updates. */
  publishWorkerAttention(candidate: ConversationUpdateCandidate): Promise<boolean> {
    try {
      if (!isConversationUpdateCandidate(candidate) || candidate.kind !== "worker-attention" || !candidate.workerId) return Promise.resolve(false);
      const captured = structuredClone(candidate);
      const sourceKey = updateSourceKey(captured.source);
      const key = JSON.stringify(["worker-attention", sourceKey, captured.workerId, captured.id]);
      // Do not attribute a rejected attention row to the parent's native producer.
      return this.enqueue(() => this.store.commitCandidates([captured], { key, sourceKey, through: 1 }));
    } catch { return Promise.resolve(false); }
  }
  getCoverage(visible?: (sourceKey: string) => boolean): ConversationUpdateCoverage[] {
    const result = new Map(this.store.getCoverage().map(coverage => [coverage.sourceKey, coverage]));
    try {
      for (const coverage of this.options.coverage?.() ?? []) {
        if (!isConversationUpdateCoverage(coverage)) throw new Error("Invalid adapter coverage");
        result.set(coverage.sourceKey, structuredClone(coverage));
      }
    } catch { throw new ConversationUpdateServiceError("CONVERSATION_UPDATES_UNAVAILABLE", "Source coverage is unavailable"); }
    for (const problem of this.producerProblems.values()) result.set(problem.sourceKey,
      { ...result.get(problem.sourceKey), ...problem });
    if (this.store.getHealth().state !== "ready") for (const coverage of result.values()) {
      coverage.state = "unavailable"; coverage.reason = "Conversation update storage is unavailable";
    }
    return [...result.values()].filter(coverage => !visible || visible(coverage.sourceKey));
  }
  getHead() { return this.store.getHead(); }
  getHealth() { return this.store.getHealth(); }
  async page(request: ConversationUpdateFeedRequest = {}, bootstrap = false, visible?: (sourceKey: string) => boolean) {
    await this.flush();
    let snapshot: ConversationUpdateBootstrap | false = false;
    if (bootstrap) {
      try {
        // Requiring the callback prevents falsely declaring no runs active after restart.
        if (!this.options.bootstrap) throw new Error("No authoritative bootstrap provider");
        snapshot = structuredClone(this.options.bootstrap());
        if (visible) snapshot.sourceBaselines = snapshot.sourceBaselines.filter(value => visible(value.sourceKey));
        if (!isConversationUpdateBootstrap(snapshot)) throw new Error("Invalid bootstrap");
      } catch { throw new ConversationUpdateServiceError("CONVERSATION_UPDATES_UNAVAILABLE", "Authoritative active-run bootstrap is unavailable"); }
    }
    // Filter archived coverage before the hard response-metadata byte budget,
    // not just after page construction. Durable events/cursors are unchanged.
    return this.store.page(request, snapshot, this.getCoverage(visible));
  }
  async flush(): Promise<void> { this.sealPrimaryBatch(); await this.queue; await this.store.flush(); }
  async close(): Promise<void> { this.closing = true; await this.flush(); this.closed = true; await this.store.close(); }
}

export { ConversationUpdates as ConversationUpdateService };
