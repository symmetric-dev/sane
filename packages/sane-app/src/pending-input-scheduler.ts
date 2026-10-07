import type { DispatchIdentity, DispatchSubmissionEvidence } from "../shared/conversation/dispatch-contract";
import { ConversationCoordinator, type ConversationAdmissionLease } from "./conversation-coordinator";
import { synchronousDispatchHook } from "./dispatch-evidence";
import type { DispatchLifecycle } from "./harness-dispatch";
import { DispatchProofUnavailableError } from "./harness-dispatch";
import { dispatchSource, validateAuthorization, validateIdentity } from "./pending-input-codec";
import { uuid } from "./history";
import { PendingInputDomainError, type PendingInputAuthorization, type PendingInputLiveValidation, type PendingInputPause, type PendingInputStoredItem } from "./pending-input-contract";
import type { PendingInputStore } from "./pending-input-store";
import { equal, immutable } from "./prepared-input-codec";
import type { PreparedAdmissionContext, PreparedAdmissionResult } from "./prepared-input-admission";
import type { RunOwner } from "./run-owner";
import type { PreparedUserInput } from "./user-input-preparation";

export type PendingInputSelection<O extends RunOwner = RunOwner> = Readonly<{
  item: PendingInputStoredItem;
  revision: number;
  predecessor: DispatchLifecycle<O> | null;
  /** Original identity only, NOT release/success/resume authority. Always set by
   * the scheduler; optional for existing bridge-owned selection constructors.
   * With no live handle, only this chain's durable predecessor may supply it. */
  predecessorRunId?: string | null;
}>;
export type PendingInputObservation = { kind: "wait" } | { kind: "pause"; pause: PendingInputPause };
/** This object is a LIVE bridge capability, never a persisted DTO. validate must
 * recheck source/configuration/context and its authorization on every invocation.
 * observation validates original identities without granting native submission;
 * it must remain usable during pauses/shutdown for outcome/reconciliation. */
export type PendingInputLiveProof = Readonly<{
  authorization: PendingInputAuthorization;
  validate: (input: PendingInputLiveValidation, purpose: "submission" | "observation") => void;
}>;
export type PendingInputDispatchProof = PendingInputLiveProof & Readonly<{
  basis: "new-idle-chain" | "user-resume" | "successful-predecessor";
}>;
export type PendingInputSchedulerDependencies<O extends RunOwner = RunOwner> = {
  store: PendingInputStore;
  coordinator: ConversationCoordinator<O>;
  /** Bridge's current chain predecessor (including ordinary non-queue runs).
   * Return the SAME handle after release while this chain depends on it. A
   * replacement handle invalidates outstanding preflight and old success proof.
   * null means no LIVE lifecycle. Current-chain durable metadata may bind an
   * identity, never permission; only fresh live user-resume can use that binding
   * without a handle. The bridge owns lifecycle/startup/domain controls. */
  predecessor: (conversationId: string) => DispatchLifecycle<O> | null;
  /** Read-only async source/config/context + fresh idle proof. No leases, native
   * submission, capability activation or configuration mutation. Abort promptly.
   * Transport-unavailable => wait; source/config/context drift => durable pause.
   * Even without a predecessor, return an explicit live new-chain/resume proof. */
  preflight: (selection: PendingInputSelection<O>, signal: AbortSignal) => Promise<PendingInputObservation | { kind: "ready"; proof: PendingInputDispatchProof }>;
  /** Independent exact-run reconciliation/release proof for history. completed
   * additionally requires the shared lifecycle's fresh successfulSettlement.
   * Failed/interrupted must be proven, not inferred from run.status/done. */
  settlement: (selection: PendingInputSelection<O>, lifecycle: DispatchLifecycle<O>, signal: AbortSignal) => Promise<PendingInputObservation | { kind: "ready"; status: "completed" | "failed" | "interrupted"; proof: PendingInputLiveProof }>;
  /** Wrap immutable PreparedInputAdmission.admit using its EXISTING context.
   * publish MUST run synchronously immediately after shared lifecycle creation,
   * before its deferred execute and before awaiting admission/returning a result.
   * If install throws before a handle exists, do not manufacture non-submission.
   * Normalize expected bridge admission errors to PendingInputDomainError on
   * rejection (preserving code/reason). Translate that error to the bridge's
   * domain-error type when calling existing context hooks if required there;
   * never normalize storage/invariant errors into a retryable domain refusal.
   * Exact installed owner stays in coordinator; no second registry belongs here.
   * CC idle-only; OC one irreversible native-queued-handoff claimed head. Foreign
   * OC activity may delay/ambiguate delivery: no exclusive control/order promise. */
  dispatch: (prepared: PreparedUserInput, lease: ConversationAdmissionLease, options: {
    context: PreparedAdmissionContext;
    publish: (lifecycle: DispatchLifecycle<O>) => void;
  }) => Promise<PreparedAdmissionResult>;
  allocate: (harnessId: string) => { runId: string; attemptId: string; nativeCommandId: string | null };
  failClosed: (error: unknown) => void;
  /** Bounded round-robin reconsideration, NOT fairness against other consumers. */
  maxConversationsPerPass?: number;
};

