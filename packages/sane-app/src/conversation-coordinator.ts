import type { RunOwner } from "./run-owner";

/** Domain policy stays in the bridge: these intents do not grant exemptions from
 * worker, handoff, branch, admission, attachment, or repository safety checks. */
export type ConversationOperationIntent = Readonly<{
  kind: "user-prompt" | "compact" | "worker-launch" | "worker-report" | "handoff"
    | "prepare-recipient" | "attach" | "branch" | "branch-recovery"
    | "retry-admission" | "enroll" | "history-refresh" | "recover-run";
  requestId?: string;
}>;
/** Observation only; cannot acquire a lease or install execution ownership. */
export type ConversationReadinessIntent = ConversationOperationIntent | Readonly<{ kind: "inspect-idle" }>;
export type ConversationReadinessPhase = "enqueue" | "admission" | "dispatch";
export type ConversationBlocked = { ready: false; reason: string; code: string };
export type ConversationReadiness = ConversationBlocked | { ready: true; queueAfterRunId?: string };

const leaseBrand: unique symbol = Symbol("conversation-admission");
/** Opaque identity, not a session-ID lock. Even a copied token cannot release a lease. */
export type ConversationAdmissionLease = Readonly<{ [leaseBrand]: true }>;
const reconciliationBrand: unique symbol = Symbol("conversation-reconciliation");
/** Exact identity for source reconciliation, independent of owner release. */
export type ConversationReconciliationToken = Readonly<{ [reconciliationBrand]: true }>;
export type ConversationAdmissionResult = ConversationBlocked | { ready: true; lease: ConversationAdmissionLease; queueAfterRunId?: string };

export type ConversationOwner = {
  run: { sessionId: string; runId: string };
  settled: boolean;
  cancelling?: boolean;
};
export type ConversationReadinessOptions<O extends ConversationOwner = RunOwner> = {
  conversationId?: string;
  intent: ConversationReadinessIntent;
  phase: ConversationReadinessPhase;
  /** Only the current exact lease may ignore its own admission reservation. */
  lease?: ConversationAdmissionLease;
  /** Legacy CC only: reserve the current owner's slot through its settlement.
   * Never used for new waiting work, which must not acquire an admission lease. */
  predecessor?: O;
};
export type ConversationCoordinatorOptions<O extends ConversationOwner = RunOwner> = {
  maxConcurrentRuns: number;
  /** Live session IDs from domain stores, not copies of those stores. Include
   * only active/uncertain execution, never newly queued/waiting input. */
  externalOccupancy?: () => Iterable<string>;
  isClosing?: () => boolean;
  retained?: () => boolean;
  /** Startup classification is not execution completion. Observation adoption
   * deliberately bypasses this gate; ordinary reservations/installations do not. */
  startupReady?: () => boolean;
  /** Explicit observation-only startup proof for an exact already-journaled
   * owner. Must check current storage/source binding and a private startup
   * capability. Never used by readiness, admission leases, or dispatch install. */
  observationAdmission?: (owner: O) => ConversationBlocked | { ready: true };
  /** Synchronous, read-only policy. Return the original reason/code on failure.
   * Called for enqueue too; enqueue skips capacity/ordinary contention, NOT safety.
   * Async native/repository preflight belongs between reservation and install. */
  policy?: (options: Readonly<ConversationReadinessOptions<O>>) => ConversationBlocked | undefined;
  canRetainPredecessor?: (owner: O) => boolean;
  wake?: {
    dispatch: (signal: AbortSignal) => void | Promise<void>;
    onError: (error: unknown) => void;
  };
};

type Admission<O> = {
  conversationIds: Set<string>;
  intent: ConversationOperationIntent;
  predecessor?: O;
};
const blocked = (code: string, reason: string): ConversationBlocked => ({ ready: false, code, reason });
const busy = () => blocked("conversation-busy", "This conversation already has an active run or reconciliation");
const executableIntents = new Set<ConversationOperationIntent["kind"]>([
  "user-prompt", "compact", "worker-launch", "worker-report", "handoff", "branch", "recover-run",
]);

/** In-memory arbitration only: no input queue, persistence, or domain ownership.
 * Every acquisition/extension/installation is synchronous and all-or-nothing.
 * Leases remain valid after installation until their caller's finally releases
 * them; owner release is a separate identity- and lifecycle-guarded operation. */
