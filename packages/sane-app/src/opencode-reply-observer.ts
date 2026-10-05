import { OpenCodeReplyTransportLimitError, type OpenCodeReplyTransport } from "./opencode";
import { isConversationUpdateCandidate, updateSourceKey, type ConversationUpdateCandidate, type ConversationUpdateCoverage } from "../shared/conversation/conversation-updates";
import { initialOpenCodeReplyState, OC_REPLY_MAX_MESSAGES, OC_REPLY_UNQUALIFIED_REASON, OpenCodeReplyReconstructionLimitError, openCodeIncarnation, openCodeLogItem, reduceOpenCodeReply, type OpenCodeReplyBinding, type OpenCodeReplyStateV2 } from "../shared/conversation/oc-reply-reducer";

export const OC_REPLY_QUALIFICATION_CHECKS = [
  "terminal-after-final-text", "last-stop-step", "text-replacement-and-retry",
  "child-and-control-exclusion", "unsafe-reopen-exclusion", "replay-and-log-synced",
  "native-creation-identity", "disconnect-and-restart",
  "synthetic-parent-continuation", "synthetic-only-no-attention", "control-notice-before-final-step",
] as const;
/** Operator-owned runtime evidence, NOT a version/server.info capability guess.
 * Each check must reference a successful captured runtime verification. */
export type OpenCodeReplyQualification = {
  authorityId: string;
  clientVersion: "2.0.18";
  nativeVersion: string;
  verifiedAt: string;
  evidenceRef: string;
  checks: Record<typeof OC_REPLY_QUALIFICATION_CHECKS[number], { passed: true; evidenceRef: string }>;
};
export type OpenCodeReplyRegistration = OpenCodeReplyBinding & {
  /** Pinned at admission, never probed or moved by a late replay worker. */
  initialBaselineThrough: number;
  /** Changes on every remove/rebind, including ABA registrations. */
  registrationRevision: string;
};
export type OpenCodeReplyCheckpoint = {
  /** Version 2 requires native zero-origin reconstruction; version 1 is incompatible. */
  version: 2;
  sourceKey: string;
  nativeVersion: string;
  progressThrough: number;
  /** Only matching ordinary log.synced certifies a range; progress is not certification. */
  certifiedThrough: number | null;
  initialBaselineThrough: number;
  state: OpenCodeReplyStateV2;
};
export type OpenCodeReplyCommit = {
  binding: OpenCodeReplyRegistration;
  candidates: ConversationUpdateCandidate[];
  checkpoint: OpenCodeReplyCheckpoint;
  coverage: ConversationUpdateCoverage;
  messageIds: string[];
  /** null means no prior native checkpoint, not a negative generic cursor. */
  expectedProgressThrough: number | null;
};
export type OpenCodeReplyObserverOptions = {
  authorityId: string;
  /** Adapter.replyTransport, bound through its existing private discovery. */
  transport: () => Promise<OpenCodeReplyTransport>;
  /** Registered parent conversations only; never discover sessions by enumeration. */
  sessions: () => readonly OpenCodeReplyRegistration[];
  load: (binding: OpenCodeReplyRegistration, signal: AbortSignal) => Promise<OpenCodeReplyCheckpoint | undefined>;
  /** Exact source-scoped durable ledger membership. Production MUST supply it.
   * Without it standalone replay retains every identity, bounded at 4096. */
  hasSeenMessage?: (binding: OpenCodeReplyRegistration, id: string) => boolean;
  /** MUST atomically commit candidates + checkpoint + coverage + messageIds,
   * compare expectedProgressThrough, validate current registrationRevision,
   * and deduplicate candidates by occurrence ID.
   * Reject/roll back on abort. A rejected commit is replayed from its old cursor. */
  commit: (batch: OpenCodeReplyCommit, signal: AbortSignal) => Promise<void>;
  /** Optional coverage-only store hook. Must not replace legacy App alerts. */
  coverage?: (coverage: ConversationUpdateCoverage) => void | Promise<void>;
};
const MAX_QUEUE = 256, MAX_EVENTS = 10000, MAX_BYTES = 16 * 1024 * 1024;
const CATCHUP_MS = 15000, ROTATE_MS = 60000, SWEEP_MS = 30000;
const SLICE_EVENTS = 128, SLICE_BYTES = 512 * 1024, SLICE_MS = 2000, COMMIT_MS = 5000, CHECKPOINT_BYTES = 256 * 1024;
const safeInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(v);
const encoder = new TextEncoder();
const nativeId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 1024
  && encoder.encode(v).byteLength <= 1024 && !/[\u0000-\u001f\u007f]/.test(v);
