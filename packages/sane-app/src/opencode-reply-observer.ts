import { OpenCodeReplyTransportLimitError, type OpenCodeReplyTransport } from "./opencode";
import { isConversationUpdateCandidate, updateSourceKey, type ConversationUpdateCandidate, type ConversationUpdateCoverage } from "../shared/conversation/conversation-updates";
import { initialOpenCodeReplyState, OC_REPLY_MAX_MESSAGES, OC_REPLY_UNQUALIFIED_REASON, OpenCodeReplyReconstructionLimitError, openCodeIncarnation, openCodeLogItem, reduceOpenCodeReply, type OpenCodeReplyBinding, type OpenCodeReplyState } from "../shared/conversation/oc-reply-reducer";

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
export type OpenCodeReplyCheckpoint = {
  version: 1;
  sourceKey: string;
  /** Only the explicit log.synced watermark, never max(observed seq). */
  through: number;
  baselineThrough: number;
  state: OpenCodeReplyState;
};
export type OpenCodeReplyCommit = {
  binding: OpenCodeReplyBinding;
  candidates: ConversationUpdateCandidate[];
  checkpoint: OpenCodeReplyCheckpoint;
  coverage: ConversationUpdateCoverage;
};
export type OpenCodeReplyObserverOptions = {
  authorityId: string;
  /** Adapter.replyTransport, bound through its existing private discovery. */
  transport: () => Promise<OpenCodeReplyTransport>;
  /** Registered parent conversations only; never discover sessions by enumeration. */
  sessions: () => readonly OpenCodeReplyBinding[];
  load: (binding: OpenCodeReplyBinding, signal: AbortSignal) => Promise<OpenCodeReplyCheckpoint | undefined>;
  /** MUST atomically commit candidates + checkpoint + coverage, validate that the
   * registration is still current, and deduplicate candidates by occurrence ID.
   * Reject/roll back on abort. A rejected commit is replayed from its old cursor. */
  commit: (batch: OpenCodeReplyCommit, signal: AbortSignal) => Promise<void>;
  /** Optional coverage-only store hook. Must not replace legacy App alerts. */
  coverage?: (coverage: ConversationUpdateCoverage) => void | Promise<void>;
};
const MAX_QUEUE = 256, MAX_EVENTS = 10000, MAX_BYTES = 16 * 1024 * 1024;
const CATCHUP_MS = 15000, ROTATE_MS = 60000, SWEEP_MS = 30000;
const safeInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(v);
const encoder = new TextEncoder();
class UnsupportedReplayError extends Error {}
function transportLimit(error: unknown): boolean {
  // Generated SDK transport errors wrap the fetch/body failure in cause.
  for (let depth = 0; depth < 8; depth++) {
    if (error instanceof OpenCodeReplyTransportLimitError) return true;
    if (!error || typeof error !== "object" || !("cause" in error)) return false;
    error = error.cause;
  }
  return false;
}
const inputKind = (v: unknown) => v === "user" || v === "synthetic" || v === "control";

/** A persisted checkpoint is usable only with its complete reducer state.
 * This is a private persistence shape, not a new shared HTTP contract. */