export class ConversationCoordinator<O extends ConversationOwner = RunOwner> {
  private readonly ownerRegistry = new Map<string, O>();
  private readonly reservations = new Map<string, ConversationAdmissionLease>();
  private readonly leases = new Map<ConversationAdmissionLease, Admission<O>>();
  private readonly reconciling = new Map<string, ConversationReconciliationToken>();
  private readonly reconciliationTokens = new Map<ConversationReconciliationToken, string>();
  private readonly shutdown = new AbortController();
  private closed = false;
  private dirty = false;
  private wakeTask?: Promise<void>;

  constructor(private readonly options: ConversationCoordinatorOptions<O>) {
    if (!Number.isSafeInteger(options.maxConcurrentRuns) || options.maxConcurrentRuns < 1) throw new Error("maxConcurrentRuns must be a positive safe integer");
  }

  getOwner(conversationId: string): O | undefined { return this.ownerRegistry.get(conversationId); }
  hasOwner(conversationId: string): boolean { return this.ownerRegistry.has(conversationId); }
  owns(owner: O): boolean { return this.getOwner(owner.run.sessionId) === owner; }
  owners(): IterableIterator<O> { return this.ownerRegistry.values(); }
  ownerSessionIds(): IterableIterator<string> { return this.ownerRegistry.keys(); }
  hasAdmission(conversationId: string): boolean { return this.reservations.has(conversationId); }
  admissionSessionIds(): IterableIterator<string> { return this.reservations.keys(); }
  hasReconciliation(conversationId: string): boolean { return this.reconciling.has(conversationId); }
  reconciliationSessionIds(): IterableIterator<string> { return this.reconciling.keys(); }
  /** Acquire before any awaited source reconciliation or owner release. Existing
   * owners may acquire during shutdown/failure; new admission remains forbidden. */
  beginReconciliation(owner: O): ConversationReconciliationToken {
    const id = owner.run.sessionId;
    if (!this.owns(owner) || this.hasReconciliation(id)) throw new Error("Reconciliation requires the current owner and no existing barrier");
    const token: ConversationReconciliationToken = Object.freeze({ [reconciliationBrand]: true as const });
    this.reconciling.set(id, token); this.reconciliationTokens.set(token, id);
    return token;
  }
  /** Successful source reconciliation only. On failure, retain the token until
   * App recovery; close/done do not clear it or await retained ownership. */
  endReconciliation(token: ConversationReconciliationToken): boolean {
    const id = this.reconciliationTokens.get(token);
    if (!id || this.reconciling.get(id) !== token) return false;
    this.reconciling.delete(id); this.reconciliationTokens.delete(token);
    this.requestWake();
    return true;
  }
  holdsAdmission(lease: ConversationAdmissionLease, conversationId: string): boolean {
    return this.leases.has(lease) && this.reservations.get(conversationId) === lease;
  }
  leaseConversationIds(lease: ConversationAdmissionLease): readonly string[] {
    return [...(this.leases.get(lease)?.conversationIds ?? [])];
  }
  occupiedConversationIds(): ReadonlySet<string> {
    return new Set([...this.ownerRegistry.keys(), ...this.reservations.keys(), ...this.reconciling.keys(), ...(this.options.externalOccupancy?.() ?? [])]);
  }
  /** Adopt observation of existing execution, NOT permission to execute it.
   * Reconciliation/retained state may block all new work while observation
   * continues. Closing, failed proof, contention and unknown occupancy still
   * fail closed. Default callers have no observation capability. */
  adoptObservedOwner(owner: O): ConversationReadiness {
    if (this.closed || this.options.isClosing?.()) return blocked("bridge-closing", "Bridge is shutting down");
    if (owner.settled || !owner.run.runId || !owner.run.sessionId) return blocked("owner-invalid", "Observation requires an unsettled existing run with an identity");
    if (!this.options.observationAdmission) return blocked("observation-unproven", "Existing execution observation was not authorized");
    const proof = this.options.observationAdmission(owner);
    if (!proof.ready) return proof;
    const id = owner.run.sessionId;
    if (this.hasOwner(id) || this.hasAdmission(id) || this.hasReconciliation(id)) return busy();
    if (![...(this.options.externalOccupancy?.() ?? [])].includes(id)) return blocked("observation-unproven", "Existing execution occupancy is not proven");
    this.ownerRegistry.set(id, owner);
    return { ready: true };
  }