class UnsupportedReplayError extends Error {}
class ReplayIdentityError extends Error {}
class ReplayRequestLimitError extends Error {}
function transportLimit(error: unknown): boolean {
  // Generated SDK transport errors wrap the fetch/body failure in cause.
  for (let depth = 0; depth < 8; depth++) {
    if (error instanceof OpenCodeReplyTransportLimitError) return true;
    if (!error || typeof error !== "object" || !("cause" in error)) return false;
    error = error.cause;
  }
  return false;
}
function malformedStream(error: unknown): boolean {
  for (let depth = 0; depth < 8; depth++) {
    if (error instanceof SyntaxError) return true;
    if (!error || typeof error !== "object" || !("cause" in error)) return false;
    error = error.cause;
  }
  return false;
}
const inputKind = (v: unknown) => v === "user" || v === "synthetic" || v === "control";

/** A persisted checkpoint is usable only with its complete reducer state.
 * This is a private persistence shape, not a new shared HTTP contract. */
export function validateOpenCodeReplyCheckpoint(value: unknown, binding: OpenCodeReplyRegistration, nativeVersion?: string): value is OpenCodeReplyCheckpoint {
  try {
    if (!plain(value) || value.version !== 2 || value.sourceKey !== updateSourceKey(binding.source)
      || binding.source.harness !== "opencode" || !text(binding.registrationRevision)
      || !nativeId(binding.source.nativeSessionId)
      || Object.keys(value).some(k => !["version", "sourceKey", "nativeVersion", "progressThrough", "certifiedThrough", "initialBaselineThrough", "state"].includes(k))
      || !text(value.nativeVersion) || nativeVersion !== undefined && value.nativeVersion !== nativeVersion
      || !safeInt(value.progressThrough) || value.certifiedThrough !== null && (!safeInt(value.certifiedThrough) || value.certifiedThrough > value.progressThrough)
      || !safeInt(value.initialBaselineThrough) || value.initialBaselineThrough !== binding.initialBaselineThrough
      || binding.source.incarnation !== openCodeIncarnation(binding.creation) || !plain(value.state)) return false;
    const s = value.state;
    if (s.version !== 2 || s.sourceKey !== value.sourceKey || s.seq !== value.progressThrough || s.created !== true
      || s.identityLedger !== undefined && s.identityLedger !== "external"
      || !plain(s.creation) || s.creation.eventId !== binding.creation.eventId || s.creation.createdAt !== binding.creation.createdAt
      || typeof s.parent !== "boolean" || typeof s.deleted !== "boolean" || !Array.isArray(s.seenMessages)
      || s.seenMessages.length > OC_REPLY_MAX_MESSAGES || s.seenMessages.some(v => !nativeId(v))
      || new Set(s.seenMessages).size !== s.seenMessages.length || !plain(s.pending) || Object.keys(s.pending).length > 256
      || Object.entries(s.pending).some(([k, v]) => !nativeId(k) || !inputKind(v))
      || s.delivered !== undefined && !inputKind(s.delivered)) return false;
    if (s.window !== undefined) {
      if (s.deleted || !plain(s.window) || !nativeId(s.window.id) || typeof s.window.eligible !== "boolean" || typeof s.window.compacting !== "boolean"
        || s.window.input !== undefined && !inputKind(s.window.input)) return false;
      const step = s.window.step;
      if (step !== undefined && (!plain(step) || !nativeId(step.messageId) || !s.seenMessages.includes(step.messageId)
        || !nativeId(step.generationId) || !safeInt(step.generation) || step.generation < 1
        || !["running", "stop", "other", "failed"].includes(step.status as string)
        || typeof step.tool !== "boolean" || typeof step.unsafe !== "boolean" || typeof step.identityUnsafe !== "boolean"
        || step.identityUnsafe && !step.unsafe || typeof step.retryAllowed !== "boolean"
        || !Array.isArray(step.texts) || step.texts.length > 1024
        || step.texts.some(p => p !== null && (!plain(p) || typeof p.complete !== "boolean" || typeof p.nonempty !== "boolean")))) return false;
    }
    // Match the generic durable store's reducer-state ceiling, leaving room for
    // its envelope. Oversized native reconstruction degrades this source only.
    return encoder.encode(JSON.stringify(value)).byteLength <= CHECKPOINT_BYTES;
  } catch { return false; }
}

