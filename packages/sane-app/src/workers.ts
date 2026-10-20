import { isWorkerAgentId, workerJobsProblem, type WorkerAgentId } from "sane-core/agent-catalog";
import type { ConversationRef } from "sane-core/contracts";
import { resolveWorkerProfile, type AgentProfiles } from "./agent-profiles-contract";
import { WorkerStore, workerSelection, type WorkerSelection } from "./worker-store";
import { DEFAULT_MAX_UNFINISHED_EXPLICIT_WORKERS, DEFAULT_MAX_WORKERS_PER_CHECKOUT, workerResults, workerTerminal, type WorkerCaller, type WorkerProtocolPin, type WorkerRecord, type WorkerStart } from "./worker-contract";
import { attentionBoundary, completionBlockedMessage, continuationActive, isExplicitWorker, occupiesExecution, protocolAllows, sameProtocolPin, unfinishedExplicit, userOrParentWaitOpen, validProtocolPin, workerInvocationKey, workerPayloadFingerprint, workerWaitUnsettled, type CompletionBlocker } from "./worker-protocol";
import { WorkstreamAdapterError } from "./workstreams";
import { synchronousDispatchHook } from "./dispatch-evidence";
import { PendingInputStorageError } from "./pending-input-contract";

/** holdsExecution: the parent currently holds its workstream's execution slot. */
export type WorkerParent = { sessionId: string; runId: string; native: ConversationRef; checkout: string; profileId?: string; holdsExecution: boolean; scoutOnly?: boolean; allowedWorkerRoles?: readonly WorkerAgentId[] };
export type WorkerExecutor = {
  parent(caller: WorkerCaller): Promise<WorkerParent>;
  assertCurrentParent(parent: WorkerParent): void;
  hasActiveExecution(worker: WorkerSelection): boolean;
  assertCapacity(): void;
  launch(worker: WorkerRecord): Promise<void>;
  observe(worker: WorkerRecord): Promise<Partial<WorkerRecord>>;
  /** Optional evidence fingerprint for terminal observation caching. Must change for
   * every relevant run/log, continuation-delivery, or recovery/ownership change.
   * Return undefined whenever those dependencies cannot be proven stable.
   * Selection callbacks receive detached scalar metadata, never worker payloads. */
  observationKey?(worker: WorkerSelection): string | undefined;
  cancel(worker: WorkerRecord): Promise<void>;
  /** Synchronous control fence for the entire selected set, before refresh.
   * The returned callback pins cancellation to this attempt's original owners. */
  beforeCancel?(workers: readonly WorkerRecord[]): (worker: WorkerRecord) => Promise<void>;
  suppressCancellation?(sessionId: string): void;
  /** In-memory stop/cancel that may not be on the record yet. Checked synchronously with the completion commit. */
  cancellationCommitted?(worker: WorkerSelection): boolean;
  /** Optional feed publication. Failure must not fail the durable notify receipt. */
  publishAttention?(worker: WorkerRecord, attention: { requestId: string; intent: "informational" | "request"; occurrenceBoundary: string }): void;
};
const error = (code: string, message: string): never => { throw new WorkstreamAdapterError(409, code, message); };
const boundedOperationText = (value: unknown, max = 100000): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\u0000");

/** Public admission failure: only counts and recovery guidance cross the native boundary. */
export class WorkerCapacityError extends WorkstreamAdapterError {
  constructor(readonly activeCount: number, readonly limit: number) {
    super(409, "worker-capacity", `Checkout worker capacity reached (${activeCount}/${limit} active SANE workers). The limit includes scout crews, nested workers and active continuations in this checkout. This request did not admit a worker; other starts in the same batch may have succeeded. Inspect sane_worker_status before retrying only missing assignments when a slot is free. Do not relaunch the batch through native subagents to bypass capacity.`);
  }
}

/** Distinct from the legacy execution slot. Idle explicit assignments count here and nowhere else. */
export class WorkerUnfinishedCapacityError extends WorkstreamAdapterError {
  constructor(readonly unfinishedCount: number, readonly limit: number) {
    super(409, "unfinished-capacity", `Checkout unfinished explicit worker capacity reached (${unfinishedCount}/${limit}). Idle explicit assignments remain until they complete or are cancelled and do not occupy an execution slot. This request did not admit a worker. Inspect sane_worker_status before retrying only a missing assignment when a slot is free. Do not relaunch through native subagents.`);
  }
}