  private unavailable(): ConversationBlocked | undefined {
    if (this.closed || this.options.isClosing?.()) return blocked("bridge-closing", "Bridge is shutting down");
    if (this.options.startupReady?.() === false) return blocked("startup-classifying", "Startup execution classification is incomplete; retry after startup");
    if (this.options.retained?.()) return blocked("reconciliation-required", "App execution ownership is unconfirmed; operator reconciliation required");
  }

  inspectReadiness(options: ConversationReadinessOptions<O>): ConversationReadiness {
    return this.inspect(options, options.conversationId === undefined ? [] : [options.conversationId]);
  }

  private inspect(options: ConversationReadinessOptions<O>, capacityTargets: readonly string[]): ConversationReadiness {
    const unavailable = this.unavailable();
    if (unavailable?.code === "bridge-closing" || unavailable?.code === "startup-classifying") return unavailable;
    const denial = this.options.policy?.(options);
    if (denial) return denial;
    // A domain's more specific storage/reconciliation evidence keeps its exact
    // code/reason; retained ownership is still a mandatory fallback gate.
    if (unavailable) return unavailable;
    const { conversationId, intent, phase, lease, predecessor } = options;
    if (conversationId !== undefined && !conversationId.trim()) return blocked("conversation-invalid", "Conversation ID must be nonempty");
    // Unlike ordinary contention/capacity, unfinished reconciliation is a safety
    // barrier for every phase, including idle inspection and enqueue observation.
    if (conversationId && this.hasReconciliation(conversationId)) return blocked("reconciliation-pending", "Conversation source reconciliation is in progress; wait for it to finish");
    if (lease && (!conversationId || !this.holdsAdmission(lease, conversationId))) return blocked("admission-stale", "Admission reservation is no longer current");
    const admission = lease ? this.leases.get(lease)! : undefined;
    if (admission && (intent.kind !== admission.intent.kind || ("requestId" in intent ? intent.requestId : undefined) !== admission.intent.requestId)) return blocked("admission-intent", "Admission reservation belongs to a different operation");
    if (phase === "enqueue") {
      if (lease || predecessor || !["user-prompt", "handoff", "worker-report"].includes(intent.kind)) return blocked("enqueue-unsupported", "This operation requires admission, not enqueue readiness");
      // A readiness observation consumes no execution slot and installs no state.
      return { ready: true };
    }
    const owner = conversationId ? this.getOwner(conversationId) : undefined;
    if (predecessor) {
      if (phase !== "admission" || lease || intent.kind !== "user-prompt" || owner !== predecessor
        || predecessor.settled || predecessor.cancelling || this.hasAdmission(conversationId!)
        || !this.options.canRetainPredecessor?.(predecessor)) return busy();
      return { ready: true, queueAfterRunId: predecessor.run.runId };
    }
    if (owner || conversationId && this.hasAdmission(conversationId) && !lease) return busy();
    if (intent.kind === "inspect-idle") return { ready: true };
    const occupied = this.occupiedConversationIds();
    const additional = new Set(capacityTargets.filter(id => !occupied.has(id))).size;
    // Continuing an already reserved session adds no slot, even at capacity.
    // No queued-dispatch or delivery flag can exempt a NEW session from capacity.
    if (additional ? occupied.size + additional > this.options.maxConcurrentRuns
      : capacityTargets.length === 0 && occupied.size >= this.options.maxConcurrentRuns) {
      return blocked("capacity", `Bridge capacity reached (${this.options.maxConcurrentRuns} concurrent runs/requests); retry when a slot is free`);
    }
    return { ready: true };
  }

  reserveAdmission(options: {
    conversationIds: readonly string[];
    intent: ConversationOperationIntent;
    predecessor?: O;
  }): ConversationAdmissionResult {
    // Keep the observation-only boundary at runtime as well as in the types.
    if ((options.intent as ConversationReadinessIntent).kind === "inspect-idle") return blocked("admission-intent", "Idle inspection cannot reserve execution capacity");
    const ids = [...new Set(options.conversationIds)];
    if (!ids.length || ids.some(id => !id.trim())) return blocked("conversation-invalid", "At least one nonempty conversation ID is required");
    if (options.predecessor && (ids.length !== 1 || ids[0] !== options.predecessor.run.sessionId)) return blocked("admission-predecessor", "A predecessor reservation must cover only its own conversation");
    const intent = Object.freeze({ ...options.intent });
    let queueAfterRunId: string | undefined;
    for (const conversationId of ids) {
      const decision = this.inspect({ conversationId, intent, phase: "admission", predecessor: options.predecessor }, ids);
      if (!decision.ready) return decision;
      queueAfterRunId = decision.queueAfterRunId;
    }
    const lease: ConversationAdmissionLease = Object.freeze({ [leaseBrand]: true as const });
    this.leases.set(lease, { conversationIds: new Set(ids), intent, predecessor: options.predecessor });
    for (const id of ids) this.reservations.set(id, lease);
    return { ready: true, lease, ...(queueAfterRunId ? { queueAfterRunId } : {}) };
  }