type CapturedSelection<O extends RunOwner> = PendingInputSelection<O> & Readonly<{ predecessorRunId: string | null }>;
type Attempt<O extends RunOwner> = {
  selection: CapturedSelection<O>; identity: DispatchIdentity;
  lease: ConversationAdmissionLease; readonly proof: PendingInputDispatchProof;
  lifecycle?: DispatchLifecycle<O>; done: boolean; resultFinished: boolean;
};
type Authority<O extends RunOwner> = { attempt: Attempt<O>; stage: PendingInputLiveValidation["stage"]; proof: PendingInputLiveProof };
const submissionStages = new Set(["claim", "active-claim", "link", "before-native"]);
const driftCodes = new Set(["source-changed", "configuration-changed", "context-changed", "dispatch-source-mismatch"]);
const stopped = Symbol("scheduler-stopped");

/** App-only FIFO consumer. Store owns queue transitions; coordinator owns leases
 * and execution. The bounded map below holds only this consumer's unresolved
 * attempts/dependent lifecycle handles, never arbitrates execution ownership.
 * Construct store.validateLive as a closure routing dispatch stages to this
 * instance's validateLive; enqueue/resume remain bridge-owned live validation.
 * Route coordinator/domain/lifecycle events to notify*, and invoke poll from a
 * bridge-owned bounded backstop (no native observer or timer is installed here). */
export class PendingInputScheduler<O extends RunOwner = RunOwner> {
  private readonly shutdown = new AbortController();
  private readonly attempts = new Map<string, Attempt<O>>();
  private readonly tasks = new Map<string, Promise<void>>();
  private authority?: Authority<O>;
  private closed = false;
  private failed = false;
  private dirty = false;
  private cursor = 0;
  private wakeTask?: Promise<void>;
  private readonly limit: number;

  constructor(private readonly deps: PendingInputSchedulerDependencies<O>) {
    this.limit = deps.maxConversationsPerPass ?? 32;
    if (!Number.isSafeInteger(this.limit) || this.limit < 1 || this.limit > 256) throw new Error("Scheduler pass bound must be 1..256");
  }

