import type { Session, Run, Event } from "./history";
import {
  isConversationUpdateBootstrap, isConversationUpdateCandidate, isConversationUpdateCoverage,
  isConversationUpdateSource, updateOccurrenceId, updateSourceKey,
  type ConversationUpdateBootstrap, type ConversationUpdateCandidate, type ConversationUpdateCoverage,
  type ConversationUpdateFeedRequest, type ConversationUpdateSource,
} from "../shared/conversation/conversation-updates";
import { ConversationUpdateServiceError, ConversationUpdateStore, type UpdateJson } from "./conversation-update-store";

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
export type NativeConversationUpdateBatch = {
  source: ConversationUpdateSource;
  candidates: ConversationUpdateCandidate[];
  /** Source order, NOT the feed transport sequence. Each occurrence carries sourceSequence. */
  through: number;
  baselineThrough?: number;
  state?: UpdateJson;
  coverage?: ConversationUpdateCoverage;
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
  /** Qualified producer checkpoint -> problem; aggregate by source only for coverage. */
  private readonly producerProblems = new Map<string, ConversationUpdateCoverage>();
  private closed = false;
  constructor(readonly store: ConversationUpdateStore, private readonly options: ConversationUpdateServiceOptions<State> = {}) {}

  private enqueue(work: () => Promise<boolean>, source?: ConversationUpdateSource, producerKey?: string, recovery = false): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    const key = source && (producerKey ?? nativeUpdateCheckpointKey(source));
    const task = this.queue.then(async () => {
      if (!recovery && key && this.producerProblems.has(key)) return false;
      try {
        const committed = await work();
        if (committed && recovery && key) this.producerProblems.delete(key);
        if (!committed && source && key && this.store.getHealth().state === "ready") this.producerProblems.set(key, {
          sourceKey: updateSourceKey(source), state: "degraded", reason: "Conversation update evidence or checkpoint exceeded its validated bounds",
        });
        return committed;
      }
      catch {
        if (source && key) this.producerProblems.set(key, { sourceKey: updateSourceKey(source), state: "degraded", reason: "Conversation update projection requires replay or reconciliation" });
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
    try {
      const captured = structuredClone({ session, run, event }), source = sessionSource(captured.session);
      if (!source) return Promise.resolve(false);
      return this.enqueue(() => this.projectEvent(captured.session, captured.run, captured.event, source), source,
        appRunUpdateCheckpointKey(source, captured.run.runId));
    } catch { return Promise.resolve(false); }
  }
  private async projectEvent(session: Session, run: Run, event: Event, source: ConversationUpdateSource): Promise<boolean> {
    const key = appRunUpdateCheckpointKey(source, run.runId), prior = this.store.getCheckpoint(key);
    this.validateEvent(session, run, event);
    if (event.seq <= (prior?.through ?? 0)) return this.store.getHealth().state === "ready";
    if (event.seq !== (prior?.through ?? 0) + 1) throw new Error("Replay primary history before advancing its checkpoint");
    const state = runState(prior?.state, source.harness === "claude-code" ? this.options.projector : undefined);
    const candidates = this.reduceEvent(session, run, event, source, state);
    return this.store.commitCandidates(candidates, { key, sourceKey: updateSourceKey(source), through: event.seq,
      state: { ...state }, coverage: this.runCoverage(source) });
  }
  private validateEvent(session: Session, run: Run, event: Event) {
    if (session.sessionId !== run.sessionId || event.sessionId !== session.sessionId || event.runId !== run.runId
      || !Number.isSafeInteger(event.seq) || event.seq < 1) throw new Error("Unqualified committed event");
  }
  private runCoverage(source: ConversationUpdateSource): ConversationUpdateCoverage {
    return { sourceKey: updateSourceKey(source),
      state: source.harness === "claude-code" && this.options.projector ? "ready" : "unqualified",
      ...(source.harness === "opencode" ? { reason: "Native OpenCode reply updates are not qualified" } : {}) };
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
      // OC remains unqualified for replies, but App failure/interruption is still authoritative.
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
  /** Startup replay requires the complete contiguous journal; durable per-run through/state
   * makes replay idempotent even after all rows for the run have been pruned. */
  replayRun(session: Session, run: Run, events: readonly Event[]): Promise<boolean> {
    try {
      const captured = structuredClone({ session, run, events: [...events] }), source = sessionSource(captured.session);
      if (!source) return Promise.resolve(false);
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
   * as their candidates and pending reducer state. Old source positions never resurrect. */
  upsertNativeBatch(batch: NativeConversationUpdateBatch): Promise<boolean> {
    try {
      const captured = structuredClone(batch);
      if (!isConversationUpdateSource(captured.source)) return Promise.resolve(false);
      return this.enqueue(async () => {
        const sourceKey = updateSourceKey(captured.source), key = nativeUpdateCheckpointKey(captured.source), prior = this.store.getCheckpoint(key);
        if (!Number.isSafeInteger(captured.through) || captured.through < 0
          || captured.baselineThrough !== undefined && (!Number.isSafeInteger(captured.baselineThrough) || captured.baselineThrough < 0 || captured.baselineThrough > captured.through)
          || captured.coverage && (!isConversationUpdateCoverage(captured.coverage) || captured.coverage.sourceKey !== sourceKey)) throw new Error("Invalid native checkpoint");
        if (prior && captured.through < prior.through) return !this.producerProblems.has(key);
        const baselineThrough = prior?.baselineThrough ?? captured.baselineThrough;
        const candidates = captured.candidates.filter(candidate => {
          if (!isConversationUpdateCandidate(candidate) || updateSourceKey(candidate.source) !== sourceKey
            || candidate.sourceSequence === undefined || candidate.sourceSequence > captured.through) throw new Error("Native occurrence requires qualified source position");
          const previous = this.store.getUpdate(candidate.id);
          if (previous) return previous.sourceSequence === undefined || candidate.sourceSequence >= previous.sourceSequence;
          return candidate.sourceSequence > (prior?.through ?? -1);
        });
        return this.store.commitCandidates(candidates, { key, sourceKey, through: captured.through,
          ...(baselineThrough === undefined ? {} : { baselineThrough }),
          ...(captured.state === undefined ? prior?.state === undefined ? {} : { state: prior.state } : { state: captured.state }),
          coverage: captured.coverage ?? { sourceKey, state: "ready", through: captured.through,
            ...(baselineThrough === undefined ? {} : { baselineThrough }) } });
      }, captured.source, nativeUpdateCheckpointKey(captured.source), true);
    } catch { return Promise.resolve(false); }
  }
  /** At most 64 EXACT selectors per request. A missing/pruned occurrence is a no-op;
   * correlation cannot create a new unread occurrence or move its first-observed order. */
  correlate(selectors: readonly ConversationUpdateCorrelation[]): Promise<boolean> {
    try {
      if (selectors.length > 64) return Promise.resolve(false);
      const captured = structuredClone([...selectors]);
      return this.enqueue(async () => {
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
        return this.store.commitCandidates([...candidates.values()]);
      });
    } catch { return Promise.resolve(false); }
  }
  getCoverage(): ConversationUpdateCoverage[] {
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
    return [...result.values()];
  }
  getHead() { return this.store.getHead(); }
  getHealth() { return this.store.getHealth(); }
  async page(request: ConversationUpdateFeedRequest = {}, bootstrap = false) {
    await this.flush();
    let snapshot: ConversationUpdateBootstrap | false = false;
    if (bootstrap) {
      try {
        // Requiring the callback prevents falsely declaring no runs active after restart.
        if (!this.options.bootstrap) throw new Error("No authoritative bootstrap provider");
        snapshot = structuredClone(this.options.bootstrap());
        if (!isConversationUpdateBootstrap(snapshot)) throw new Error("Invalid bootstrap");
      } catch { throw new ConversationUpdateServiceError("CONVERSATION_UPDATES_UNAVAILABLE", "Authoritative active-run bootstrap is unavailable"); }
    }
    return this.store.page(request, snapshot, this.getCoverage());
  }
  async flush(): Promise<void> { await this.queue; await this.store.flush(); }
  async close(): Promise<void> { this.closed = true; await this.flush(); await this.store.close(); }
}

export { ConversationUpdates as ConversationUpdateService };