/** Optional wiring: constructing/starting this unqualified observer opens no
 * native connection and emits no updates. One instance per registered authority.
 * Global events only dirty a bounded FIFO; two workers replay session logs. */
export class OpenCodeReplyObserver {
  private qualification?: OpenCodeReplyQualification;
  private lifetime?: AbortController;
  private stream?: Promise<void>;
  private sweep?: ReturnType<typeof setInterval>;
  private tasks = new Set<Promise<void>>();
  private bindings = new Map<string, OpenCodeReplyRegistration>();
  private bindingControllers = new Map<string, AbortController>();
  private queue = new Set<string>();
  private active = new Set<string>();
  private dirty = new Set<string>();
  private retryAfter = new Map<string, number>();
  private pendingSweep?: Iterator<string>;
  private resweep = false;
  private statuses = new Map<string, ConversationUpdateCoverage>();
  constructor(private options: OpenCodeReplyObserverOptions) {
    if (!text(options.authorityId)) throw new TypeError("Invalid OpenCode observer authority");
  }
  qualificationStatus(): { state: "unqualified" | "qualified"; reason?: string } {
    return this.qualification ? { state: "qualified" } : { state: "unqualified", reason: OC_REPLY_UNQUALIFIED_REASON };
  }
  /** Call before start, using externally reviewed runtime evidence. No env magic. */
  qualify(descriptor: OpenCodeReplyQualification): void {
    if (this.lifetime) throw new Error("Close the observer before changing qualification");
    if (!descriptor || descriptor.authorityId !== this.options.authorityId || descriptor.clientVersion !== "2.0.18"
      || !text(descriptor.nativeVersion) || !text(descriptor.evidenceRef) || !text(descriptor.verifiedAt)
      || !Number.isFinite(Date.parse(descriptor.verifiedAt))
      || OC_REPLY_QUALIFICATION_CHECKS.some(k => descriptor.checks?.[k]?.passed !== true || !text(descriptor.checks[k].evidenceRef))) throw new TypeError("OpenCode reply qualification requires evidenced runtime checks");
    this.qualification = structuredClone(descriptor);
  }
  coverage(): ConversationUpdateCoverage[] { return [...this.statuses.values()].map(v => ({ ...v })); }
  start(): void {
    if (this.lifetime) return;
    this.lifetime = new AbortController();
    try { this.refresh(); } catch (error) { this.lifetime.abort(); this.lifetime = undefined; throw error; }
    if (!this.qualification) return;
    const signal = this.lifetime.signal;
    this.sweep = setInterval(() => {
      try { this.refresh(); } catch {
        for (const key of this.bindings.keys()) this.report({ sourceKey: key, state: "degraded", reason: "Registered native reply catalog refresh failed; previous registrations retained" });
      }
    }, SWEEP_MS);
    this.stream = this.listen(signal);
  }
  /** Call when registration changes; disconnected sweep is log-only, incremental. */
  refresh(): void {
    const sessions = this.options.sessions();
    const next = new Map<string, OpenCodeReplyRegistration>();
    const rejected = new Map<string, string>();
    const nativeCounts = new Map<string, number>();
    // Count identities before validation: an invalid duplicate must not cause
    // us to silently choose one owner of an ambiguous native session.
    for (const b of sessions) if (b?.source?.harness === "opencode" && b.source.authorityId === this.options.authorityId && text(b.source.nativeSessionId)) {
      nativeCounts.set(b.source.nativeSessionId, (nativeCounts.get(b.source.nativeSessionId) ?? 0) + 1);
    }
    for (const original of sessions) {
      let key: string | undefined;
      try {
        const binding = structuredClone(original);
        key = updateSourceKey(binding.source);
        if (nativeCounts.get(binding.source.nativeSessionId)! > 1) throw new Error("Ambiguous OpenCode reply native registration; all duplicate owners excluded");
        if (binding.source.harness !== "opencode" || binding.source.authorityId !== this.options.authorityId
          || !nativeId(binding.source.nativeSessionId)
          || binding.source.incarnation !== openCodeIncarnation(binding.creation) || !text(binding.conversationId)
          || !safeInt(binding.initialBaselineThrough) || !text(binding.registrationRevision)) throw new Error("Invalid OpenCode reply registration");
        next.set(key, binding);
      } catch {
        if (key) rejected.set(key, nativeCounts.get(original.source.nativeSessionId)! > 1
          ? "Ambiguous OpenCode reply native registration; all duplicate owners excluded" : "Invalid OpenCode reply registration");
      }
    }
    let changed = next.size !== this.bindings.size;
    for (const [key, old] of this.bindings) {
      const replacement = next.get(key);
      if (!replacement || !this.sameRegistration(old, replacement)) {
        changed = true;
        this.bindingControllers.get(key)?.abort();
        this.bindingControllers.delete(key);
        this.retryAfter.delete(key);
        this.queue.delete(key); this.dirty.delete(key); this.statuses.delete(key);
      }
    }
    for (const key of next.keys()) if (!this.bindingControllers.has(key)) this.bindingControllers.set(key, new AbortController());
    this.bindings = next;
    for (const key of this.statuses.keys()) if (!next.has(key) && !rejected.has(key)) this.statuses.delete(key);
    for (const [sourceKey, reason] of rejected) this.report({ sourceKey, state: "degraded", reason });
    // Registration changes restart enumeration; ordinary sweeps never restart
    // at the catalog head while cold replay is still draining a large catalog.
    if (changed) this.pendingSweep = undefined;
    for (const key of next.keys()) {
      if (!this.qualification) this.report({ sourceKey: key, state: "unqualified", reason: OC_REPLY_UNQUALIFIED_REASON });
      else if (!this.statuses.has(key)) this.report({ sourceKey: key, state: "initializing", reason: "Waiting for bounded native log catch-up" });
    }
    if (this.qualification && this.lifetime) this.scheduleAll();
  }
  async close(): Promise<void> {
    const controller = this.lifetime;
    if (!controller) return;
    controller.abort();
    for (const binding of this.bindingControllers.values()) binding.abort();
    if (this.sweep) clearInterval(this.sweep);
    this.queue.clear(); this.dirty.clear(); this.pendingSweep = undefined; this.resweep = false;
    await Promise.allSettled([...(this.stream ? [this.stream] : []), ...this.tasks]);
    this.bindingControllers.clear();
    this.retryAfter.clear();
    this.lifetime = undefined; this.stream = undefined; this.sweep = undefined;
  }
  private report(value: ConversationUpdateCoverage): void {
    if (JSON.stringify(this.statuses.get(value.sourceKey)) === JSON.stringify(value)) return;
    this.statuses.set(value.sourceKey, value);
    // Coverage hook failure cannot turn an incomplete log into ready coverage.
    try { void Promise.resolve(this.options.coverage?.({ ...value })).catch(() => {}); } catch { /* optional diagnostics */ }
  }
  private enqueue(key: string): void {
    if (!this.bindings.has(key) || !this.lifetime || this.lifetime.signal.aborted) return;
    if ((this.retryAfter.get(key) ?? 0) > Date.now()) return;
    if (this.active.has(key)) this.dirty.add(key);
    else if (this.queue.size < MAX_QUEUE) this.queue.add(key);
    else if (!this.queue.has(key)) this.requestSweep();
    this.drain();
  }
  private requestSweep(): void {
    if (!this.pendingSweep) this.pendingSweep = this.bindings.keys();
    else this.resweep = true;
  }
  private scheduleAll(): void {
    this.requestSweep();
    this.drain();
  }
  private fillQueue(): void {
    while (this.pendingSweep && this.queue.size < MAX_QUEUE) {
      const next = this.pendingSweep.next();
      if (next.done) {
        this.pendingSweep = this.resweep ? this.bindings.keys() : undefined;
        this.resweep = false;
        if (!this.bindings.size) this.pendingSweep = undefined;
        continue;
      }
      if (!this.bindings.has(next.value)) continue;
      if ((this.retryAfter.get(next.value) ?? 0) > Date.now()) continue;
      if (this.active.has(next.value)) this.dirty.add(next.value);
      else this.queue.add(next.value);
    }
  }
  private drain(): void {
    const signal = this.lifetime?.signal;
    if (!signal || signal.aborted || !this.qualification) return;
    this.fillQueue();
    while (this.active.size < 2 && this.queue.size) {
      const key = this.queue.values().next().value!;
      this.queue.delete(key);
      if ((this.retryAfter.get(key) ?? 0) > Date.now()) { this.fillQueue(); continue; }
      const binding = this.bindings.get(key);
      if (!binding) { this.fillQueue(); continue; }
      this.active.add(key);
      const bindingSignal = this.bindingControllers.get(key)!.signal;
      let productive = false;
      const task = this.catchup(binding, AbortSignal.any([signal, bindingSignal])).then(value => { productive = value; }).finally(() => {
        this.active.delete(key); this.tasks.delete(task);
        const dirty = this.dirty.delete(key);
        if ((dirty || productive && this.current(binding) && !bindingSignal.aborted) && !signal.aborted && this.bindings.has(key)) {
          if (this.queue.size < MAX_QUEUE) this.queue.add(key);
          else this.requestSweep();
        }
        this.drain();
      });
      this.tasks.add(task);
      this.fillQueue();
    }
  }
  private sameRegistration(a: OpenCodeReplyRegistration, b: OpenCodeReplyRegistration): boolean {
    return a.conversationId === b.conversationId && a.registrationRevision === b.registrationRevision
      && a.initialBaselineThrough === b.initialBaselineThrough && updateSourceKey(a.source) === updateSourceKey(b.source);
  }
  private current(binding: OpenCodeReplyRegistration): boolean {
    const registered = this.bindings.get(updateSourceKey(binding.source));
    return !!registered && this.sameRegistration(registered, binding);
  }
  private coverageFor(binding: OpenCodeReplyRegistration, checkpoint: OpenCodeReplyCheckpoint | undefined, state: ConversationUpdateCoverage["state"], reason?: string): ConversationUpdateCoverage {
    const certified = checkpoint?.certifiedThrough;
    return { sourceKey: updateSourceKey(binding.source), state, ...(reason ? { reason } : {}),
      ...(certified !== undefined && certified !== null ? { through: certified,
        ...(certified >= binding.initialBaselineThrough ? { baselineThrough: binding.initialBaselineThrough } : {}) } : {}) };
  }
  /** One bounded prefix per turn. Returning true puts productive unfinished
   * work at the FIFO tail, rather than monopolizing either replay worker. */
  private async catchup(binding: OpenCodeReplyRegistration, lifetime: AbortSignal): Promise<boolean> {
    const key = updateSourceKey(binding.source);
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(CATCHUP_MS)]);
    let saved: OpenCodeReplyCheckpoint | undefined;
    try {
      const nativeVersion = this.qualification!.nativeVersion;
      const loaded = await this.options.load(binding, signal);
      signal.throwIfAborted();
      if (!this.current(binding)) return false;
      if (loaded !== undefined && !validateOpenCodeReplyCheckpoint(loaded, binding, nativeVersion)) throw new UnsupportedReplayError("Incomplete native reply checkpoint or incompatible schema/version/fence; version 2 zero-origin progress state and an evidenced replay baseline are required");
      if (loaded?.state.identityLedger === "external" && !this.options.hasSeenMessage) throw new UnsupportedReplayError("Native reply checkpoint requires its exact external identity ledger; standalone replay cannot restore compacted identities");
      saved = loaded === undefined ? undefined : structuredClone(loaded);
      this.report(this.coverageFor(binding, saved, "initializing"));
      const transport = await this.options.transport();
      signal.throwIfAborted();
      const info = await transport.info({ signal });
      signal.throwIfAborted();
      if (info.version !== nativeVersion) {
        this.dirty.delete(key); this.retryAfter.set(key, Date.now() + SWEEP_MS);
        this.report(this.coverageFor(binding, saved, "unqualified", "Native version differs from evidenced reply qualification"));
        return false;
      }
      const verify = async (verificationSignal: AbortSignal) => {
        verificationSignal.throwIfAborted();
        const session = await transport.session({ sessionID: binding.source.nativeSessionId }, { signal: verificationSignal });
        verificationSignal.throwIfAborted();
        if (session.id !== binding.source.nativeSessionId || session.time.created !== binding.creation.createdAt || session.parentID !== undefined) throw new ReplayIdentityError("Native reply session creation identity or parent ownership changed");
        if (!this.current(binding)) throw new ReplayIdentityError("Native reply registration changed");
      };
      await verify(signal);
      let state = saved ? structuredClone(saved.state) : initialOpenCodeReplyState(binding);
      let certifiedThrough = saved?.certifiedThrough ?? null;
      const candidates: ConversationUpdateCandidate[] = [];
      const makeCheckpoint = (nextState: OpenCodeReplyStateV2): OpenCodeReplyCheckpoint => ({ version: 2, sourceKey: key, nativeVersion,
        progressThrough: nextState.seq, certifiedThrough, initialBaselineThrough: binding.initialBaselineThrough, state: nextState });
      let events = 0, bytes = 0, prefixEvents = 0, synced = false, rotated = false;
      let readFailure: unknown;
      const rotation = new AbortController();
      const readSignal = AbortSignal.any([signal, rotation.signal]);
      const timer = setTimeout(() => rotation.abort(), SLICE_MS);
      const started = Date.now();
      // Omitted after includes native creation at 0. Never send private -1.
      let iterator: AsyncIterator<unknown> | undefined;
      try {
        iterator = transport.log({ sessionID: binding.source.nativeSessionId,
          ...(saved ? { after: saved.progressThrough } : {}), follow: false }, { signal: readSignal })[Symbol.asyncIterator]();
        while (true) {
          const next = await iterator.next();
          readSignal.throwIfAborted();
          if (next.done) throw new UnsupportedReplayError("Native reply log ended before log.synced; current slice rejected without advancing checkpoint");
          if (++events > MAX_EVENTS) throw new ReplayRequestLimitError("Native reply replay request exceeds 10000 log items; certification remains incomplete");
          let size: number;
          try { size = encoder.encode(JSON.stringify(next.value)).byteLength; }
          catch { throw new UnsupportedReplayError("Unsupported or incomplete OpenCode durable reply log"); }
          // A single event must fit the normal slice quota even when the slice
          // is empty. It cannot be made admissible by rotating or hot retrying.
          if (size > SLICE_BYTES) throw new UnsupportedReplayError("Unsupported native reply log item exceeds 512 KiB decoded slice budget; current slice rejected");
          if (bytes + size > MAX_BYTES) throw new ReplayRequestLimitError("Native reply replay request exceeds 16 MiB; certification remains incomplete");
          // A fetched but unaccepted event is replayed from the committed cursor.
          if (prefixEvents && bytes + size > SLICE_BYTES) { rotated = true; break; }
          bytes += size;
          try {
            const event = openCodeLogItem(next.value, binding.source.nativeSessionId);
            if (event.type === "log.synced") {
              if (!state.created) throw new UnsupportedReplayError("Native reply replay unavailable or incomplete: session.created at sequence 0 is required; log.synced alone is not a replay baseline");
              if (event.seq === undefined || event.seq !== state.seq) throw new UnsupportedReplayError("Native log.synced did not certify complete sequence coverage");
              certifiedThrough = event.seq; synced = true;
              break;
            }
            const result = reduceOpenCodeReply(state, event, binding, event.durable.seq <= binding.initialBaselineThrough,
              this.options.hasSeenMessage ? id => this.options.hasSeenMessage!(binding, id) : undefined);
            if (result.candidate && !isConversationUpdateCandidate(result.candidate)) throw new UnsupportedReplayError("Native reply candidate violates update contract");
            // Bound transient local identities as well as persisted state. Rotate
            // before overflow when a smaller valid prefix can be committed.
            const prospective = makeCheckpoint(result.state);
            if (encoder.encode(JSON.stringify(prospective)).byteLength > CHECKPOINT_BYTES && prefixEvents) { rotated = true; break; }
            if (!validateOpenCodeReplyCheckpoint(prospective, binding, nativeVersion)) throw new UnsupportedReplayError("Unsupported native reply checkpoint shape or 256 KiB persistence budget; an evidenced replay baseline is required");
            state = result.state; prefixEvents++;
            if (result.candidate) candidates.push(result.candidate);
          } catch (error) {
            if (error instanceof UnsupportedReplayError || error instanceof OpenCodeReplyReconstructionLimitError) throw error;
            // A semantic/schema/ledger failure rejects THIS entire slice. Do not
            // mistake it for a network interruption and publish its prefix.
            throw new UnsupportedReplayError("Unsupported or incomplete OpenCode durable reply log or exact identity ledger");
          }
          if (prefixEvents >= SLICE_EVENTS || bytes >= SLICE_BYTES || Date.now() - started >= SLICE_MS) { rotated = true; break; }
        }
      } catch (error) {
        if (error instanceof UnsupportedReplayError || error instanceof OpenCodeReplyReconstructionLimitError) throw error;
        if (malformedStream(error)) throw new UnsupportedReplayError("Unsupported or malformed OpenCode durable reply stream; current slice rejected");
        if (rotation.signal.aborted && !signal.aborted) rotated = true;
        else readFailure = error;
      } finally {
        clearTimeout(timer);
        // Abort before return so a waiting SDK read cannot keep rotation open.
        rotation.abort();
        try { await iterator?.return?.(); } catch { /* validated prefix is independent of transport cleanup */ }
      }
      lifetime.throwIfAborted();
      if (!this.current(binding)) return false;
      if (!synced && !prefixEvents) throw new Error("No native replay progress or certification");
      const commitSignal = AbortSignal.any([lifetime, AbortSignal.timeout(COMMIT_MS)]);
      // A read timeout/transport interruption must not poison a fresh identity
      // verification and atomic commit of an already validated durable prefix.
      await verify(commitSignal);
      const checkpointState = structuredClone(state);
      const messageIds = [...state.seenMessages];
      if (this.options.hasSeenMessage) {
        checkpointState.identityLedger = "external";
        checkpointState.seenMessages = state.window?.step ? [state.window.step.messageId] : [];
      }
      const checkpoint = makeCheckpoint(checkpointState);
      if (!validateOpenCodeReplyCheckpoint(checkpoint, binding, nativeVersion)) throw new UnsupportedReplayError("Unsupported native reply checkpoint shape or 256 KiB persistence budget; an evidenced replay baseline is required");
      const reason = readFailure ? transportLimit(readFailure) ? "Native reply raw replay exceeds 16 MiB; valid prefix retained without complete certification"
        : readFailure instanceof ReplayRequestLimitError ? readFailure.message : "Native reply replay interrupted; valid prefix retained without complete certification" : undefined;
      const coverage = this.coverageFor(binding, checkpoint, synced ? "ready" : readFailure ? "degraded" : "initializing", reason);
      if (prefixEvents || saved?.certifiedThrough !== certifiedThrough) {
        await this.options.commit({ binding, candidates, checkpoint, coverage, messageIds,
          expectedProgressThrough: saved?.progressThrough ?? null }, commitSignal);
        commitSignal.throwIfAborted();
        // Until this callback succeeds, state still has every slice identity;
        // compaction is usable only alongside the durably committed exact ledger.
        saved = checkpoint;
      }
      if (!this.current(binding) || lifetime.aborted) return false;
      this.retryAfter.delete(key);
      this.report(coverage);
      return !synced && (rotated || !!readFailure) && prefixEvents > 0;
    } catch (error) {
      if (lifetime.aborted || !this.current(binding)) return false;
      this.dirty.delete(key);
      // Empty/transient and semantic failures fall back to the bounded sweep,
      // not immediate hint-driven retries of a broken slice.
      this.retryAfter.set(key, Date.now() + SWEEP_MS);
      const reason = error instanceof UnsupportedReplayError || error instanceof OpenCodeReplyReconstructionLimitError || error instanceof ReplayIdentityError ? error.message
        : transportLimit(error) ? "Native reply raw replay exceeds 16 MiB; no checkpoint advanced"
        : signal.aborted ? "Native reply catch-up deadline expired; no checkpoint advanced"
        : "Native reply catch-up incomplete; no checkpoint advanced";
      this.report(this.coverageFor(binding, saved, "degraded", reason));
      return false;
    }
  }
  private async listen(lifetime: AbortSignal): Promise<void> {
    let delay = 250;
    while (!lifetime.aborted) {
      const signal = AbortSignal.any([lifetime, AbortSignal.timeout(ROTATE_MS)]);
      try {
        const transport = await this.options.transport();
        signal.throwIfAborted();
        // Events are hints only; periodic bounded log sweeps close startup races.
        let events = 0;
        for await (const event of transport.events({ signal })) {
          signal.throwIfAborted();
          if (++events > MAX_EVENTS) break;
          if (event.type === "server.connected") {
            delay = 250;
            this.scheduleAll();
          } else if (["session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.deleted"].includes(event.type) && "data" in event) {
            const data: unknown = event.data;
            if (plain(data) && typeof data.sessionID === "string") {
              for (const [key, binding] of this.bindings) if (binding.source.nativeSessionId === data.sessionID) this.enqueue(key);
            }
          }
        }
      } catch { /* live source failure: reconnect; logs remain authoritative */ }
      if (lifetime.aborted) break;
      this.scheduleAll();
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); lifetime.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, delay);
        lifetime.addEventListener("abort", done, { once: true });
        if (lifetime.aborted) done();
      });
      delay = Math.min(delay * 2, 5000);
    }
  }
}