  /** Ephemeral synchronous authority, scoped to ONE store call. Calling this
   * with an old serialized authorization outside that call always refuses. */
  validateLive(input: PendingInputLiveValidation): void {
    const scope = this.authority;
    if (!scope || scope.stage !== input.stage) throw new PendingInputDomainError("scheduler-authority", "No synchronous scheduler authority for this mutation");
    const { attempt, proof } = scope, { identity, selection } = attempt;
    if (!equal(input.identity, identity) || input.chainId !== selection.item.chainId || !equal(input.snapshot, selection.item.snapshot)
      || input.authorization && !equal(input.authorization, proof.authorization)) throw new PendingInputDomainError("scheduler-identity", "Live mutation differs from exact scheduler identity");
    this.checkAuthorization(proof.authorization, input.stage === "settlement" ? "settlement" : "dispatch", selection, identity);
    if (submissionStages.has(input.stage)) this.checkSubmission(attempt, input.stage);
    synchronousDispatchHook(() => proof.validate(input, submissionStages.has(input.stage) ? "submission" : "observation"));
    // Authority is pinned from trusted preflight, not the authorization DTO.
    // A live callback cannot change the queue/identity, revive the predecessor,
    // or stop the installed owner and still authorize this boundary.
    if (submissionStages.has(input.stage)) {
      this.checkAuthorization(proof.authorization, "dispatch", selection, identity);
      this.checkSubmission(attempt, input.stage);
    }
  }

  private checkSubmission(attempt: Attempt<O>, stage: PendingInputLiveValidation["stage"]): void {
    const { identity, selection, lease } = attempt;
    if (this.closed || this.shutdown.signal.aborted) throw new PendingInputDomainError("bridge-closing", "Scheduler is closed");
    const view = this.deps.store.inspect(identity.source.sessionId);
    if (view.recoveryRequired || view.chain?.chainId !== selection.item.chainId
      || this.predecessorRunId(view, selection.predecessor) !== selection.predecessorRunId
      || stage === "claim" && !this.current(selection)) throw new PendingInputDomainError("pending-input-stale", "Original predecessor or queue selection changed");
    // Publication legitimately replaces the selected predecessor, but every
    // submission boundary must still hold the SAME current lifecycle handle.
    if (this.deps.predecessor(identity.source.sessionId) !== (attempt.lifecycle ?? selection.predecessor)) throw new PendingInputDomainError("pending-input-stale", "Current lifecycle handle changed");
    const predecessor = selection.predecessor?.owner;
    // Stop requests and completed termination promises are sticky history.
    // Only explicit live resume may bypass them, never unsettled/owned work,
    // an in-flight cancellation (cleared by the service), or reconciliation.
    if (predecessor && (attempt.proof.basis === "user-resume"
      ? !predecessor.settled || predecessor.cancelling || this.deps.coordinator.owns(predecessor) || this.deps.coordinator.hasReconciliation(identity.source.sessionId)
      : predecessor.cancelling || predecessor.stopRequested || predecessor.stopping || this.deps.coordinator.owns(predecessor))) throw new PendingInputDomainError("conversation-busy", "Predecessor release/cancellation is not proven");
    const owner = this.deps.coordinator.getOwner(identity.source.sessionId);
    if (this.deps.coordinator.hasReconciliation(identity.source.sessionId)) throw new PendingInputDomainError("conversation-busy", "Conversation reconciliation is outstanding");
    if (!owner && !this.deps.coordinator.holdsAdmission(lease, identity.source.sessionId)) throw new PendingInputDomainError("admission-stale", "Exact scheduler lease is no longer held");
    if (owner && (owner !== attempt.lifecycle?.owner || !this.sameOwner(identity, owner))) throw new PendingInputDomainError("scheduler-owner", "A different owner occupies this conversation");
    if (stage === "before-native" && (!attempt.lifecycle || owner !== attempt.lifecycle.owner)) throw new PendingInputDomainError("scheduler-owner", "Native boundary requires the published exact installed owner");
    if (owner && (owner.stopRequested || owner.cancelling || owner.stopping || owner.settled || owner.run.status !== "running"))
      throw new PendingInputDomainError("conversation-busy", "Installed owner is stopped, cancelling or no longer running");
    // Prior to installation, inspect the SAME intent and lease. Afterwards
    // ownership itself is expected; live bridge validation checks install pins.
    if (!owner) {
      const ready = this.deps.coordinator.inspectReadiness({ conversationId: identity.source.sessionId, intent: { kind: "user-prompt", requestId: identity.requestId }, phase: "dispatch", lease });
      if (!ready.ready) throw new PendingInputDomainError(ready.code, ready.reason);
    }
  }