  /** For a branch destination learned after source preflight. Failure preserves
   * the original lease and acquires NONE of the additional conversations. */
  extendAdmission(lease: ConversationAdmissionLease, conversationIds: readonly string[]): ConversationReadiness {
    const admission = this.leases.get(lease);
    if (!admission) return blocked("admission-stale", "Admission reservation is no longer current");
    if (admission.predecessor) return blocked("admission-predecessor", "Predecessor reservations cannot acquire other conversations");
    const additional = [...new Set(conversationIds)].filter(id => !admission.conversationIds.has(id));
    for (const conversationId of additional) {
      const decision = this.inspect({ conversationId, intent: admission.intent, phase: "admission" }, additional);
      if (!decision.ready) return decision;
    }
    const unavailable = this.unavailable();
    if (unavailable) return unavailable;
    for (const id of additional) { admission.conversationIds.add(id); this.reservations.set(id, lease); }
    return { ready: true };
  }

  /** Revalidates policy and the exact lease after awaited preflight. No callback
   * or await separates final arbitration from owner publication. */
  installOwner(lease: ConversationAdmissionLease, owner: O): ConversationReadiness {
    const admission = this.leases.get(lease);
    if (!admission || !this.holdsAdmission(lease, owner.run.sessionId)) return blocked("admission-stale", "Admission reservation is no longer current");
    if (!executableIntents.has(admission.intent.kind)) return blocked("admission-intent", "This reservation does not permit run ownership");
    if (owner.settled || !owner.run.runId) return blocked("owner-invalid", "Only an unsettled run with an identity can acquire ownership");
    const decision = this.inspectReadiness({ conversationId: owner.run.sessionId, intent: admission.intent, phase: "dispatch", lease });
    if (!decision.ready) return decision;
    this.ownerRegistry.set(owner.run.sessionId, owner);
    return { ready: true };
  }

  releaseAdmission(lease: ConversationAdmissionLease): boolean {
    const admission = this.leases.get(lease);
    if (!admission) return false;
    for (const id of admission.conversationIds) if (this.reservations.get(id) === lease) this.reservations.delete(id);
    this.leases.delete(lease);
    this.requestWake();
    return true;
  }

  releaseOwner(owner: O): boolean {
    // Native terminal observation does not release a still-outstanding interrupt.
    if (!this.owns(owner) || !owner.settled || owner.cancelling || this.options.retained?.()) return false;
    this.ownerRegistry.delete(owner.run.sessionId);
    this.requestWake();
    return true;
  }

  /** Coalesce same-turn wakes, but preserve wakes arriving during an awaited
   * pass (or its completion). Domain state changes call this explicitly too. */
  requestWake(): void {
    if (!this.options.wake || this.closed || this.options.isClosing?.()) return;
    this.dirty = true;
    if (this.wakeTask) return;
    this.wakeTask = Promise.resolve().then(async () => {
      while (this.dirty && !this.unavailable()) {
        this.dirty = false;
        try { await this.options.wake!.dispatch(this.shutdown.signal); }
        catch (error) {
          try { this.options.wake!.onError(error); }
          catch { this.closed = true; this.shutdown.abort(); }
        }
      }
    }).finally(() => {
      this.wakeTask = undefined;
      if (this.dirty && !this.unavailable()) this.requestWake();
    });
  }

  /** Wait for wake work only, not native runs or admission callers. */
  async drainWake(): Promise<void> { while (this.wakeTask) await this.wakeTask; }

  /** Closing is synchronous before this drain is returned. The in-flight pass
   * must honor its signal/recheck readiness after awaits; no subsequent pass or
   * owner installation is allowed. Existing owners/leases remain releasable. */
  close(): Promise<void> {
    this.closed = true;
    this.dirty = false;
    this.shutdown.abort();
    return this.drainWake();
  }
}