export class WorkerCompletionBlockedError extends WorkstreamAdapterError {
  constructor(readonly blockers: readonly CompletionBlocker[]) {
    super(409, "completion-blocked", completionBlockedMessage(blockers));
  }
}

/** Orchestration records only. Execution, logs and recovery belong to the existing bridge. */
export class WorkerService {
  private launches = new Set<Promise<void>>();
  private observed = new Map<string, { revision: number; key: string }>();
  constructor(readonly store: WorkerStore, private executor: WorkerExecutor, private profiles: () => AgentProfiles, readonly checkoutLimit = DEFAULT_MAX_WORKERS_PER_CHECKOUT, readonly unfinishedExplicitLimit = DEFAULT_MAX_UNFINISHED_EXPLICIT_WORKERS) {}
  active() { return this.store.listMatching(w => !workerTerminal(w) || this.executor.hasActiveExecution(w)); }
  private occupies(worker: WorkerSelection) { return occupiesExecution(worker, this.executor.hasActiveExecution(worker)); }
  /** Execution slots only. Explicit idle workers are excluded. */
  executionCount(checkout: string, exceptSessionId?: string) {
    return this.store.countMatching(worker => worker.checkout === checkout && worker.sessionId !== exceptSessionId && this.occupies(worker));
  }
  executionOccupants() { return this.store.listMatching(worker => this.occupies(worker)); }
  private unfinishedCount(checkout: string, exceptId?: string) {
    return this.store.countMatching(worker => worker.checkout === checkout && worker.id !== exceptId && unfinishedExplicit(worker));
  }
  private terminalObservationKey(w: WorkerSelection) {
    if (!workerTerminal(w) || !w.hasOutcome || w.continuation && !["completed", "failed", "interrupted"].includes(w.continuation.state) || this.executor.hasActiveExecution(w)) return;
    return this.executor.observationKey?.(w);
  }
  private observationCurrent(w: WorkerSelection) {
    const previous = this.observed.get(w.id);
    return previous !== undefined && previous.revision === this.store.revision && previous.key === this.terminalObservationKey(w);
  }
  /** Select before cloning histories. Outbox reconciliation/dispatch remain separate. */
  listForRefresh() { return this.store.listMatching(w => !this.observationCurrent(w)); }
  tree(parentSessionId: string) {
    return this.store.listDescendants(parentSessionId);
  }
  hasBlockingDescendants(parentSessionId: string) { return this.store.hasBlockingDescendants(parentSessionId); }
  async start(caller: WorkerCaller, input: WorkerStart, assertActive: () => void = () => {}) {
    if (!input || !isWorkerAgentId(input.worker) || typeof input.requestId !== "string" || !input.requestId || input.requestId.length > 200 || typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 100000 || input.context !== undefined && (typeof input.context !== "string" || input.context.length > 100000)) error("invalid-worker-input", "Worker role, request ID and bounded prompt/context text required");
    const jobs = workerJobsProblem(input.worker, input.jobs);
    if (jobs) error("invalid-worker-input", jobs);
    const parent = await this.executor.parent(caller);
    const payload: WorkerStart = { requestId: input.requestId, worker: input.worker, prompt: input.prompt, ...(input.context !== undefined ? { context: input.context } : {}), ...(input.jobs !== undefined ? { jobs: [...input.jobs] } : {}) };
    const old = this.store.getByRequest(parent.sessionId, input.requestId);
    if (old) {
      if (JSON.stringify(old.input) !== JSON.stringify(payload) || old.parent.runId !== parent.runId || old.parent.toolCallId !== caller.toolCallId || JSON.stringify(old.parent.invocation?.opencode) !== JSON.stringify(caller.invocation?.opencode)) error("worker-request-conflict", "Request ID already bound to another invocation/payload");
      return old;
    }
    if (parent.scoutOnly && input.worker !== "scout") error("worker-role-denied", "Scout Crew may delegate only App-managed scout workers");
    if (parent.allowedWorkerRoles && !parent.allowedWorkerRoles.includes(input.worker)) error("worker-role-denied", `Pinned parent policy permits only App-managed ${parent.allowedWorkerRoles.join(" or ")} workers`);
    if (input.worker === "implementer" && input.jobs === undefined && parent.holdsExecution) error("invalid-worker-input", "Execution must assign the implementer exactly one job ID.");
    const launch = resolveWorkerProfile(this.profiles(), input.worker, parent.profileId);
    this.executor.assertCapacity();
    // Launch does not pin a protocol. The applicable cap is the execution slot, which idle explicit workers do not fill.
    const activeCount = this.executionCount(parent.checkout);
    if (activeCount >= this.checkoutLimit) throw new WorkerCapacityError(activeCount, this.checkoutLimit);
    const now = new Date().toISOString();
    const w: WorkerRecord = { id: crypto.randomUUID(), sessionId: crypto.randomUUID(), runId: null, parent: { sessionId: parent.sessionId, runId: parent.runId, toolCallId: caller.toolCallId, native: parent.native, ...(caller.invocation ? { invocation: caller.invocation } : {}) }, input: payload, checkout: parent.checkout, launch, child: null, state: "reserved", createdAt: now, updatedAt: now };
    this.executor.assertCurrentParent(parent); // No await between this ownership check and durable reservation.
    assertActive();
    const parentWorker = this.store.getBySession(parent.sessionId);
    if (parentWorker && isExplicitWorker(parentWorker) && parentWorker.assignment && parentWorker.assignment !== "open") error("worker-terminal", "Parent assignment is closing or terminal; no child was admitted");
    this.store.insert(w); // Reserve before any asynchronous creation; retries never launch again. No protocol pin is written.
    const task = this.executor.launch(w).catch(e => { if (!this.store.get(w.id)?.outcome) this.store.update(w.id, { state: "uncertain", error: e instanceof Error ? e.message : "Worker launch unconfirmed" }); });
    this.launches.add(task);
    void task.then(() => this.launches.delete(task), () => {}); // Failed persistence remains visible to shutdown drain.
    return w;
  }
  async drainLaunches() { await Promise.all(this.launches); }
  async refresh(w: WorkerRecord): Promise<WorkerRecord> {
    w = this.store.get(w.id)!;
    if (this.observationCurrent(workerSelection(w))) return w;
    this.observed.delete(w.id);
    const revision = this.store.revision, key = this.terminalObservationKey(workerSelection(w));
    const change = await this.executor.observe(w);
    const latest = this.store.get(w.id)!;
    if (isExplicitWorker(latest)) {
      if (!latest.outcome && !latest.completion && latest.cancelRequestedAt && !change.outcome && change.state !== "uncertain") change.state = "cancelling";
      const changed = (Object.keys(change) as (keyof WorkerRecord)[]).some(key => JSON.stringify(change[key]) !== JSON.stringify(latest[key]));
      if (!changed) {
        if (key !== undefined && revision === this.store.revision && key === this.terminalObservationKey(workerSelection(latest))) this.observed.set(w.id, { revision, key });
        return latest;
      }
      const updated = this.store.publishExplicitObservation(w.id, change);
      return change.outcome && !latest.outcome ? this.refresh(updated) : updated;
    }
    if (!latest.outcome && latest.cancelRequestedAt && !change.outcome && change.state !== "uncertain") change.state = "cancelling";
    if (change.outcome) {
      const results = workerResults(latest), runId = change.outcome.log?.runId ?? latest.runId;
      if (!results.some(r => r.runId === runId)) {
        const revision = results.length + 1;
        change.results = [...results, { revision, runId, outcome: change.outcome, notification: { id: revision === 1 ? `worker-outcome:${w.id}` : `worker-outcome:${w.id}:${runId}`, state: "pending" } }];
      }
      if (latest.outcome) delete change.outcome;
      else change.notification = { id: `worker-outcome:${w.id}`, state: "pending" };
    }
    const changed = (Object.keys(change) as (keyof WorkerRecord)[]).some(key => JSON.stringify(change[key]) !== JSON.stringify(latest[key]));
    if (!changed) {
      // Cache only a no-op observation with unchanged durable AND external evidence.
      // Restoration writes, concurrent notifications and newly discovered results
      // deliberately require another pass; an exception never marks a worker stable.
      if (key !== undefined && revision === this.store.revision && key === this.terminalObservationKey(workerSelection(latest))) this.observed.set(w.id, { revision, key });
      return latest;
    }
    const updated = this.store.update(w.id, change);
    return change.results ? this.refresh(updated) : updated;
  }
  private async scoped(caller: WorkerCaller, ids?: string[]) {
    const p = await this.executor.parent(caller), descendants = new Set(this.store.descendantIds(p.sessionId));
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 256 || ids.some(id => !descendants.has(id)))) error("worker-scope", "Workers must belong to the caller's descendant tree");
    return this.store.listDescendants(p.sessionId, ids);
  }
  async status(caller: WorkerCaller, ids?: string[]) { return Promise.all((await this.scoped(caller, ids)).map(async w => this.present(await this.refresh(w)))); }
  /** Derived child-wait is not persisted, so it cannot clobber a newer parent or user wait. */
  private present(worker: WorkerRecord): WorkerRecord {
    if (!isExplicitWorker(worker) || worker.assignment === "terminal" || userOrParentWaitOpen(worker)) return worker;
    if (this.store.hasMatchingDescendant(worker.sessionId, child => !workerTerminal(child) || continuationActive(child))) return { ...worker, wait: { reason: "children", since: worker.wait?.since ?? worker.updatedAt } };
    return worker;
  }
  async result(caller: WorkerCaller, id: string) { return (await this.status(caller, [id]))[0]!; }
  async wait(caller: WorkerCaller, ids: string[], timeoutSec = 0) {
    if (!Array.isArray(ids) || !ids.length || !Number.isFinite(timeoutSec) || timeoutSec < 0 || timeoutSec > 10) error("worker-wait", "Wait requires IDs and a timeout between 0 and 10 seconds");
    const end = Date.now() + timeoutSec * 1000;
    const pending = (rows: WorkerRecord[]) => rows.some(worker => workerWaitUnsettled(worker, this.executor.hasActiveExecution(workerSelection(worker))));
    let workers = await this.status(caller, ids);
    while (pending(workers) && Date.now() < end) { await Bun.sleep(Math.min(200, end - Date.now())); workers = await this.status(caller, ids); }
    // Deliberately separate acknowledgement from wait: transport loss must not silently consume outcomes.
    // timedOut means a selected worker still has an active native turn, not an unfinished explicit assignment.
    return { workers, timedOut: pending(workers) };
  }
  async acknowledgeWait(caller: WorkerCaller, refs: { workerId: string; revision: number; notificationId: string }[]) {
    if (!Array.isArray(refs) || !refs.length || refs.length > 256 || refs.some(r => !r || typeof r.workerId !== "string" || !Number.isInteger(r.revision) || r.revision < 1 || typeof r.notificationId !== "string")) error("worker-wait", "Exact result revision and notification IDs required");
    const workers = await this.scoped(caller, refs.map(r => r.workerId));
    const recipient = await this.executor.parent(caller);
    if (workers.some(w => w.parent.sessionId !== recipient.sessionId)) error("worker-notification-recipient", "Only the worker's immediate parent may acknowledge its outcome; ancestors may inspect results without consuming notifications");
    return this.store.acknowledgeResults(refs, { runId: caller.runId, toolCallId: caller.toolCallId });
  }
  async cancel(caller: WorkerCaller, ids: string[], includeDescendants = false) {
    if (!Array.isArray(ids) || !ids.length) error("worker-scope", "Explicit worker IDs required");
    let selected = await this.scoped(caller, ids);
    return this.cancelSelected(selected, includeDescendants);
  }
  /** Authenticated App action; no native caller or active parent turn required. */
  async cancelForSession(parentSessionId: string, ids: string[] | "all", includeDescendants = false) {
    const descendants = new Set(this.store.descendantIds(parentSessionId));
    if (ids !== "all" && (!Array.isArray(ids) || !ids.length || ids.length > 256 || ids.some(id => !descendants.has(id)))) error("worker-scope", "Explicit workers must belong to the selected parent session's tree");
    return this.cancelSelected(this.store.listDescendants(parentSessionId, ids === "all" ? undefined : ids), includeDescendants);
  }
  private async cancelSelected(selected: WorkerRecord[], includeDescendants: boolean) {
    if (includeDescendants) selected = [...new Map(selected.flatMap(w => [w, ...this.tree(w.sessionId)]).map(w => [w.id, w])).values()];
    let pinned: ReturnType<NonNullable<WorkerExecutor["beforeCancel"]>> | undefined;
    let returned = false;
    try {
      synchronousDispatchHook(() => { pinned = this.executor.beforeCancel?.(selected); returned = true; return pinned; });
    } catch (error) {
      // Preserve ordinary synchronous read/availability refusals. A returned
      // asynchronous fence, however, cannot establish durable control safety.
      if (returned && !(error instanceof PendingInputStorageError)) throw new PendingInputStorageError("Cancellation control fence must complete synchronously", error);
      throw error;
    }
    const cancel = pinned ?? (w => this.executor.cancel(w));
    // Fence ALL explicit targets before any refresh or native cancellation.
    for (const row of selected) {
      try {
        synchronousDispatchHook(() => this.executor.suppressCancellation ? this.executor.suppressCancellation(row.sessionId) : this.store.suppress(row.sessionId, true));
      } catch (error) {
        throw error instanceof PendingInputStorageError ? error : new PendingInputStorageError("Cancellation suppression storage failed", error);
      }
    }
    return Promise.all(selected.map(async row => {
      let w = await this.refresh(row);
      if (w.outcome) {
        if (!this.executor.hasActiveExecution(workerSelection(w))) return w;
        const requestedAt = new Date().toISOString();
        w = this.store.update(w.id, { state: "cancelling", continuation: w.continuation ? { ...w.continuation, state: "cancelling" } : undefined, continuationCancellation: { requestedAt } });
        try { await cancel(w); } catch (e) { return this.store.update(w.id, { continuationCancellation: { requestedAt, error: e instanceof Error ? e.message : "Continuation cancellation unconfirmed" } }); }
        return w; // Requested only; actual continuation termination remains in its ordinary run log.
      }
      if (isExplicitWorker(w)) {
        const committed = this.store.commitCancellation(w.id);
        if (committed.receiptWins) {
          if (this.executor.hasActiveExecution(workerSelection(committed.worker))) { try { await cancel(committed.worker); } catch { /* Receipt already won; native stop is best-effort and must not replace the outcome. */ } }
          return this.refresh(this.store.get(w.id)!);
        }
        w = committed.worker;
      } else w = this.store.update(w.id, { state: "cancelling", cancelRequestedAt: w.cancelRequestedAt ?? new Date().toISOString() });
      try { await cancel(w); } catch (e) { return this.store.update(w.id, { error: e instanceof Error ? e.message : "Cancellation unconfirmed" }); }
      return this.refresh(this.store.get(w.id)!);
    }));
  }
  /**
   * Later pass calls this only after its admission gate. Current launch does not.
   * Restart and observe must not call it either.
   */
  pinExplicitProtocol(workerId: string, pin: WorkerProtocolPin): WorkerRecord {
    const current = this.store.get(workerId);
    if (!current) return error("worker-scope", "Unknown worker");
    if (!validProtocolPin(pin)) return error("invalid-worker-input", "Explicit protocol pin is incomplete");
    if (current.protocol) {
      if (!sameProtocolPin(current.protocol, pin)) return error("worker-request-conflict", "Protocol pin is already bound");
      return current;
    }
    const unfinished = this.unfinishedCount(current.checkout, current.id);
    if (unfinished >= this.unfinishedExplicitLimit) throw new WorkerUnfinishedCapacityError(unfinished, this.unfinishedExplicitLimit);
    try { return this.store.pinProtocol(workerId, pin); }
    catch (caught) { if (caught instanceof Error && caught.message === "protocol-conflict") return error("worker-request-conflict", "Protocol pin is already bound"); throw caught; }
  }
  async complete(caller: WorkerCaller, input: { outcome: { status: "completed" | "failed" | "interrupted"; summary: string } }, requestId: string) {
    this.assertOperationRequest(requestId);
    if (!input?.outcome || !["completed", "failed", "interrupted"].includes(input.outcome.status) || !boundedOperationText(input.outcome.summary)) return error("invalid-worker-input", "Completion outcome status and bounded summary required");
    const worker = await this.callerWorker(caller);
    const fingerprint = workerPayloadFingerprint({ operation: "complete", outcome: { status: input.outcome.status, summary: input.outcome.summary } });
    const invocationKey = workerInvocationKey(caller);
    const result = this.store.commitCompletion(worker.id, { requestId, fingerprint, invocationKey, outcome: { status: input.outcome.status, summary: input.outcome.summary }, cancelCommitted: this.cancellationCommitted(worker), uncertain: row => this.uncertain(row) });
    if (result.status === "conflict") return error("worker-request-conflict", "Completion request identity is already bound to another invocation or payload");
    if (result.status === "terminal") return error("worker-terminal", "Assignment is already terminal");
    if (result.status === "cancelled") return error("worker-terminal", "Cancellation already committed");
    if (result.status === "unavailable") return error("protocol-unavailable", "Completion is not available on this assignment");
    if (result.status === "blocked") throw new WorkerCompletionBlockedError(result.blockers);
    return { completion: { state: "accepted" as const, revision: result.receipt.receipt.revision } };
  }
  async notify(caller: WorkerCaller, input: { text: string; intent: "informational" | "request" }, requestId: string) {
    this.assertOperationRequest(requestId);
    if (!input || (input.intent !== "informational" && input.intent !== "request") || !boundedOperationText(input.text)) return error("invalid-worker-input", "Notification intent and bounded text required");
    const worker = await this.callerWorker(caller);
    if (!protocolAllows(worker, "notify")) return error("protocol-unavailable", "Notification is not available on this assignment");
    const fingerprint = workerPayloadFingerprint({ operation: "notify", intent: input.intent, text: input.text });
    const invocationKey = workerInvocationKey(caller);
    const boundary = attentionBoundary(worker.sessionId, requestId);
    const now = new Date().toISOString();
    const result = this.store.commitAttention(worker.id, { requestId, intent: input.intent, fingerprint, invocationKey, occurrenceBoundary: boundary, at: now }, input.intent === "request" ? { reason: "user", correlationId: requestId, since: now } : undefined);
    if (result.status === "conflict") return error("worker-request-conflict", "Notification request identity is already bound to another invocation or payload");
    if (result.status === "terminal") return error("worker-terminal", "Assignment is already terminal");
    if (result.status === "wait-conflict") return error("wait-conflict", "A user or parent wait is already open");
    if (result.status === "unavailable") return error("protocol-unavailable", "Notification is not available on this assignment");
    try { this.executor.publishAttention?.(result.worker, { requestId, intent: input.intent, occurrenceBoundary: boundary }); } catch { /* Attention identity is durable; feed publication is best-effort. */ }
    return { attention: { state: "accepted" as const, revision: 1, occurrenceId: boundary } };
  }
  async messageParent(caller: WorkerCaller, input: { text: string; awaitReply: boolean }, requestId: string) {
    this.assertOperationRequest(requestId);
    if (!input || typeof input.awaitReply !== "boolean" || !boundedOperationText(input.text)) return error("invalid-worker-input", "Parent message requires bounded text and an explicit awaitReply flag");
    const worker = await this.callerWorker(caller);
    if (!protocolAllows(worker, "message-parent")) return error("protocol-unavailable", "Parent consultation is not available on this assignment");
    if (!worker.child) return error("protocol-unavailable", "Worker native identity is not recorded; the consultation was not sent");
    const parent = worker.parent;
    const fingerprint = workerPayloadFingerprint({ operation: "message-parent", awaitReply: input.awaitReply, text: input.text });
    const invocationKey = workerInvocationKey(caller);
    const correlationId = input.awaitReply ? crypto.randomUUID() : `notice:${requestId}`;
    const exchange = this.exchangeDraft({ requestId, fingerprint, invocationKey, direction: "child-to-parent", kind: input.awaitReply ? "consultation" : "notice", correlationId, sender: { sessionId: worker.sessionId, native: worker.child }, recipient: { sessionId: parent.sessionId, native: parent.native }, text: input.text });
    const result = this.store.commitExchange(worker.id, exchange, input.awaitReply ? { reason: "parent", correlationId, since: new Date().toISOString() } : undefined);
    return this.exchangeResult(result);
  }
  async messageChild(caller: WorkerCaller, input: { workerId: string; text: string }, requestId: string) {
    this.assertOperationRequest(requestId);
    if (!input || typeof input.workerId !== "string" || !boundedOperationText(input.text)) return error("invalid-worker-input", "Child guidance requires a worker id and bounded text");
    const callerSession = await this.executor.parent(caller);
    const child = this.store.get(input.workerId);
    if (!child || child.parent.sessionId !== callerSession.sessionId || !isExplicitWorker(child) || !child.child) return error("worker-relationship", "Guidance requires an explicit direct child of the caller");
    const fingerprint = workerPayloadFingerprint({ operation: "message-child", workerId: child.id, text: input.text });
    const invocationKey = workerInvocationKey(caller);
    const correlationId = child.wait?.reason === "parent" && child.wait.correlationId ? child.wait.correlationId : `guidance:${requestId}`;
    const exchange = this.exchangeDraft({ requestId, fingerprint, invocationKey, direction: "parent-to-child", kind: "guidance", correlationId, sender: { sessionId: callerSession.sessionId, native: callerSession.native }, recipient: { sessionId: child.sessionId, native: child.child }, text: input.text });
    const result = this.store.commitExchange(child.id, exchange, undefined, child.wait?.reason === "parent" ? child.wait.correlationId : undefined);
    return this.exchangeResult(result);
  }
  private exchangeDraft(input: Omit<import("./worker-contract").WorkerExchange, "id" | "sequence" | "protocol" | "delivery" | "createdAt">): import("./worker-contract").WorkerExchange {
    return { ...input, id: crypto.randomUUID(), sequence: 1, protocol: "explicit-v1", delivery: { state: "queued" }, createdAt: new Date().toISOString() };
  }
  private exchangeResult(result: ReturnType<WorkerStore["commitExchange"]>) {
    if (result.status === "conflict") return error("worker-request-conflict", "Message request identity is already bound to another invocation or payload");
    if (result.status === "terminal") return error("worker-terminal", "Assignment is already terminal");
    if (result.status === "wait-conflict") return error("wait-conflict", "A user or parent wait is already open");
    if (result.status === "relationship") return error("worker-relationship", "Messaging requires the recorded immediate parent and an explicit direct child");
    if (result.status === "unavailable") return error("protocol-unavailable", "This message operation is not available on the assignment");
    return { exchange: { id: result.exchange.id, state: "accepted" as const, revision: 1, correlationId: result.exchange.correlationId } };
  }
  private async callerWorker(caller: WorkerCaller) {
    const callerSession = await this.executor.parent(caller);
    const worker = this.store.getBySession(callerSession.sessionId);
    if (!worker || !isExplicitWorker(worker)) return error("protocol-unavailable", "Caller is not an explicit App-managed worker assignment");
    return worker;
  }
  private cancellationCommitted(worker: WorkerRecord) {
    return !!worker.cancelRequestedAt || worker.state === "cancelling" || !!this.executor.cancellationCommitted?.(workerSelection(worker));
  }
  private uncertain(worker: WorkerRecord) {
    return worker.state === "uncertain" || !!worker.continuation && worker.continuation.state === "uncertain";
  }
  private assertOperationRequest(requestId: string) {
    if (typeof requestId !== "string" || !requestId || requestId.length > 200 || /[\u0000-\u001f\u007f]/.test(requestId)) error("invalid-worker-input", "Worker request ID required");
  }
  async cancelAll(caller: WorkerCaller, scope: { parentSessionId: string }) {
    const p = await this.executor.parent(caller);
    if (scope?.parentSessionId !== p.sessionId) error("worker-scope", "Explicit cancel-all scope must equal the caller's App session");
    return this.cancelForSession(p.sessionId, "all");
  }
}
