import type { Admission } from "./app-store";
import type { Event, Metadata, Run, Session } from "./history";
import { nativeMessageId } from "./history";
import type { OpenCodeAdapter } from "./opencode";
import { OpenCodeReplyObserver, validateOpenCodeReplyCheckpoint, type OpenCodeReplyCheckpoint, type OpenCodeReplyCommit, type OpenCodeReplyQualification, type OpenCodeReplyRegistration } from "./opencode-reply-observer";
import { OpenCodeReplyBindings, type OpenCodeReplyBindingRecord } from "./opencode-reply-bindings";
import { nativeUpdateCheckpointKey, type ConversationUpdates } from "./conversation-updates";
import type { ConversationUpdateStore, UpdateJson } from "./conversation-update-store";
import { isConversationUpdateSource, updateSourceKey, type ConversationUpdateCandidate, type ConversationUpdateCoverage, type ConversationUpdateSource } from "../shared/conversation/conversation-updates";
import { openCodeIncarnation, openCodeLogItem } from "../shared/conversation/oc-reply-reducer";

export const OC_REPLY_ACTIVATION_BLOCKED = "OpenCode reply activation is disabled: native 2.0.21 replay returned empty logs at positive watermarks; durable replay support and runtime qualification remain outstanding. App run alerts remain available";
export type OpenCodeReplyAuthority = {
  authorityId: string;
  adapter: Pick<OpenCodeAdapter, "replyTransport">;
  /** Trusted operator evidence only; never supplied through a browser route. */
  qualification?: OpenCodeReplyQualification;
};
export type OpenCodeReplyIntegrationOptions = {
  dataDir: string;
  authorities: readonly OpenCodeReplyAuthority[];
  /** Production bridge always passes false in this preparation phase. */
  allowQualifiedActivation?: boolean;
  disabledReason?: string;
  /** Bridge callbacks are live; freeze their initial durable view only when
   * qualified capture is enabled. Standalone callers supply durable snapshots. */
  capturePublishedMetadata?: boolean;
  sessions: () => readonly Session[];
  runs: () => readonly Run[];
  /** Only successfully persisted primary journal records. */
  events: (runId: string) => readonly Event[];
  admission: (conversationId: string) => Admission | undefined;
  /** Optional bulk snapshot avoids repeated linear admission lookups at refresh. */
  admissions?: () => readonly Admission[];
  isWorker: (conversationId: string) => boolean;
  isClosing: () => boolean;
  /** Recheck live App ownership, admission and configured source at publication. */
  isCurrent: (conversationId: string, source: ConversationUpdateSource, admissionSnapshot?: Admission) => boolean;
  store: Pick<ConversationUpdateStore, "getCheckpoint" | "getHealth" | "getCoverage" | "hasNativeMessage" | "getHead" | "page">;
  updates: Pick<ConversationUpdates, "upsertNativeBatch" | "correlate">;
  bindings?: OpenCodeReplyBindings;
};
const SWEEP_MS = 30000, ADMISSION_MS = 15000, MAX_QUEUE = 256;
const METADATA_BYTES = 16 * 1024 * 1024, CORRELATION_PAGES_PER_TURN = 2, CORRELATION_TURN_MS = 8;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const safeInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const date = (value: unknown): number => typeof value === "string" ? Date.parse(value) : NaN;
function appSource(session: Session): ConversationUpdateSource | undefined {
  const source = { harness: session.harness, authorityId: session.authorityId, nativeSessionId: session.nativeSessionId };
  return isConversationUpdateSource(source) ? source : undefined;
}
function registration(record: OpenCodeReplyBindingRecord): OpenCodeReplyRegistration {
  return { conversationId: record.conversationId, source: { ...record.source }, creation: { ...record.creation },
    initialBaselineThrough: record.initialBaselineThrough, registrationRevision: record.registrationRevision };
}
function registrationSession(session: Session): Session {
  return { sessionId: session.sessionId, harness: session.harness, authorityId: session.authorityId,
    nativeSessionId: session.nativeSessionId, cwd: session.cwd, agentKind: session.agentKind,
    lastStatus: "unknown", lastRunId: null, ...(session.attachment ? { attachment: { ...session.attachment } } : {}) };
}
function registrationFingerprint(sessions: readonly Session[]): string {
  return JSON.stringify(sessions.filter(session => session.harness === "opencode").map(session =>
    [session.sessionId, session.harness, session.authorityId, session.nativeSessionId, session.cwd, session.agentKind, session.attachment?.state]));
}
/** Abort even an adapter promise which fails to observe its request signal. Its
 * eventual settlement is consumed, but can no longer advance this generation. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
    operation.then(value => { signal.removeEventListener("abort", aborted); resolve(value); }, error => {
      signal.removeEventListener("abort", aborted); reject(error);
    });
  });
}
type AdmissionGeneration = { epoch: string; controller: AbortController };
type CorrelationJob = {
  key: string;
  binding: OpenCodeReplyRegistration;
  messageId: string;
  runId: string;
  head: { epoch: string; retainedAfter: number; through: number };
  after: number;
};

/** Sole bridge-owned coordinator. It never changes execution status, selects an
 * agent, submits input, discovers external sessions or owns a native process. */