  private checkAuthorization(auth: PendingInputAuthorization, kind: "dispatch" | "settlement", selection: CapturedSelection<O>, identity?: DispatchIdentity) {
    validateAuthorization(auth);
    const predecessor = kind === "settlement" ? identity!.runId : selection.predecessorRunId;
    if (auth.kind !== kind || auth.chainId !== selection.item.chainId || !equal(auth.source, dispatchSource(selection.item.snapshot)) || auth.predecessorRunId !== predecessor)
      throw new PendingInputDomainError("pending-input-authorization", "Live proof is not bound to exact source, chain and predecessor");
  }
  private sameOwner(identity: DispatchIdentity, owner: O) {
    return owner.run.sessionId === identity.source.sessionId && owner.run.runId === identity.runId && owner.run.cwd === identity.source.cwd
      && (owner.run.nativeCommandId ?? null) === identity.nativeCommandId;
  }
  private scoped<T>(attempt: Attempt<O>, stage: Authority<O>["stage"], action: () => T, proof: PendingInputLiveProof = attempt.proof): T {
    if (this.authority) throw new Error("Reentrant scheduler validation scope");
    this.authority = { attempt, stage, proof };
    try { return action(); }
    catch (error) { if (!(error instanceof PendingInputDomainError)) this.fatal(error); throw error; }
    finally { this.authority = undefined; }
  }
  private fatal(error: unknown) {
    if (this.failed) return;
    this.failed = true;
    this.closed = true; this.dirty = false; this.shutdown.abort();
    try { synchronousDispatchHook(() => this.deps.failClosed(error)); } catch { /* closed latch remains */ }
  }
  private handle(error: unknown, conversationId: string) {
    if (error === stopped) return;
    if (error instanceof DispatchProofUnavailableError) return;
    if (error instanceof PendingInputDomainError) {
      if (driftCodes.has(error.code)) this.deps.store.pause(conversationId, { code: error.code === "dispatch-source-mismatch" ? "source-changed" : error.code as PendingInputPause["code"], reason: error.message });
      return;
    }
    this.fatal(error);
  }
  /** Cancellation races ONLY read-only bounded scheduler work. Admission/native
   * execution is supervised separately and is never awaited by close/drain. */
  private async observe<T>(work: Promise<T>): Promise<T> {
    const signal = this.shutdown.signal;
    if (signal.aborted) { void work.catch(() => {}); throw stopped; }
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => { abort = () => reject(stopped); signal.addEventListener("abort", abort, { once: true }); });
    try { return await Promise.race([work, cancelled]); }
    finally { signal.removeEventListener("abort", abort); }
  }
  /** Reading history binds identity only. A live handle cannot contradict this
   * chain's durable binding, and foreign-chain history is never a fallback. */
  private predecessorRunId(view: ReturnType<PendingInputStore["inspect"]>, predecessor: DispatchLifecycle<O> | null): string | null {
    const sameChain = view.chain !== null && view.lastAuthorization?.chainId === view.chain.chainId;
    const runId = predecessor?.owner.run.runId ?? null;
    if (predecessor && sameChain && runId !== view.lastPredecessorRunId)
      throw new PendingInputDomainError("pending-input-authorization", "Live predecessor differs from current-chain durable identity");
    return predecessor ? runId : sameChain ? view.lastPredecessorRunId : null;
  }
  private current(selection: CapturedSelection<O>): boolean {
    const cid = selection.item.request.conversationId, view = this.deps.store.inspect(cid);
    const head = view.snapshot.items.find(i => i.state === "waiting");
    return !this.closed && !view.recoveryRequired && !view.pause && view.snapshot.revision === selection.revision
      && head?.itemId === selection.item.itemId && view.chain?.chainId === selection.item.chainId
      && !view.snapshot.items.some(i => i.state !== "waiting") && this.deps.predecessor(cid) === selection.predecessor
      && this.predecessorRunId(view, selection.predecessor) === selection.predecessorRunId;
  }

  notifyEnqueue(): void { this.wake(); }
  notifyRemove(): void { this.wake(); }
  /** Notification only; bridge/store resume is explicit and cannot clear claims. */
  notifyResume(): void { this.wake(); }
  notifyDomain(): void { this.wake(); }
  notifyCapacity(): void { this.wake(); }
  notifyLifecycle(): void { this.wake(); }
  /** One bounded backstop tick, not permission and not automatic replay. */
  poll(): void { this.wake(); }
  private wake() {
    if (this.closed) return;
    this.dirty = true;
    if (this.wakeTask) return;
    this.wakeTask = Promise.resolve().then(async () => {
      // Coalesce notifications arriving during preflight, but yield after two
      // passes. There is no self-wake merely because a busy head remains.
      for (let pass = 0; pass < 2 && this.dirty && !this.closed; pass++) {
        this.dirty = false;
        const conversations = this.deps.store.readRecords().conversations.filter(c => c.items.some(i => ["waiting", "claimed", "run-linked"].includes(i.state)));
        if (!conversations.length) break;
        const start = this.cursor % conversations.length, count = Math.min(this.limit, conversations.length);
        this.cursor = (start + count) % conversations.length;
        const work: Promise<void>[] = [];
        for (let n = 0; n < count; n++) {
          const cid = conversations[(start + n) % conversations.length]!.conversationId;
          if (this.tasks.has(cid)) continue;
          const task = Promise.resolve().then(() => this.reconsider(cid)).catch(error => {
            try { this.handle(error, cid); } catch (failure) { this.fatal(failure); }
          }).finally(() => { this.tasks.delete(cid); });
          this.tasks.set(cid, task); work.push(task);
        }
        await Promise.all(work);
      }
    }).catch(error => this.fatal(error)).finally(() => {
      this.wakeTask = undefined;
      // A dirty bit beyond the bounded pass is retained until the next external
      // notification/backstop; no reserve/release microtask spin.
    });
  }
  async drain(): Promise<void> { while (this.wakeTask) await this.wakeTask; }
  close(): Promise<void> {
    this.closed = true; this.dirty = false; this.shutdown.abort();
    return this.drain();
  }

  private async reconsider(cid: string) {
    const attempt = this.attempts.get(cid);
    if (attempt) {
      if (attempt.done || attempt.resultFinished && !attempt.lifecycle) await this.finish(attempt);
      // A proven transition may consider ONE new head in the same bounded task.
      // This cannot loop through runs: native completion is never awaited here.
      if (!this.closed && !this.attempts.has(cid)) await this.reconsider(cid);
      return;
    }
    const view = this.deps.store.inspect(cid);
    if (this.closed || view.recoveryRequired || view.pause || view.snapshot.items.some(i => i.state !== "waiting")) return;
    const head = view.snapshot.items.find(i => i.state === "waiting");
    if (!head) return;
    const item = this.deps.store.lookup(cid, head.requestId)!.item;
    const intent = { kind: "user-prompt" as const, requestId: item.requestId };
    if (!this.deps.coordinator.inspectReadiness({ conversationId: cid, intent, phase: "dispatch" }).ready) return;
    const predecessor = this.deps.predecessor(cid);
    const selection: CapturedSelection<O> = Object.freeze({ item, revision: view.snapshot.revision, predecessor,
      predecessorRunId: this.predecessorRunId(view, predecessor) });
    const result = await this.observe(this.deps.preflight(selection, this.shutdown.signal));
    if (!this.current(selection)) return;
    if (result.kind === "pause") { this.deps.store.pause(cid, result.pause); return; }
    if (result.kind === "wait") return;
    const proof: PendingInputDispatchProof = Object.freeze({ ...result.proof, authorization: immutable(structuredClone(result.proof.authorization)) });
    this.checkAuthorization(proof.authorization, "dispatch", selection);
    if (proof.basis === "successful-predecessor" && !selection.predecessor
      || proof.basis === "new-idle-chain" && (selection.predecessor || selection.predecessorRunId !== null)
      || !["successful-predecessor", "new-idle-chain", "user-resume"].includes(proof.basis))
      throw new PendingInputDomainError("pending-input-authorization", "An explicit live idle-chain/resume or successful predecessor capability is required");
    // Reobserve success AFTER other async preflight; cancellation/source drift
    // during that await cannot reuse a formerly healthy predecessor proof.
    if (selection.predecessor && proof.basis === "successful-predecessor") {
      const owner = selection.predecessor.owner;
      if (owner.stopRequested || owner.cancelling || owner.stopping || owner.run.status === "interrupted" || owner.run.status === "failed") {
        this.deps.store.pause(cid, { code: owner.run.status === "failed" ? "failed" : "stopped", reason: "Predecessor failed/stopped; live user resume is required" }); return;
      }
      const success = await this.observe(selection.predecessor.successfulSettlement());
      if (!this.current(selection)) return;
      if (!success.ready) {
        if (success.code === "dispatch-stopped" || success.code === "dispatch-unsuccessful") this.deps.store.pause(cid, { code: success.code === "dispatch-stopped" ? "stopped" : "failed", reason: success.reason });
        else if (success.code === "dispatch-source-mismatch") this.deps.store.pause(cid, { code: "source-changed", reason: success.reason });
        return;
      }
    }
    const reservation = this.deps.coordinator.reserveAdmission({ conversationIds: [cid], intent });
    if (!reservation.ready) return;
    const ids = this.deps.allocate(dispatchSource(item.snapshot).harnessId);
    if (!uuid(ids.attemptId)) throw new Error("Scheduler allocator returned an invalid attempt identity");
    const identity: DispatchIdentity = immutable({ source: dispatchSource(item.snapshot), runId: ids.runId, nativeCommandId: ids.nativeCommandId, requestId: item.requestId });
    validateIdentity(identity);
    const owned: Attempt<O> = { selection, identity, lease: reservation.lease, proof, done: false, resultFinished: false };
    try {
      this.scoped(owned, "claim", () => this.deps.store.claim({ conversationId: cid, itemId: item.itemId, inputRequestId: item.requestId, expectedRevision: selection.revision, ...ids, authorization: proof.authorization }));
    } catch (error) {
      // A storage/invariant failure might have committed on disk; retain lease.
      if (error instanceof PendingInputDomainError) this.deps.coordinator.releaseAdmission(reservation.lease);
      throw error;
    }
    this.attempts.set(cid, owned);
    const context: PreparedAdmissionContext = Object.freeze({ intent: Object.freeze(intent), origin: "queued-user", runId: identity.runId,
      ...(identity.nativeCommandId ? { nativeCommandId: identity.nativeCommandId } : {}),
      delivery: identity.source.harnessId === "opencode" ? "native-queued-handoff" : "idle-only",
      validate: input => { this.assertIdentity(input, identity); this.scoped(owned, "active-claim", () => this.deps.store.validateActiveClaim(identity)); },
      link: input => { this.assertIdentity(input, identity); this.scoped(owned, "link", () => this.deps.store.link(identity)); },
      evidence: Object.freeze({
        beforeNative: (input: DispatchSubmissionEvidence) => { this.assertEvidenceIdentity(input, identity); this.scoped(owned, "before-native", () => this.deps.store.beforeNative(input)); },
        outcome: (input: DispatchSubmissionEvidence) => { this.assertEvidenceIdentity(input, identity); this.scoped(owned, "outcome", () => this.deps.store.outcome(input)); },
      }),
    });
    // Do not await ready, admission, or native completion in bounded drain work.
    // All callbacks stay supervised even after close; no uncertainty is replayed.
    let dispatch: Promise<PreparedAdmissionResult>;
    try { dispatch = this.deps.dispatch(item.snapshot.prepared, reservation.lease, { context, publish: lifecycle => this.publish(owned, lifecycle) }); }
    catch (error) { this.dispatchFinished(owned, error); return; }
    void Promise.resolve(dispatch).then(result => {
      if (!owned.lifecycle || result.lifecycle !== owned.lifecycle || result.sessionId !== cid || result.runId !== identity.runId) throw new Error("Admission did not publish the exact lifecycle before settling");
      this.dispatchFinished(owned);
    }).catch(error => this.dispatchFinished(owned, error)).catch(error => this.fatal(error));
  }
  private assertIdentity(actual: DispatchIdentity, expected: DispatchIdentity) {
    if (!equal(actual, expected)) throw new PendingInputDomainError("scheduler-identity", "Admission identity differs from durable claim");
  }
  private assertEvidenceIdentity(actual: DispatchIdentity, expected: DispatchIdentity) {
    const { source, runId, nativeCommandId, requestId } = actual;
    this.assertIdentity({ source, runId, nativeCommandId, requestId }, expected);
  }
  private publish(attempt: Attempt<O>, lifecycle: DispatchLifecycle<O>) {
    if (attempt.lifecycle || !this.sameOwner(attempt.identity, lifecycle.owner) || !this.deps.coordinator.owns(lifecycle.owner)) throw new Error("Lifecycle publication requires the exact installed owner, once");
    this.assertEvidenceIdentity(lifecycle.submissionEvidence(), attempt.identity);
    attempt.lifecycle = lifecycle;
    void lifecycle.done.then(() => { attempt.done = true; this.notifyLifecycle(); }).catch(error => this.fatal(error));
  }
  private dispatchFinished(attempt: Attempt<O>, error?: unknown) {
    attempt.resultFinished = true;
    try {
      if (error && !(error instanceof PendingInputDomainError) && !(error instanceof DispatchProofUnavailableError)) this.fatal(error);
      // Retain the exact reservation through durable resolution, including
      // ambiguous owner release. Its conversation already counts once alongside
      // the installed owner; this is NOT a second owner or a capacity exemption.
      // Rejected ready/admission must not silently give uncertain native work's
      // slot away. close deliberately preserves such leases/claims.
      if (!attempt.lifecycle) {
        const item = this.deps.store.lookup(attempt.identity.source.sessionId, attempt.selection.item.requestId)!.item;
        if (item.claim?.evidence?.submission !== "not-submitted") {
          if (!item.claim?.evidence) this.scoped(attempt, "outcome", () => this.deps.store.outcome({ ...attempt.identity, submission: "unknown", nativeAcceptance: "unknown" }));
          this.deps.store.pause(attempt.identity.source.sessionId, { code: "acceptance-unknown", reason: "Admission rejected without a published lifecycle or definite non-submission; original claim retained" });
        }
      }
      this.notifyLifecycle();
    } catch (failure) { this.fatal(failure); }
  }
  private async finish(attempt: Attempt<O>) {
    const { identity, selection, lifecycle } = attempt, cid = identity.source.sessionId;
    const item = this.deps.store.lookup(cid, selection.item.requestId)!.item;
    if (!item.claim || !equal(item.claim.identity, identity)) throw new Error("Scheduler unresolved identity changed in durable storage");
    if (item.state === "settled" && item.history) {
      this.deps.coordinator.releaseAdmission(attempt.lease); this.attempts.delete(cid); return;
    }
    if (!["claimed", "run-linked"].includes(item.state)) throw new Error("Scheduler claim reverted without proven resolution");
    if (item.claim?.evidence?.submission === "not-submitted" && !item.claim.possibleNative) {
      this.scoped(attempt, "not-submitted", () => this.deps.store.archiveNotSubmitted(identity, { kind: "definitely-not-submitted", identity }));
      this.deps.coordinator.releaseAdmission(attempt.lease); this.attempts.delete(cid); return;
    }
    if (!lifecycle || !attempt.done) return;
    if (!item.claim?.evidence || ["attempted", "unknown"].includes(item.claim.evidence.submission)) {
      this.deps.store.pause(cid, { code: "acceptance-unknown", reason: "Finished admission has no proven delivery/non-submission; reconcile original identities, never replay" });
      if (item.claim?.evidence?.submission !== "unknown") this.scoped(attempt, "outcome", () => this.deps.store.outcome({ ...identity, submission: "unknown", nativeAcceptance: "unknown" }));
      return;
    }
    // Failure/stop is a safety block, not an independent terminal classification.
    // Preserve any existing pause (including explicit stop's audit text), but
    // still obtain independent settlement proof below while waiters stay paused.
    const stopping = lifecycle.owner.stopRequested || lifecycle.owner.cancelling || lifecycle.owner.stopping || lifecycle.owner.run.status === "interrupted";
    if ((stopping || lifecycle.owner.run.status === "failed") && !this.deps.store.get(cid).paused) {
      if (stopping)
        this.deps.store.pause(cid, { code: "stopped", reason: "Queued run stopped or cancellation remains outstanding" });
      else this.deps.store.pause(cid, { code: "failed", reason: "Queued run failed; waiting text preserved" });
    }
    if (!lifecycle.owner.settled || this.deps.coordinator.owns(lifecycle.owner) || this.deps.coordinator.hasOwner(cid) || this.deps.coordinator.hasReconciliation(cid)) return;
    const success = await this.observe(lifecycle.successfulSettlement());
    if (!success.ready && success.code !== "dispatch-proof-unavailable" && success.code !== "dispatch-unsettled"
      && lifecycle.owner.run.status === "completed") this.deps.store.pause(cid, { code: success.code === "dispatch-source-mismatch" ? "source-changed" : "reconciliation-required", reason: success.reason });
    const result = await this.observe(this.deps.settlement(selection, lifecycle, this.shutdown.signal));
    if (this.closed) return;
    if (result.kind === "pause") { this.deps.store.pause(cid, result.pause); return; }
    if (result.kind === "wait") return;
    if (result.status === "completed" && !success.ready) {
      if (success.code === "dispatch-source-mismatch") this.deps.store.pause(cid, { code: "source-changed", reason: success.reason });
      return;
    }
    // Async reconciliation cannot settle a replaced owner using stale success.
    if (this.deps.coordinator.hasOwner(cid) || this.deps.coordinator.hasReconciliation(cid) || this.deps.predecessor(cid) !== lifecycle) return;
    if (result.status === "completed" && !(await this.observe(lifecycle.successfulSettlement())).ready) return;
    if (this.closed || this.deps.coordinator.hasOwner(cid) || this.deps.coordinator.hasReconciliation(cid) || this.deps.predecessor(cid) !== lifecycle) return;
    const proof: PendingInputLiveProof = Object.freeze({ ...result.proof, authorization: immutable(structuredClone(result.proof.authorization)) });
    this.checkAuthorization(proof.authorization, "settlement", selection, identity);
    this.scoped(attempt, "settlement", () => this.deps.store.settle(identity, result.status, proof.authorization), proof);
    this.deps.coordinator.releaseAdmission(attempt.lease); this.attempts.delete(cid);
    // A real settlement (not busy reserve/release) permits one reconsideration.
    this.notifyLifecycle();
  }
}