export function validateOpenCodeReplyCheckpoint(value: unknown, binding: OpenCodeReplyBinding): value is OpenCodeReplyCheckpoint {
  try {
    if (!plain(value) || value.version !== 1 || value.sourceKey !== updateSourceKey(binding.source)
      || !safeInt(value.through) || !safeInt(value.baselineThrough) || value.baselineThrough > value.through || !plain(value.state)) return false;
    const s = value.state;
    if (s.version !== 1 || s.sourceKey !== value.sourceKey || s.seq !== value.through || s.created !== true
      || !plain(s.creation) || s.creation.eventId !== binding.creation.eventId || s.creation.createdAt !== binding.creation.createdAt
      || typeof s.parent !== "boolean" || typeof s.deleted !== "boolean" || !Array.isArray(s.seenMessages)
      || s.seenMessages.length > OC_REPLY_MAX_MESSAGES || s.seenMessages.some(v => !text(v))
      || new Set(s.seenMessages).size !== s.seenMessages.length || !plain(s.pending) || Object.keys(s.pending).length > 256
      || Object.entries(s.pending).some(([k, v]) => !text(k) || !inputKind(v))
      || s.delivered !== undefined && !inputKind(s.delivered)) return false;
    if (s.window !== undefined) {
      if (s.deleted || !plain(s.window) || !text(s.window.id) || typeof s.window.eligible !== "boolean" || typeof s.window.compacting !== "boolean"
        || s.window.input !== undefined && !inputKind(s.window.input)) return false;
      const step = s.window.step;
      if (step !== undefined && (!plain(step) || !text(step.messageId) || !s.seenMessages.includes(step.messageId)
        || !text(step.generationId) || !safeInt(step.generation) || step.generation < 1
        || !["running", "stop", "other", "failed"].includes(step.status as string)
        || typeof step.tool !== "boolean" || typeof step.unsafe !== "boolean" || typeof step.retryAllowed !== "boolean"
        || !Array.isArray(step.texts) || step.texts.length > 1024
        || step.texts.some(p => p !== null && (!plain(p) || typeof p.complete !== "boolean" || typeof p.nonempty !== "boolean")))) return false;
    }
    // Match the generic durable store's reducer-state ceiling, leaving room for
    // its envelope. Oversized native reconstruction degrades this source only.
    return encoder.encode(JSON.stringify(value)).byteLength <= 256 * 1024;
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
  private bindings = new Map<string, OpenCodeReplyBinding>();
  private queue = new Set<string>();
  private active = new Set<string>();
  private dirty = new Set<string>();
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
    const next = new Map<string, OpenCodeReplyBinding>();
    const nativeIds = new Set<string>();
    for (const original of sessions) {
      const binding = structuredClone(original);
      const key = updateSourceKey(binding.source);
      if (binding.source.harness !== "opencode" || binding.source.authorityId !== this.options.authorityId
        || binding.source.incarnation !== openCodeIncarnation(binding.creation) || !text(binding.conversationId)
        || next.has(key)) throw new TypeError("Invalid or duplicate OpenCode reply registration");
      // Also rejects two different App conversations for one native identity.
      if (nativeIds.has(binding.source.nativeSessionId)) throw new TypeError("Ambiguous OpenCode reply native registration");
      nativeIds.add(binding.source.nativeSessionId);
      next.set(key, binding);
    }
    const changed = next.size !== this.bindings.size || [...next].some(([key, value]) => this.bindings.get(key)?.conversationId !== value.conversationId);
    this.bindings = next;
    for (const key of this.statuses.keys()) if (!next.has(key)) { this.statuses.delete(key); this.queue.delete(key); this.dirty.delete(key); }
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
    if (this.sweep) clearInterval(this.sweep);
    this.queue.clear(); this.dirty.clear(); this.pendingSweep = undefined; this.resweep = false;
    await Promise.allSettled([...(this.stream ? [this.stream] : []), ...this.tasks]);
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
      const binding = this.bindings.get(key);
      if (!binding) continue;
      this.active.add(key);
      const task = this.catchup(binding, signal).finally(() => {
        this.active.delete(key); this.tasks.delete(task);
        if (this.dirty.delete(key) && !signal.aborted) {
          if (this.queue.size < MAX_QUEUE) this.queue.add(key);
          else this.requestSweep();
        }
        this.drain();
      });
      this.tasks.add(task);
      this.fillQueue();
    }
  }
  private current(binding: OpenCodeReplyBinding): boolean {
    const registered = this.bindings.get(updateSourceKey(binding.source));
    return registered?.conversationId === binding.conversationId;
  }
  private async catchup(binding: OpenCodeReplyBinding, lifetime: AbortSignal): Promise<void> {
    const key = updateSourceKey(binding.source);
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(CATCHUP_MS)]);
    let saved: OpenCodeReplyCheckpoint | undefined;
    try {
      // No population-sized in-memory reducer cache. Only two active replay
      // states exist; all other cursors/state belong to the injected store.
      const loaded = await this.options.load(binding, signal);
      if (loaded !== undefined && !validateOpenCodeReplyCheckpoint(loaded, binding)) throw new UnsupportedReplayError("Incomplete native reply checkpoint; an evidenced replay baseline is required");
      saved = loaded === undefined ? undefined : structuredClone(loaded);
      this.report({ sourceKey: key, state: "initializing", ...(saved ? { through: saved.through, baselineThrough: saved.baselineThrough } : {}) });
      const transport = await this.options.transport();
      signal.throwIfAborted();
      // An upgrade invalidates previously supplied controlflow evidence. Info
      // may reject evidence, but can never qualify a source by itself.
      const info = await transport.info({ signal });
      if (info.version !== this.qualification?.nativeVersion) {
        this.report({ sourceKey: key, state: "unqualified", reason: "Native version differs from evidenced reply qualification", ...(saved ? { through: saved.through, baselineThrough: saved.baselineThrough } : {}) });
        return;
      }
      const verify = async () => {
        const session = await transport.session({ sessionID: binding.source.nativeSessionId }, { signal });
        if (session.id !== binding.source.nativeSessionId || session.time.created !== binding.creation.createdAt || session.parentID !== undefined) throw new Error("Native reply session creation identity or parent ownership changed");
      };
      await verify();
      let state = saved ? structuredClone(saved.state) : initialOpenCodeReplyState(binding);
      const candidates: ConversationUpdateCandidate[] = [];
      let events = 0, bytes = 0, through: number | undefined;
      for await (const raw of transport.log({ sessionID: binding.source.nativeSessionId, after: state.seq, follow: false }, { signal })) {
        signal.throwIfAborted();
        if (++events > MAX_EVENTS) throw new UnsupportedReplayError("Unsupported catch-up: more than 10000 log items before log.synced; partial replay checkpoints are not implemented");
        if ((bytes += encoder.encode(JSON.stringify(raw)).byteLength) > MAX_BYTES) throw new UnsupportedReplayError("Unsupported catch-up: more than 16 MiB before log.synced; partial replay checkpoints are not implemented");
        const event = openCodeLogItem(raw, binding.source.nativeSessionId);
        if (event.type === "log.synced") {
          // Optional/missing seq is NOT evidence of zero or max seen sequence.
          if (event.seq === undefined || event.seq !== state.seq || !state.created) throw new Error("Native log.synced did not certify complete sequence coverage");
          through = event.seq;
          break;
        }
        const result = reduceOpenCodeReply(state, event, binding, saved === undefined);
        state = result.state;
        if (result.candidate) {
          if (!isConversationUpdateCandidate(result.candidate)) throw new Error("Native reply candidate violates update contract");
          candidates.push(result.candidate);
        }
      }
      if (through === undefined) throw new Error("Native reply log ended before log.synced; no checkpoint advanced");
      await verify();
      signal.throwIfAborted();
      if (!this.current(binding)) return;
      if (saved?.through === through) {
        this.report({ sourceKey: key, state: "ready", through, baselineThrough: saved.baselineThrough });
        return;
      }
      const checkpoint: OpenCodeReplyCheckpoint = { version: 1, sourceKey: key, through,
        baselineThrough: saved?.baselineThrough ?? through, state };
      if (!validateOpenCodeReplyCheckpoint(checkpoint, binding)) throw new UnsupportedReplayError("Unsupported native reply checkpoint shape or 1 MiB persistence budget; an evidenced replay baseline is required");
      const coverage: ConversationUpdateCoverage = { sourceKey: key, state: "ready", through, baselineThrough: checkpoint.baselineThrough };
      await this.options.commit({ binding, candidates, checkpoint, coverage }, signal);
      if (!this.current(binding) || lifetime.aborted) return;
      this.report(coverage);
    } catch (error) {
      if (lifetime.aborted || !this.current(binding)) return;
      // Never expose SDK exceptions that may contain endpoint credentials/text.
      const reason = error instanceof UnsupportedReplayError || error instanceof OpenCodeReplyReconstructionLimitError ? error.message
        : transportLimit(error) ? "Unsupported catch-up: raw response exceeds 16 MiB before log.synced; partial replay checkpoints are not implemented"
        : signal.aborted ? "Unsupported catch-up: 15-second deadline expired before complete commit; partial replay checkpoints are not implemented"
        : "Native reply catch-up incomplete; cursor not advanced";
      this.report({ sourceKey: key, state: "degraded", reason, ...(saved ? { through: saved.through, baselineThrough: saved.baselineThrough } : {}) });
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