export class OpenCodeReplyIntegration {
  private bindings: OpenCodeReplyBindings;
  private authorities = new Map<string, OpenCodeReplyAuthority>();
  private observers = new Map<string, OpenCodeReplyObserver>();
  private enabled = new Set<string>();
  private authorityProblems = new Map<string, string>();
  private eligible = new Map<string, Session>();
  private eligibilitySignatures = new Map<string, string>();
  private eligibilityEpochs = new Map<string, string>();
  private registered = new Map<string, OpenCodeReplyRegistration>();
  private registeredEpochs = new Map<string, string>();
  private retired = new Set<string>();
  private problems = new Map<string, Pick<ConversationUpdateCoverage, "state" | "reason">>();
  private incompatible = new Set<string>();
  private lifetime?: AbortController;
  private timer?: ReturnType<typeof setInterval>;
  private queue = new Map<string, string>();
  private active = new Map<string, AdmissionGeneration>();
  private sweep?: Iterator<string>;
  private nextSweepAt = 0;
  private tasks = new Set<Promise<unknown>>();
  private correlations = new Map<string, CorrelationJob>();
  private correlationTask?: Promise<void>;
  private publishedMetadata?: Pick<Metadata, "sessions" | "runs">;
  private pendingMetadata?: string;
  private metadataTask?: Promise<void>;
  private metadataFingerprint?: string;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private closing = false;
  private closePromise?: Promise<void>;
  constructor(private options: OpenCodeReplyIntegrationOptions) {
    this.bindings = options.bindings ?? new OpenCodeReplyBindings(options.dataDir);
    for (const authority of options.authorities) {
      if (this.authorities.has(authority.authorityId)) {
        this.authorityProblems.set(authority.authorityId, "Ambiguous registered OpenCode reply authority");
      } else this.authorities.set(authority.authorityId, authority);
    }
  }
  start(): void {
    if (this.lifetime || this.closing || this.options.isClosing()) return;
    this.lifetime = new AbortController();
    this.bindings.load();
    for (const [authorityId, authority] of this.authorities) {
      if (this.authorityProblems.has(authorityId)) continue;
      try {
        const observer = new OpenCodeReplyObserver({
          authorityId, transport: () => authority.adapter.replyTransport(),
          sessions: () => [...this.registered.values()].filter(binding => binding.source.authorityId === authorityId),
          load: async (binding, signal) => {
            signal.throwIfAborted();
            if (!this.current(binding) || this.options.store.getHealth().state !== "ready") throw new Error("Native reply checkpoint unavailable");
            return this.checkpoint(binding);
          },
          hasSeenMessage: (binding, id) => this.options.store.hasNativeMessage(updateSourceKey(binding.source), id),
          commit: (batch, signal) => this.commit(batch, signal),
        });
        if (this.options.allowQualifiedActivation === true && authority.qualification) {
          observer.qualify(authority.qualification);
          this.enabled.add(authorityId);
        }
        this.observers.set(authorityId, observer);
        observer.start(); // Unqualified instances open no transport.
      } catch {
        this.enabled.delete(authorityId);
        this.authorityProblems.set(authorityId, "OpenCode reply qualification or registration is invalid; App run alerts remain available");
      }
    }
    if (this.enabled.size) {
      this.metadataFingerprint = registrationFingerprint(this.options.sessions());
      if (this.options.capturePublishedMetadata) this.publishedMetadata = {
        sessions: this.options.sessions().map(registrationSession), runs: this.options.runs().map(run => structuredClone(run)),
      };
    }
    this.refresh();
    if (this.enabled.size) this.timer = setInterval(() => this.refresh(), SWEEP_MS);
  }
  private sessions(): readonly Session[] { return this.publishedMetadata?.sessions ?? this.options.sessions(); }
  hasQualifiedAuthorities(): boolean { return this.enabled.size > 0 && !this.closing; }
  /** O(1) primary publication hook. Disabled production keeps no duplicate
   * metadata; qualified capture coalesces outside the primary storage queue. */
  metadataPublished(snapshot: string): void {
    if (!this.hasQualifiedAuthorities() || this.options.isClosing() || snapshot.length > METADATA_BYTES) return;
    this.pendingMetadata = snapshot;
    this.captureMetadata();
  }
  private captureMetadata(): void {
    if (this.metadataTask || !this.pendingMetadata || this.closing) return;
    const task = (async () => {
      await Bun.sleep(0);
      const snapshot = this.pendingMetadata;
      this.pendingMetadata = undefined;
      if (!snapshot || this.closing || this.options.isClosing() || Buffer.byteLength(snapshot) > METADATA_BYTES) return;
      const parsed = JSON.parse(snapshot) as Metadata;
      if (!Array.isArray(parsed.sessions) || !Array.isArray(parsed.runs)) return;
      const fingerprint = registrationFingerprint(parsed.sessions);
      const previous = this.metadataFingerprint ?? registrationFingerprint(this.sessions());
      this.publishedMetadata = { sessions: parsed.sessions.map(registrationSession), runs: parsed.runs };
      this.metadataFingerprint = fingerprint;
      if (fingerprint !== previous) this.requestRefresh();
    })().catch(() => {}).finally(() => {
      this.tasks.delete(task);
      if (this.metadataTask === task) this.metadataTask = undefined;
      if (!this.closing) this.captureMetadata();
    });
    this.metadataTask = task;
    this.tasks.add(task);
  }
  /** Admission/catalog hooks coalesce; never scan the catalog in the primary
   * journal/metadata queue. Explicit refresh remains available for reconciliation. */
  requestRefresh(): void {
    if (!this.hasQualifiedAuthorities() || this.options.isClosing() || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh();
    }, 0);
  }
  /** Optional, nonthrowing publication hook; also called by the bounded sweep. */
  refresh(): void {
    if (!this.lifetime || this.closing || this.options.isClosing() || !this.enabled.size) return;
    try {
      const next = new Map<string, Session>();
      const signatures = new Map<string, string>();
      const identities = new Map<string, string>();
      const admissions = this.options.admissions && new Map(this.options.admissions().map(admission => [admission.sessionId, admission]));
      for (const original of this.sessions()) {
        if (original.harness !== "opencode" || original.agentKind === "worker" || this.options.isWorker(original.sessionId) || original.attachment?.state === "pending") continue;
        const source = appSource(original), admission = admissions ? admissions.get(original.sessionId) : this.options.admission(original.sessionId);
        if (!source || !this.authorities.has(source.authorityId)) continue;
        if (!admission || admission.state !== "ready" || admission.source.descriptor.harness !== "oc"
          || admission.nativeId !== source.nativeSessionId || admission.source.authorityId !== source.authorityId
          || admission.binding.executionCheckout !== original.cwd || !this.options.isCurrent(original.sessionId, source, admission)) continue;
        const key = updateSourceKey(source), previous = identities.get(key);
        if (previous !== undefined) {
          next.delete(previous);
          signatures.delete(previous);
          this.problems.set(previous, { state: "unavailable", reason: "Ambiguous App parent registration" });
          this.problems.set(original.sessionId, { state: "unavailable", reason: "Ambiguous App parent registration" });
          continue;
        }
        identities.set(key, original.sessionId);
        const signature = JSON.stringify([key, original.cwd, admission.requestId, admission.binding.bindingRevision]);
        next.set(original.sessionId, this.eligibilitySignatures.get(original.sessionId) === signature
          ? this.eligible.get(original.sessionId) ?? registrationSession(original) : registrationSession(original));
        signatures.set(original.sessionId, signature);
      }
      const eligibilityChanged = next.size !== this.eligible.size
        || [...next.keys()].some(id => this.eligibilitySignatures.get(id) !== signatures.get(id));
      for (const id of this.eligibilityEpochs.keys()) if (!next.has(id)) this.eligibilityEpochs.delete(id);
      for (const id of next.keys()) if (this.eligibilitySignatures.get(id) !== signatures.get(id) || !this.eligibilityEpochs.has(id)) this.eligibilityEpochs.set(id, crypto.randomUUID());
      this.eligibilitySignatures = signatures;
      this.eligible = next;
      for (const [id, epoch] of this.queue) if (!next.has(id) || epoch !== this.eligibilityEpochs.get(id)) this.queue.delete(id);
      for (const [id, generation] of this.active) if (!next.has(id) || generation.epoch !== this.eligibilityEpochs.get(id)) {
        generation.controller.abort();
        if (this.active.get(id) === generation) this.active.delete(id);
        this.queue.delete(id);
      }
      let registrationsChanged = false;
      for (const [id, binding] of this.registered) {
        const session = next.get(id), source = session && appSource(session);
        if (!source || !this.sameNative(source, binding.source) || !this.enabled.has(source.authorityId) || this.bindings.problem(id, source)
          || this.registeredEpochs.get(id) !== this.eligibilityEpochs.get(id)) {
          this.registered.delete(id);
          this.registeredEpochs.delete(id);
          this.retired.add(id);
          registrationsChanged = true;
        }
      }
      for (const [id, session] of next) {
        const source = appSource(session)!;
        if (!this.enabled.has(source.authorityId) || this.bindings.problem(id, source)) continue;
        let saved = this.bindings.get(id);
        if (saved) {
          if (!this.sameNative(source, saved.source)) {
            this.incompatible.add(id);
            this.problems.set(id, { state: "unavailable", reason: "Established OpenCode creation binding differs from the registered App source; explicit reconciliation is required" });
          } else if (saved.nativeVersion !== this.authorities.get(source.authorityId)?.qualification?.nativeVersion) {
            this.incompatible.add(id);
            this.problems.set(id, { state: "unqualified", reason: "Persisted OpenCode reply binding differs from the qualified native version" });
          } else if (!this.incompatible.has(id)) {
            if (this.retired.has(id)) {
              try { saved = this.bindings.renewRegistration(id); this.retired.delete(id); }
              catch { continue; }
            }
            this.problems.delete(id);
            if (this.registered.get(id)?.registrationRevision !== saved.registrationRevision) {
              this.registered.set(id, registration(saved));
              registrationsChanged = true;
            }
            this.registeredEpochs.set(id, this.eligibilityEpochs.get(id)!);
          }
        }
      }
      for (const observer of registrationsChanged ? this.observers.values() : []) {
        try { observer.refresh(); } catch { /* Isolate optional registration failures. */ }
      }
      // Preserve unfinished order across unchanged periodic refreshes: retries
      // at a failing prefix must not refill the queue ahead of the healthy tail.
      // A new catalog generation restarts the cursor; unchanged retries begin
      // only on a later refresh after cadence and all prior work have drained.
      if (eligibilityChanged || !this.sweep && !this.queue.size && !this.active.size && performance.now() >= this.nextSweepAt) {
        this.sweep = next.keys();
      }
      this.drain();
    } catch { /* Never throw optional evidence failures into the primary queue. */ }
  }
  private sameNative(left: ConversationUpdateSource, right: ConversationUpdateSource): boolean {
    return left.harness === right.harness && left.authorityId === right.authorityId && left.nativeSessionId === right.nativeSessionId;
  }
  private current(binding: OpenCodeReplyRegistration): boolean {
    const live = this.registered.get(binding.conversationId), saved = this.bindings.get(binding.conversationId);
    return !this.closing && !!this.lifetime && !this.lifetime.signal.aborted && !this.options.isClosing()
      && this.enabled.has(binding.source.authorityId) && !this.incompatible.has(binding.conversationId)
      && !!live && !!saved && live.registrationRevision === binding.registrationRevision
      && saved.registrationRevision === binding.registrationRevision && live.initialBaselineThrough === binding.initialBaselineThrough
      && updateSourceKey(live.source) === updateSourceKey(binding.source) && updateSourceKey(saved.source) === updateSourceKey(binding.source)
      && this.registeredEpochs.get(binding.conversationId) === this.eligibilityEpochs.get(binding.conversationId)
      && this.eligible.has(binding.conversationId) && this.options.isCurrent(binding.conversationId, binding.source);
  }
  private checkpoint(binding: OpenCodeReplyRegistration): OpenCodeReplyCheckpoint | undefined {
    const generic = this.options.store.getCheckpoint(nativeUpdateCheckpointKey(binding.source));
    if (!generic) return undefined;
    const saved = this.bindings.get(binding.conversationId), value: unknown = generic.state;
    if (!saved || generic.sourceKey !== updateSourceKey(binding.source) || !validateOpenCodeReplyCheckpoint(value, binding, saved.nativeVersion)
      || value.progressThrough !== generic.through || value.initialBaselineThrough !== binding.initialBaselineThrough
      || generic.baselineThrough !== undefined && (generic.baselineThrough !== binding.initialBaselineThrough
        || value.certifiedThrough === null || value.certifiedThrough < binding.initialBaselineThrough)
      || Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) {
      this.problems.set(binding.conversationId, { state: "unqualified", reason: "Persisted native reply checkpoint is incompatible or incomplete; explicit reconciliation is required, not a replay reset" });
      this.incompatible.add(binding.conversationId);
      throw new Error("Incompatible native reply checkpoint");
    }
    return structuredClone(value);
  }
  private drain(): void {
    const signal = this.lifetime?.signal;
    if (!signal || signal.aborted || this.closing) return;
    while (this.sweep && this.queue.size < MAX_QUEUE) {
      const item = this.sweep.next();
      if (item.done) { this.sweep = undefined; this.nextSweepAt = performance.now() + SWEEP_MS; break; }
      const session = this.eligible.get(item.value), source = session && appSource(session);
      if (!source || !this.enabled.has(source.authorityId) || this.registered.has(item.value) || this.active.has(item.value)
        || this.queue.has(item.value) || this.bindings.problem(item.value, source) || this.bindings.get(item.value)) continue;
      const epoch = this.eligibilityEpochs.get(item.value);
      if (epoch) this.queue.set(item.value, epoch);
    }
    while (this.active.size < 2 && this.queue.size) {
      const [id, epoch] = this.queue.entries().next().value!;
      this.queue.delete(id);
      const session = this.eligible.get(id);
      const source = session && appSource(session);
      if (!session || !source || epoch !== this.eligibilityEpochs.get(id) || this.active.has(id) || this.registered.has(id)
        || !this.enabled.has(source.authorityId) || this.bindings.problem(id, source) || this.bindings.get(id)) continue;
      const generation = { epoch, controller: new AbortController() };
      this.active.set(id, generation);
      const task = this.admit(session, signal, generation).catch(() => {}).finally(() => {
        if (this.active.get(id) === generation) this.active.delete(id);
        this.tasks.delete(task); this.drain();
      });
      this.tasks.add(task);
    }
  }
  private async admit(session: Session, lifetime: AbortSignal, generation: AdmissionGeneration): Promise<void> {
    const source = appSource(session)!;
    const signal = AbortSignal.any([lifetime, generation.controller.signal, AbortSignal.timeout(ADMISSION_MS)]);
    const admission = this.options.admission(session.sessionId);
    const requestId = admission?.requestId, bindingRevision = admission?.binding.bindingRevision;
    const epoch = generation.epoch;
    const fresh = () => {
      if (lifetime.aborted || generation.controller.signal.aborted || this.closing || this.options.isClosing()
        || this.active.get(session.sessionId) !== generation || this.eligibilityEpochs.get(session.sessionId) !== epoch
        || this.eligible.get(session.sessionId)?.cwd !== session.cwd || !this.options.isCurrent(session.sessionId, source)) return false;
      const live = this.options.admission(session.sessionId);
      return live?.state === "ready" && live.requestId === requestId
        && live.binding.bindingRevision === bindingRevision && live.binding.executionCheckout === session.cwd
        && live.source.authorityId === source.authorityId && live.nativeId === source.nativeSessionId;
    };
    const assertFresh = () => { signal.throwIfAborted(); if (!fresh()) throw new Error("Stale native reply admission"); };
    if (signal.aborted || !fresh() || !this.enabled.has(source.authorityId)) return;
    this.problems.set(session.sessionId, { state: "initializing", reason: "Waiting for bounded native creation and registration-fence evidence; App run alerts remain available" });
    try {
      const authority = this.authorities.get(source.authorityId)!;
      assertFresh();
      const transport = await abortable(authority.adapter.replyTransport(), signal);
      assertFresh();
      const info = await abortable(transport.info({ signal }), signal);
      assertFresh();
      if (info.version !== authority.qualification?.nativeVersion) {
        this.problems.set(session.sessionId, { state: "unqualified", reason: "Native version differs from evidenced OpenCode reply qualification" });
        return;
      }
      const verify = async () => {
        assertFresh();
        const native = await abortable(transport.session({ sessionID: source.nativeSessionId }, { signal }), signal);
        assertFresh();
        if (native.id !== source.nativeSessionId || native.parentID !== undefined || native.location.directory !== session.cwd
          || !safeInt(native.time.created)) throw new Error("Native parent registration identity differs");
        return native;
      };
      const before = await verify();
      // Native Bus.log captures latestSequence before replay. A high-after,
      // non-follow probe supplies only the fence, NOT reconstruction coverage.
      // Evidence: embedded CLI 2.0.21 offsets 124415936/125405498/126112186.
      // With two bounded admission workers, this fence can be later than App
      // publication. It is never described as the publication-time watermark.
      let fence: number | undefined, probeItems = 0;
      assertFresh();
      const headController = new AbortController();
      const headSignal = AbortSignal.any([signal, headController.signal]);
      let headIterator: AsyncIterator<unknown> | undefined;
      try {
        headIterator = transport.log({ sessionID: source.nativeSessionId, after: Number.MAX_SAFE_INTEGER, follow: false }, { signal: headSignal })[Symbol.asyncIterator]();
        while (true) {
          const next = await abortable(headIterator.next(), headSignal);
          assertFresh();
          if (next.done) break;
          const event = openCodeLogItem(next.value, source.nativeSessionId);
          if (++probeItems !== 1 || event.type !== "log.synced" || !safeInt(event.seq)) throw new Error("Invalid registration fence");
          fence = event.seq;
        }
      } finally {
        headController.abort();
        try { await abortable(Promise.resolve(headIterator?.return?.()), signal); } catch { /* Cancelled generation cannot hold an admission slot. */ }
      }
      assertFresh();
      if (fence === undefined) throw new Error("Registration fence absent");
      // Omit after: native creation is at sequence zero. Never use after:0 for
      // cold reconstruction and never let a positive empty watermark admit it.
      let creation: OpenCodeReplyBindingRecord["creation"] | undefined;
      const creationController = new AbortController();
      const creationSignal = AbortSignal.any([signal, creationController.signal]);
      let creationIterator: AsyncIterator<unknown> | undefined;
      try {
        assertFresh();
        creationIterator = transport.log({ sessionID: source.nativeSessionId, follow: false }, { signal: creationSignal })[Symbol.asyncIterator]();
        const next = await abortable(creationIterator.next(), creationSignal);
        assertFresh();
        if (next.done) throw new Error("Native creation evidence absent");
        const event = openCodeLogItem(next.value, source.nativeSessionId);
        if (event.type !== "session.created" || event.durable.seq !== 0 || event.data.parentID !== undefined
          || event.created !== before.time.created || event.data.location.directory !== session.cwd) throw new Error("Native zero-origin creation evidence absent");
        creation = { eventId: event.id, createdAt: event.created };
      } finally {
        // Abort before iterator cleanup, including after the first complete
        // creation. This is an identity probe, never a replay checkpoint.
        creationController.abort();
        try { await abortable(Promise.resolve(creationIterator?.return?.()), signal); } catch { /* Probe cleanup is not creation evidence, and cannot hold a retired slot. */ }
      }
      assertFresh();
      if (!creation) throw new Error("Native creation evidence absent");
      const after = await verify();
      assertFresh();
      if (after.time.created !== creation.createdAt) throw new Error("Native registration changed");
      const record: OpenCodeReplyBindingRecord = { version: 1, conversationId: session.sessionId,
        source: { ...source, incarnation: openCodeIncarnation(creation) }, creation, initialBaselineThrough: fence,
        registrationRevision: crypto.randomUUID(), nativeVersion: info.version };
      // First admitted fence survives a crash. Publish BEFORE observer exposure.
      this.bindings.admit(record);
      if (signal.aborted || !fresh()) return;
      this.problems.delete(session.sessionId);
      this.registered.set(session.sessionId, registration(record));
      this.registeredEpochs.set(session.sessionId, epoch!);
      this.observers.get(source.authorityId)?.refresh();
    } catch {
      if (fresh()) this.problems.set(session.sessionId, { state: "unavailable", reason: "Native creation or registration-fence evidence is incomplete; no binding or replay checkpoint was invented. App run alerts remain available" });
    }
  }
  private correlatedRun(candidate: ConversationUpdateCandidate, binding: OpenCodeReplyRegistration): string | undefined {
    if (candidate.kind !== "reply" || !candidate.messageId) return undefined;
    const matches: string[] = [];
    for (const run of this.publishedMetadata?.runs ?? this.options.runs()) {
      if (run.sessionId !== binding.conversationId || run.operation === "compact" || run.agentKind === "worker"
        || run.nativePhase !== "accepted" || !nativeMessageId(run.nativeCommandId)
        || run.nativeAcceptedAt !== undefined && run.nativeAcceptedAt < binding.creation.createdAt) continue;
      let command = false, assistant = false;
      for (const event of this.options.events(run.runId)) {
        if (event.kind !== "message" || event.sessionId !== run.sessionId || event.runId !== run.runId || !object(event.data)
          || !(date(event.data.createdAt) >= binding.creation.createdAt)) continue;
        command ||= event.data.role === "user" && event.data.messageId === run.nativeCommandId;
        assistant ||= event.data.role === "assistant" && event.data.messageId === candidate.messageId;
      }
      if (command && assistant) matches.push(run.runId);
    }
    return matches.length === 1 ? matches[0] : undefined;
  }
  private async commit(batch: OpenCodeReplyCommit, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!this.current(batch.binding)) throw new Error("Stale native reply registration");
    const cp = batch.checkpoint;
    if (!validateOpenCodeReplyCheckpoint(cp, batch.binding, this.bindings.get(batch.binding.conversationId)?.nativeVersion)) throw new Error("Invalid native reply checkpoint envelope");
    const candidates = batch.candidates.map(candidate => {
      const runId = this.correlatedRun(candidate, batch.binding);
      return runId && candidate.runId === undefined ? { ...candidate, runId } : candidate;
    });
    const committed = await this.options.updates.upsertNativeBatch({ source: batch.binding.source, candidates,
      through: cp.progressThrough, state: cp as unknown as UpdateJson, messageIds: batch.messageIds, coverage: batch.coverage,
      ...(batch.coverage.baselineThrough !== undefined && cp.certifiedThrough !== null && cp.certifiedThrough >= cp.initialBaselineThrough
        ? { baselineThrough: batch.coverage.baselineThrough } : {}) }, {
      signal, isCurrent: () => this.current(batch.binding),
      expectedCheckpoint: { key: nativeUpdateCheckpointKey(batch.binding.source), through: batch.expectedProgressThrough },
    });
    if (!committed) throw new Error("Native reply publication rejected");
  }
  /** Late exact assistant snapshots may add runId, never a terminal/legacy alias. */
  correlateCommitted(session: Session, run: Run, event: Event): void {
    if (!this.lifetime || this.closing || !this.enabled.size || event.kind !== "message" || !object(event.data)
      || event.data.role !== "assistant" || typeof event.data.messageId !== "string" || session.sessionId !== run.sessionId) return;
    const binding = this.registered.get(session.sessionId), head = this.options.store.getHead();
    if (!binding || !head || !this.current(binding)) return;
    const messageId = event.data.messageId;
    const correlationKey = JSON.stringify([updateSourceKey(binding.source), messageId, run.runId]);
    if (this.correlations.has(correlationKey) || this.correlations.size >= MAX_QUEUE) return;
    this.correlations.set(correlationKey, { key: correlationKey, binding, messageId, runId: run.runId, head, after: head.retainedAfter });
    this.drainCorrelations();
  }
  /** One globally fair reader, not 256 independent full-feed scans. Every turn
   * yields, examines at most two pages, and rotates unfinished fixed-head jobs. */
  private drainCorrelations(): void {
    const signal = this.lifetime?.signal;
    if (!signal || signal.aborted || this.closing || this.correlationTask || !this.correlations.size) return;
    const task = (async () => {
      while (this.correlations.size && !this.closing && !signal.aborted) {
        await Bun.sleep(0);
        if (this.closing || signal.aborted) return;
        const job = this.correlations.values().next().value!;
        let keep = true;
        const started = performance.now();
        try {
          for (let pages = 0; pages < CORRELATION_PAGES_PER_TURN && performance.now() - started < CORRELATION_TURN_MS; pages++) {
            const live = this.options.store.getHead();
            if (!this.current(job.binding) || !live || live.epoch !== job.head.epoch || live.retainedAfter > job.after
              || job.after >= job.head.through || signal.aborted || this.closing) { keep = false; break; }
            const page = this.options.store.page({ cursor: { epoch: job.head.epoch, after: job.after }, through: job.head.through });
            const matches = new Map(page.updates.filter(candidate => candidate.kind === "reply"
              && candidate.conversationId === job.binding.conversationId && candidate.messageId === job.messageId
              && candidate.runId === undefined && updateSourceKey(candidate.source) === updateSourceKey(job.binding.source))
              .map(candidate => [candidate.id, candidate]));
            const first = matches.values().next().value;
            const selectors = first && this.correlatedRun(first, job.binding) === job.runId
              ? [...matches.values()].map(candidate => ({ id: candidate.id, source: candidate.source,
                conversationId: candidate.conversationId, runId: job.runId })) : [];
            for (let index = 0; index < selectors.length && this.current(job.binding) && !signal.aborted; index += 64) {
              await this.options.updates.correlate(selectors.slice(index, index + 64), { signal, isCurrent: () => this.current(job.binding) });
            }
            if (page.nextCursor.after <= job.after) { keep = false; break; }
            job.after = page.nextCursor.after;
          }
        } catch { keep = false; /* Retention gaps/invalid evidence never rebaseline or hide fallback. */ }
        if (this.correlations.get(job.key) === job) {
          this.correlations.delete(job.key);
          if (keep && job.after < job.head.through && !this.closing && !signal.aborted && this.current(job.binding)) this.correlations.set(job.key, job);
        }
      }
    })().catch(() => {}).finally(() => {
      this.tasks.delete(task);
      if (this.correlationTask === task) this.correlationTask = undefined;
      if (!this.closing) this.drainCorrelations();
    });
    this.correlationTask = task;
    this.tasks.add(task);
  }
  updateSource(conversationId: string): ConversationUpdateSource | undefined {
    const binding = this.registered.get(conversationId);
    return binding && this.current(binding) && !this.problems.has(conversationId) ? { ...binding.source } : undefined;
  }
  coverage(): ConversationUpdateCoverage[] {
    const result = new Map<string, ConversationUpdateCoverage>();
    const persistedCoverage = new Map(this.options.store.getCoverage().map(value => [value.sourceKey, value]));
    const persistedByNative = new Map<string, string[]>();
    for (const key of persistedCoverage.keys()) {
      try {
        const tuple: unknown = JSON.parse(key);
        if (!Array.isArray(tuple) || tuple.length !== 4) continue;
        const source = { harness: tuple[0], authorityId: tuple[1], nativeSessionId: tuple[2], ...(tuple[3] === null ? {} : { incarnation: tuple[3] }) };
        if (!isConversationUpdateSource(source) || source.harness !== "opencode" || updateSourceKey(source) !== key) continue;
        const base = updateSourceKey({ harness: source.harness, authorityId: source.authorityId, nativeSessionId: source.nativeSessionId });
        const keys = persistedByNative.get(base) ?? [];
        keys.push(key); persistedByNative.set(base, keys);
      } catch { /* Unrelated malformed source metadata cannot qualify this source. */ }
    }
    const observerCoverage = new Map([...this.observers.values()].flatMap(observer => observer.coverage()).map(value => [value.sourceKey, value]));
    for (const session of this.sessions()) {
      if (session.harness !== "opencode" || session.agentKind === "worker" || this.options.isWorker(session.sessionId) || session.attachment?.state === "pending") continue;
      const source = appSource(session);
      if (!source || !this.authorities.has(source.authorityId)) continue;
      const binding = this.registered.get(session.sessionId), saved = this.bindings.get(session.sessionId);
      const sourceKey = updateSourceKey(binding?.source ?? source), problem = this.bindings.problem(session.sessionId, source);
      let value: ConversationUpdateCoverage = { sourceKey, state: "unqualified", reason: this.options.disabledReason ?? OC_REPLY_ACTIVATION_BLOCKED };
      if (this.options.allowQualifiedActivation === true && !this.authorities.get(source.authorityId)?.qualification) value.reason = "OpenCode reply updates lack trusted runtime qualification; App run alerts remain available";
      if (problem) value = { sourceKey, state: "unavailable", reason: problem };
      else if (this.authorityProblems.has(source.authorityId)) value.reason = this.authorityProblems.get(source.authorityId);
      else if (this.enabled.has(source.authorityId)) {
        value = { ...persistedCoverage.get(sourceKey), ...(observerCoverage.get(sourceKey)
          ?? { sourceKey, state: "initializing", reason: "Waiting for native reply registration; App run alerts remain available" }) };
        if (binding) {
          // Private cp-v2 certification alone supplies watermarks. Independent
          // old coverage must not survive a null or missing certification.
          const { through: _oldThrough, baselineThrough: _oldBaseline, ...status } = value;
          value = status;
          try {
            const cp = this.checkpoint(binding);
            if (cp) value = { ...value, ...(cp.certifiedThrough === null ? {} : { through: cp.certifiedThrough }),
              ...(cp.certifiedThrough !== null && cp.certifiedThrough >= cp.initialBaselineThrough ? { baselineThrough: cp.initialBaselineThrough } : {}) };
            if (!cp || cp.certifiedThrough === null || cp.certifiedThrough < cp.progressThrough || cp.certifiedThrough < binding.initialBaselineThrough) {
              if (value.state === "ready") value = { ...value, state: "initializing", reason: "Native reply progress is not yet fully certified" };
            }
          } catch { /* Explicit incompatibility below overrides observer status. */ }
        }
        const issue = this.problems.get(session.sessionId);
        if (issue) value = { ...value, ...issue };
        if (!this.eligible.has(session.sessionId)) value = { sourceKey, state: "unavailable", reason: "App parent admission is not ready or no longer matches its registered authority" };
      }
      if (!this.enabled.has(source.authorityId) && this.problems.get(session.sessionId)?.state === "unavailable") value = { ...value, ...this.problems.get(session.sessionId)! };
      result.set(sourceKey, { ...value });
      // Disable old persisted readiness too, without rewriting immutable App or
      // native occurrences. The incarnationless App source keeps its fallback.
      if (!this.enabled.has(source.authorityId) && saved && this.sameNative(source, saved.source)) {
        const key = updateSourceKey(saved.source);
        result.set(key, { ...value, sourceKey: key });
      }
      // Unbound old native checkpoints must not leak persisted source-wide
      // readiness around the disabled gate. Match the exact registered native
      // tuple, but do not claim its old incarnation is a newly admitted binding.
      if (!this.enabled.has(source.authorityId)) for (const key of persistedByNative.get(updateSourceKey(source)) ?? []) {
        result.set(key, { ...value, sourceKey: key });
      }
    }
    return [...result.values()];
  }
  sourceBaselines(): { sourceKey: string; through: number }[] {
    const result: { sourceKey: string; through: number }[] = [];
    for (const binding of this.registered.values()) {
      if (!this.current(binding) || this.options.store.getHealth().state !== "ready") continue;
      try {
        const cp = this.checkpoint(binding);
        if (cp && cp.certifiedThrough !== null && cp.certifiedThrough >= binding.initialBaselineThrough) result.push({ sourceKey: updateSourceKey(binding.source), through: binding.initialBaselineThrough });
      } catch { /* No baseline is inferred from incomplete/old state. */ }
    }
    return result;
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.lifetime?.abort();
    if (this.timer) clearInterval(this.timer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    for (const generation of this.active.values()) generation.controller.abort();
    this.active.clear();
    this.pendingMetadata = undefined;
    this.correlations.clear();
    this.queue.clear(); this.sweep = undefined;
    this.closePromise = (async () => {
      await Promise.allSettled([...this.observers.values()].map(observer => observer.close()));
      await Promise.allSettled([...this.tasks]);
    })();
    return this.closePromise;
  }
}
