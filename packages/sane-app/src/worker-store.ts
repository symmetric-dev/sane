import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicAppRecord } from "./app-store";
import { uuid } from "./history";
import { isWorkerAgentId, workerJobsProblem, workerSubjectProblem } from "sane-core/agent-catalog";
import type { SessionListDelivery, SessionListWorker, WorkerAttention, WorkerCompletion, WorkerExchange, WorkerOperationReceipt, WorkerProtocolPin, WorkerRecord, WorkerRecords, WorkerDelivery, WorkerWait } from "./worker-contract";
import { workerResults } from "./worker-contract";
import { completionBlockers, sameProtocolPin, validProtocolPin, workerBlocksParentGate, type CompletionBlocker } from "./worker-protocol";

/** Detached scalar selection metadata, never a truncated WorkerRecord. */
export type WorkerSelection = Pick<WorkerRecord, "id" | "sessionId" | "runId" | "checkout" | "state" | "assignment" | "cancelRequestedAt"> & {
  parent: Pick<WorkerRecord["parent"], "sessionId">;
  protocol?: Pick<WorkerProtocolPin, "id">;
  continuation?: Pick<NonNullable<WorkerRecord["continuation"]>, "runId" | "state">;
  hasOutcome: boolean;
  /** Any historical result may still need restoration of legacy truncated output. */
  requiresLegacyOutputObservation: boolean;
};
export function workerSelection(worker: WorkerRecord): WorkerSelection {
  return {
    id: worker.id, sessionId: worker.sessionId, runId: worker.runId, checkout: worker.checkout,
    state: worker.state, assignment: worker.assignment, cancelRequestedAt: worker.cancelRequestedAt,
    parent: { sessionId: worker.parent.sessionId }, hasOutcome: !!worker.outcome,
    ...(worker.protocol ? { protocol: { id: worker.protocol.id } } : {}),
    ...(worker.continuation ? { continuation: { runId: worker.continuation.runId, state: worker.continuation.state } } : {}),
    requiresLegacyOutputObservation: workerResults(worker).some(result => result.outcome.summary.length === 4000),
  };
}

const PROTOCOL_OPS = ["complete", "notify", "message-parent", "message-child"];
const EXCHANGE_STATES = ["queued", "claimed", "acceptance-unknown", "accepted", "not-submitted"];
const CLOSED_EXCHANGE_RECIPIENT = "Recipient assignment is no longer open; the exchange remains queued";
function descendants(workers: WorkerRecord[], sessionId: string) {
  const parents = new Set([sessionId]), result: WorkerRecord[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const worker of workers) if (parents.has(worker.parent.sessionId) && !parents.has(worker.sessionId)) { parents.add(worker.sessionId); result.push(worker); changed = true; }
  }
  return result;
}
function bounded(value: unknown, max = 100000): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim().length > 0 && !value.includes("\u0000");
}
function party(value: WorkerExchange["sender"] | undefined) {
  return !!value && uuid(value.sessionId) && !!value.native?.nativeId && !!value.native.authorityId && ["cc", "oc"].includes(value.native.harness);
}
function validWorkerProtocol(worker: WorkerRecord) {
  const explicit = worker.protocol?.id === "explicit-v1";
  if (worker.state === "idle" && !explicit) return false;
  if (!explicit) return worker.protocol === undefined && worker.assignment === undefined && worker.wait === undefined && worker.completion === undefined && worker.settlement === undefined && worker.exchanges === undefined && worker.operationReceipts === undefined && worker.attention === undefined;
  if (!worker.protocol || !validProtocolPin(worker.protocol) || worker.protocol.operations.some(operation => !PROTOCOL_OPS.includes(operation))) return false;
  if (worker.assignment !== undefined && !["open", "closing", "terminal"].includes(worker.assignment)) return false;
  if (worker.assignment === "closing" && !worker.completion) return false;
  if (worker.state === "idle" && (worker.assignment === "closing" || worker.assignment === "terminal" || worker.outcome)) return false;
  if (worker.wait && (!["none", "parent", "user", "children"].includes(worker.wait.reason) || !Number.isFinite(Date.parse(worker.wait.since)) || worker.wait.correlationId !== undefined && !bounded(worker.wait.correlationId, 200))) return false;
  if (worker.completion && (!bounded(worker.completion.requestId, 200) || !bounded(worker.completion.fingerprint, 128) || !bounded(worker.completion.invocationKey, 8000) || !["completed", "failed", "interrupted"].includes(worker.completion.outcome.status) || !bounded(worker.completion.outcome.summary) || !uuid(worker.completion.receipt.id) || worker.completion.receipt.state !== "accepted" || worker.completion.receipt.revision !== 1)) return false;
  if (worker.settlement && (!bounded(worker.settlement.status, 64) || !Number.isFinite(Date.parse(worker.settlement.at)) || !bounded(worker.settlement.summary, 4000))) return false;
  if (worker.usageRecovery && (!uuid(worker.usageRecovery.runId) || !uuid(worker.usageRecovery.throughRunId) || !Number.isSafeInteger(worker.usageRecovery.throughRevision) || worker.usageRecovery.throughRevision < 1 || !Number.isFinite(Date.parse(worker.usageRecovery.at)) || !worker.results?.some(result => result.revision <= worker.usageRecovery!.throughRevision && result.runId === worker.usageRecovery!.runId && result.outcome.status === "failed") || !worker.results.some(result => result.revision === worker.usageRecovery!.throughRevision))) return false;
  if (worker.stopRecovery && (worker.usageRecovery || !uuid(worker.stopRecovery.runId) || !uuid(worker.stopRecovery.throughRunId) || !Number.isSafeInteger(worker.stopRecovery.throughRevision) || worker.stopRecovery.throughRevision < 1 || !Number.isFinite(Date.parse(worker.stopRecovery.at)) || !worker.results?.some(result => result.revision <= worker.stopRecovery!.throughRevision && result.runId === worker.stopRecovery!.runId && result.outcome.status === "interrupted") || !worker.results.some(result => result.revision === worker.stopRecovery!.throughRevision))) return false;
  const requests = new Set<string>(), exchangeIds = new Set<string>();
  for (const receipt of worker.operationReceipts ?? []) {
    if (requests.has(receipt.requestId) || !bounded(receipt.requestId, 200) || !PROTOCOL_OPS.includes(receipt.operation) || !bounded(receipt.fingerprint, 128) || !bounded(receipt.invocationKey, 8000) || !uuid(receipt.receipt.id) || receipt.receipt.state !== "accepted" || receipt.receipt.revision !== 1) return false;
    requests.add(receipt.requestId);
  }
  for (const attention of worker.attention ?? []) if (!bounded(attention.requestId, 200) || !["informational", "request"].includes(attention.intent) || !attention.occurrenceBoundary.startsWith("worker-attention:")) return false;
  for (const [index, exchange] of (worker.exchanges ?? []).entries()) {
    if (!uuid(exchange.id) || exchangeIds.has(exchange.id) || !bounded(exchange.requestId, 200) || exchange.sequence !== index + 1 || exchange.protocol !== "explicit-v1" || !["child-to-parent", "parent-to-child"].includes(exchange.direction) || !["consultation", "guidance", "notice"].includes(exchange.kind) || !bounded(exchange.correlationId, 200) || !bounded(exchange.text) || !party(exchange.sender) || !party(exchange.recipient) || !EXCHANGE_STATES.includes(exchange.delivery.state)) return false;
    if (exchange.delivery.runId !== undefined && !uuid(exchange.delivery.runId)) return false;
    exchangeIds.add(exchange.id);
  }
  return true;
}

/** Persistence may have reached rename before failing; do not treat this as a worker observation failure. */
export class WorkerStorageError extends Error {
  constructor(cause: unknown) { super("Worker record persistence failed", { cause }); }
}

/** Synchronous publication makes reservations and consumption atomic within the App owner. */
export class WorkerStore {
  private records: WorkerRecords;
  private workersById = new Map<string, WorkerRecord>();
  private workersBySession = new Map<string, WorkerRecord>();
  private workersByRequest = new Map<string, WorkerRecord>();
  private workersByRun = new Map<string, WorkerRecord>();
  private workersByExecutionRun = new Map<string, WorkerRecord>();
  private childrenByParent = new Map<string, WorkerRecord[]>();
  private workerPositions = new Map<string, number>();
  private exchangesById = new Map<string, WorkerExchange>();
  private deliveriesByParent = new Map<string, WorkerDelivery[]>();
  private activeDeliveries: WorkerDelivery[] = [];
  private activeDeliveryParents = new Set<string>();
  private activeExchangeRecipients = new Set<string>();
  private generation = 0;
  constructor(private dataDir: string) {
    const path = join(dataDir, "workers.json");
    this.records = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { version: 1, workers: [], suppressedParents: [] };
    this.normalize(this.records);
    this.validate(this.records);
    this.indexWorkers();
    this.indexDeliveries();
    this.indexExchanges();
  }
  private indexWorkers() {
    this.workersById.clear(); this.workersBySession.clear(); this.workersByRequest.clear();
    this.workersByRun.clear(); this.workersByExecutionRun.clear(); this.childrenByParent.clear();
    this.workerPositions.clear(); this.exchangesById.clear();
    for (const [position, worker] of this.records.workers.entries()) {
      this.workersById.set(worker.id, worker); this.workersBySession.set(worker.sessionId, worker);
      this.workersByRequest.set(JSON.stringify([worker.parent.sessionId, worker.input.requestId]), worker);
      this.workerPositions.set(worker.id, position);
      const children = this.childrenByParent.get(worker.parent.sessionId) ?? [];
      children.push(worker); this.childrenByParent.set(worker.parent.sessionId, children);
      if (worker.runId && !this.workersByRun.has(worker.runId)) this.workersByRun.set(worker.runId, worker);
      const executionRuns = [worker.runId, worker.continuation?.runId, ...(worker.exchanges ?? []).map(exchange => exchange.delivery.runId)];
      for (const runId of executionRuns) if (typeof runId === "string" && !this.workersByExecutionRun.has(runId)) this.workersByExecutionRun.set(runId, worker);
      for (const exchange of worker.exchanges ?? []) if (!this.exchangesById.has(exchange.id)) this.exchangesById.set(exchange.id, exchange);
    }
  }
  /** Match the old repeated store-order scan, including children recorded before
   * their parents. Each backwards edge moves discovery to the following pass. */
  private descendantRecords(rootSessionId: string): WorkerRecord[] {
    const seen = new Set([rootSessionId]);
    const queue = [{ sessionId: rootSessionId, pass: 0, position: -1 }];
    const found: { worker: WorkerRecord; pass: number; position: number }[] = [];
    for (let i = 0; i < queue.length; i++) {
      const parent = queue[i]!;
      for (const worker of this.childrenByParent.get(parent.sessionId) ?? []) {
        if (seen.has(worker.sessionId)) continue;
        seen.add(worker.sessionId);
        const position = this.workerPositions.get(worker.id)!;
        const pass = parent.pass + (position < parent.position ? 1 : 0);
        found.push({ worker, pass, position }); queue.push({ sessionId: worker.sessionId, pass, position });
      }
    }
    return found.sort((a, b) => a.pass - b.pass || a.position - b.position).map(row => row.worker);
  }
  private indexDeliveries() {
    this.deliveriesByParent.clear();
    this.activeDeliveries = [];
    this.activeDeliveryParents.clear();
    for (const delivery of this.records.deliveries ?? []) {
      const rows = this.deliveriesByParent.get(delivery.parentSessionId) ?? [];
      rows.push(delivery); this.deliveriesByParent.set(delivery.parentSessionId, rows);
      if (delivery.state === "claimed" || delivery.state === "acceptance-unknown") { this.activeDeliveries.push(delivery); this.activeDeliveryParents.add(delivery.parentSessionId); }
    }
  }
  private indexExchanges() {
    this.activeExchangeRecipients.clear();
    for (const worker of this.records.workers) for (const exchange of worker.exchanges ?? []) {
      if (exchange.delivery.state === "claimed" || exchange.delivery.state === "acceptance-unknown") this.activeExchangeRecipients.add(exchange.recipient.sessionId);
    }
  }
  /** In-memory invalidation only; restart always requires fresh observation. */
  get revision() { return this.generation; }
  /** Additive v1 migration: original outcome/notification IDs and delivery snapshots stay intact. */
  private normalize(r: WorkerRecords) {
    for (const w of r.workers ?? []) {
      if (!w.results?.length && w.outcome && w.notification) w.results = [{ revision: 1, runId: w.outcome.log?.runId ?? w.runId, outcome: w.outcome, notification: w.notification }];
      w.results ??= [];
      if (w.results.length) w.notification = w.results[0]!.notification;
      w.latestResult = w.results.at(-1);
    }
    for (const d of r.deliveries ?? []) d.resultRefs ??= d.workerIds.map(workerId => {
      const result = r.workers.find(w => w.id === workerId)?.results?.[0];
      return { workerId, revision: 1, notificationId: result?.notification.id ?? "" };
    });
  }
  private validate(r: WorkerRecords) {
    const fail = () => { throw new Error("Corrupt workers.json; operator reconciliation required"); };
    if (!r || r.version !== 1 || !Array.isArray(r.workers) || !Array.isArray(r.suppressedParents) || !r.suppressedParents.every(uuid)) fail();
    const ids = new Set<string>(), sessions = new Set<string>(), requests = new Set<string>();
    for (const w of r.workers) {
      const key = JSON.stringify([w.parent?.sessionId, w.input?.requestId]);
      // Older v1 records predate jobs. Validate assignments when present;
      // WorkerService.start still requires them for new Implementer launches.
      if (!uuid(w.id) || !uuid(w.sessionId) || ids.has(w.id) || sessions.has(w.sessionId) || requests.has(key) || !uuid(w.parent?.sessionId) || !uuid(w.parent?.runId) || !w.parent.toolCallId || !w.parent.native?.nativeId || !w.parent.native.authorityId || !["cc", "oc"].includes(w.parent.native.harness) || !isWorkerAgentId(w.input?.worker) || typeof w.input.prompt !== "string" || !w.input.requestId || w.input.jobs !== undefined && workerJobsProblem(w.input.worker, w.input.jobs) !== undefined || !w.checkout?.startsWith("/") || !w.launch?.agent || !["claude-code", "opencode"].includes(w.launch.harness) || !["reserved", "launching", "running", "waiting", "idle", "uncertain", "cancelling", "completed", "failed", "interrupted"].includes(w.state) || !Number.isFinite(Date.parse(w.createdAt)) || !Number.isFinite(Date.parse(w.updatedAt)) || w.runId !== null && !uuid(w.runId)) fail();
      if (workerSubjectProblem(w.input.subject)) fail();
      if (w.outcome && (!["completed", "failed", "interrupted"].includes(w.outcome.status) || !w.notification?.id)) fail();
      if (w.coordination !== undefined && !(w.coordination === "scouts" && w.input.worker === "scout-crew" || w.coordination === "workers" && (w.input.worker === "implementer" || w.input.worker === "verification-crew"))) fail();
      if (!validWorkerProtocol(w)) fail();
      const runs = new Set<string | null>(), notifications = new Set<string>();
      for (const [index, result] of (w.results ?? []).entries()) {
        if (result.revision !== index + 1 || runs.has(result.runId) || notifications.has(result.notification.id) || !result.notification.id || !["pending", "wait-consumed", "claimed", "acceptance-unknown", "delivered"].includes(result.notification.state) || !["completed", "failed", "interrupted"].includes(result.outcome.status) || result.runId !== null && !uuid(result.runId)) fail();
        runs.add(result.runId); notifications.add(result.notification.id);
      }
      ids.add(w.id); sessions.add(w.sessionId); requests.add(key);
    }
    if (r.deliveries !== undefined && !Array.isArray(r.deliveries)) fail();
    const deliveryIds = new Set<string>(), activeParents = new Set<string>();
    for (const d of r.deliveries ?? []) {
      if (!uuid(d.id) || deliveryIds.has(d.id) || !uuid(d.parentSessionId) || !uuid(d.run?.runId) || d.run.sessionId !== d.parentSessionId || !d.commandId || !d.native?.nativeId || !Array.isArray(d.workerIds) || !d.workerIds.length || d.workerIds.length > 8 || new Set(d.workerIds).size !== d.workerIds.length || !["claimed", "acceptance-unknown", "delivered", "not-submitted"].includes(d.state)) fail();
      if (["claimed", "acceptance-unknown"].includes(d.state)) { if (activeParents.has(d.parentSessionId)) fail(); activeParents.add(d.parentSessionId); }
      if (!d.resultRefs?.length || d.resultRefs.length > 8 || new Set(d.resultRefs.map(ref => ref.notificationId)).size !== d.resultRefs.length) fail();
      for (const ref of d.resultRefs ?? []) { const w = r.workers.find(w => w.id === ref.workerId), result = w?.results?.find(r => r.revision === ref.revision && r.notification.id === ref.notificationId); if (!result || !d.workerIds.includes(ref.workerId) || w?.parent.sessionId !== d.parentSessionId || d.state !== "not-submitted" && (result.notification.deliveryId !== d.id || result.notification.state !== d.state)) fail(); }
      deliveryIds.add(d.id);
    }
    for (const w of r.workers) for (const result of w.results ?? []) if (["claimed", "acceptance-unknown", "delivered"].includes(result.notification.state) && !deliveryIds.has(result.notification.deliveryId!)) fail();
    const activeExchangeRecipients = new Set<string>();
    for (const w of r.workers) for (const exchange of w.exchanges ?? []) {
      if (exchange.delivery.state !== "claimed" && exchange.delivery.state !== "acceptance-unknown") continue;
      if (activeExchangeRecipients.has(exchange.recipient.sessionId)) fail();
      activeExchangeRecipients.add(exchange.recipient.sessionId);
    }
  }
  list() { return structuredClone(this.records.workers); }
  /** Predicates receive detached metadata, never stored records or the backing array. */
  listMatching(matches: (worker: WorkerSelection) => boolean) {
    return structuredClone(this.records.workers.filter(worker => matches(workerSelection(worker))));
  }
  countMatching(matches: (worker: WorkerSelection) => boolean) {
    let count = 0;
    for (const worker of this.records.workers) if (matches(workerSelection(worker))) count++;
    return count;
  }
  /** All direct SANE children, regardless of lifecycle; excludes grandchildren and native subagents. */
  directWorkerCount(sessionId: string): number { return this.childrenByParent.get(sessionId)?.length ?? 0; }
  descendantIds(rootSessionId: string) { return this.descendantRecords(rootSessionId).map(worker => worker.id); }
  listDescendants(rootSessionId: string, ids?: readonly string[]) {
    const selected = ids === undefined ? undefined : new Set(ids);
    return structuredClone(this.descendantRecords(rootSessionId).filter(worker => !selected || selected.has(worker.id)));
  }
  hasMatchingDescendant(rootSessionId: string, matches: (worker: WorkerSelection) => boolean) {
    return this.descendantRecords(rootSessionId).some(worker => matches(workerSelection(worker)));
  }
  hasBlockingDescendants(rootSessionId: string) {
    return this.descendantRecords(rootSessionId).some(workerBlocksParentGate);
  }
  hasDescendant(rootSessionId: string, candidateSessionId: string) {
    if (rootSessionId === candidateSessionId) return false;
    const seen = new Set<string>();
    let worker = this.workersBySession.get(candidateSessionId);
    while (worker && !seen.has(worker.sessionId)) {
      seen.add(worker.sessionId);
      if (worker.parent.sessionId === rootSessionId) return true;
      worker = this.workersBySession.get(worker.parent.sessionId);
    }
    return false;
  }
  sessionListWorkers(): SessionListWorker[] {
    return this.records.workers.map(worker => ({
      id: worker.id, sessionId: worker.sessionId, state: worker.state, assignment: worker.assignment,
      parent: { sessionId: worker.parent.sessionId, runId: worker.parent.runId, toolCallId: worker.parent.toolCallId },
      hasOutcome: !!worker.outcome,
      ...(worker.protocol ? { protocol: { id: worker.protocol.id } } : {}),
      ...(worker.wait ? { wait: { reason: worker.wait.reason } } : {}),
      ...(worker.continuation ? { continuation: { state: worker.continuation.state } } : {}),
    }));
  }
  sessionListDeliveries(): SessionListDelivery[] {
    return (this.records.deliveries ?? []).map(delivery => ({ state: delivery.state, parentSessionId: delivery.parentSessionId }));
  }
  unfinishedSessionIds() { return this.records.workers.filter(worker => !worker.outcome).map(worker => worker.sessionId); }
  outstandingAttention(limit = 64) {
    const result: { workerId: string; workerSessionId: string; parentSessionId: string; requestId: string }[] = [];
    if (!Number.isFinite(limit) || limit <= 0) return result;
    const bound = Math.floor(limit);
    for (const worker of this.records.workers) {
      if (worker.protocol?.id !== "explicit-v1" || worker.wait?.reason !== "user" || !worker.wait.correlationId) continue;
      if (result.length >= bound) break;
      result.push({ workerId: worker.id, workerSessionId: worker.sessionId, parentSessionId: worker.parent.sessionId, requestId: worker.wait.correlationId });
    }
    return result;
  }
  get(id: string) {
    const w = this.workersById.get(id);
    return w ? structuredClone(w) : undefined;
  }
  /** Historical reservation identity, independent of the current parent run or worker state. */
  getByRequest(parentSessionId: string, requestId: string) {
    const w = this.workersByRequest.get(JSON.stringify([parentSessionId, requestId]));
    return w ? structuredClone(w) : undefined;
  }
  getBySession(sessionId: string) {
    const w = this.workersBySession.get(sessionId);
    return w ? structuredClone(w) : undefined;
  }
  hasSession(sessionId: string) { return this.workersBySession.has(sessionId); }
  /** Match only the recorded worker run, not continuation runs or historical result runs. */
  getByRun(runId: string) {
    const w = this.workersByRun.get(runId);
    return w ? structuredClone(w) : undefined;
  }
  hasRun(runId: string) { return this.workersByRun.has(runId); }
  /** Initial run, continuation, or exchange delivery. getByRun remains the initial run only. */
  getByExecutionRun(runId: string) {
    const w = this.workersByExecutionRun.get(runId);
    return w ? structuredClone(w) : undefined;
  }
  hasExecutionRun(runId: string) { return this.workersByExecutionRun.has(runId); }
  hasActiveExchange(sessionId: string) { return this.activeExchangeRecipients.has(sessionId); }
  queuedExchanges(now = Date.now()) {
    return this.records.workers.flatMap(worker => (worker.exchanges ?? []).filter(exchange => {
      if (exchange.delivery.state !== "queued") return false;
      if (exchange.delivery.retryAfter && !(Date.parse(exchange.delivery.retryAfter) <= now)) return false;
      const recipient = this.workersBySession.get(exchange.recipient.sessionId);
      // Publish the ordinary refusal once before parking a terminal assignment.
      // Closing is temporary: keep reconsidering it, and never infer acceptance.
      return recipient?.assignment !== "terminal" || exchange.delivery.error !== CLOSED_EXCHANGE_RECIPIENT;
    }).map(exchange => ({ workerId: worker.id, exchange: structuredClone(exchange) }))).sort((a, b) => a.exchange.createdAt.localeCompare(b.exchange.createdAt) || a.exchange.id.localeCompare(b.exchange.id));
  }
  exchangesToReconcile() {
    return this.records.workers.flatMap(worker => (worker.exchanges ?? []).filter(exchange => exchange.delivery.state === "claimed" || exchange.delivery.state === "acceptance-unknown").map(exchange => ({ workerId: worker.id, exchange: structuredClone(exchange) })));
  }
  /** Preserve store order and complete result histories for exact delivery-revision rendering. */
  listForDelivery(delivery: Pick<WorkerDelivery, "workerIds">) {
    const ids = new Set(delivery.workerIds);
    return structuredClone(this.records.workers.filter(w => ids.has(w.id)));
  }
  private commit(next: WorkerRecords) {
    this.normalize(next); this.validate(next);
    try { atomicAppRecord(this.dataDir, "workers.json", next); }
    catch (error) { throw new WorkerStorageError(error); }
    this.records = next; this.generation++; this.indexWorkers(); this.indexDeliveries(); this.indexExchanges();
  }
  insert(w: WorkerRecord) { this.commit({ ...this.records, workers: [...this.records.workers, structuredClone(w)] }); }
  update(id: string, change: Partial<WorkerRecord>) {
    const next = structuredClone(this.records), w = next.workers.find(w => w.id === id);
    if (!w) throw new Error("Unknown worker");
    Object.assign(w, change, { updatedAt: new Date().toISOString() }); this.commit(next); return structuredClone(w);
  }
  acknowledgeResults(refs: NonNullable<WorkerDelivery["resultRefs"]>, consumedBy: { runId: string; toolCallId: string }) {
    const next = structuredClone(this.records);
    const selected = refs.map(ref => {
      const result = next.workers.find(w => w.id === ref.workerId)?.results?.find(r => r.revision === ref.revision && r.notification.id === ref.notificationId);
      if (!result) throw new Error("Unknown worker result revision/notification");
      return { ref, result };
    });
    let changed = false;
    const receipts = selected.map(({ ref, result }) => {
      if (result.notification.state === "pending") { result.notification = { ...result.notification, state: "wait-consumed", consumedAt: new Date().toISOString(), consumedBy }; changed = true; }
      return { ...ref, state: result.notification.state, acknowledged: result.notification.state === "wait-consumed" };
    });
    if (changed) this.commit(next);
    return receipts;
  }
  suppress(sessionId: string, suppressed: boolean) {
    const ids = new Set(this.records.suppressedParents); suppressed ? ids.add(sessionId) : ids.delete(sessionId);
    this.commit({ ...this.records, suppressedParents: [...ids] });
  }
  suppressed(sessionId: string) { return this.records.suppressedParents.includes(sessionId); }
  deliveries() { return structuredClone(this.records.deliveries ?? []); }
  deliveriesForParent(parentSessionId: string) { return structuredClone(this.deliveriesByParent.get(parentSessionId) ?? []); }
  deliveriesToReconcile() { return structuredClone(this.activeDeliveries); }
  hasActiveDelivery(parentSessionId: string) {
    return this.activeDeliveryParents.has(parentSessionId);
  }
  pendingParents(now = Date.now()) {
    return [...new Set(this.records.workers.filter(w => w.results?.some(r => r.notification.state === "pending" && (!r.notification.retryAfter || Date.parse(r.notification.retryAfter) <= now))).map(w => w.parent.sessionId))];
  }
  pendingProblem(parentSessionId: string, error: string) {
    const next = structuredClone(this.records); let changed = false;
    for (const w of next.workers) for (const r of w.results ?? []) if (w.parent.sessionId === parentSessionId && r.notification.state === "pending" && r.notification.error !== error) { r.notification.error = error; changed = true; }
    if (changed) this.commit(next);
  }
  /** Same synchronous commit path as wait acknowledgement: the first publisher wins. */
  claimDelivery(input: Omit<WorkerDelivery, "workerIds" | "resultRefs" | "state">): WorkerDelivery | undefined {
    if (this.suppressed(input.parentSessionId) || this.hasActiveDelivery(input.parentSessionId)) return;
    const next = structuredClone(this.records), now = Date.now();
    const selected = next.workers.filter(w => w.parent.sessionId === input.parentSessionId).flatMap(w => (w.results ?? []).map(result => ({ w, result }))).filter(({ result: r }) => r.notification.state === "pending" && (!r.notification.retryAfter || Date.parse(r.notification.retryAfter) <= now)).sort((a, b) => a.result.outcome.at.localeCompare(b.result.outcome.at) || a.w.id.localeCompare(b.w.id) || a.result.revision - b.result.revision).slice(0, 8);
    if (!selected.length) return;
    const d: WorkerDelivery = { ...input, workerIds: [...new Set(selected.map(({ w }) => w.id))], resultRefs: selected.map(({ w, result }) => ({ workerId: w.id, revision: result.revision, notificationId: result.notification.id })), state: "claimed" };
    for (const { result } of selected) result.notification = { ...result.notification, state: "claimed", deliveryId: d.id, error: undefined, retryAfter: undefined };
    next.deliveries = [...(next.deliveries ?? []), d]; this.commit(next); return structuredClone(d);
  }
  advanceDelivery(id: string, state: WorkerDelivery["state"], error?: string) {
    const next = structuredClone(this.records), d = next.deliveries?.find(d => d.id === id);
    if (!d) throw new Error("Unknown worker delivery");
    if (d.state === "delivered" || d.state === "not-submitted") return structuredClone(d);
    d.state = state; d.updatedAt = new Date().toISOString(); d.error = error;
    for (const ref of d.resultRefs!) {
      const result = next.workers.find(w => w.id === ref.workerId)!.results!.find(r => r.revision === ref.revision && r.notification.id === ref.notificationId)!;
      result.notification = state === "not-submitted" ? { id: result.notification.id, state: "pending", error, retryAfter: new Date(Date.now() + 30000).toISOString() } : { ...result.notification, state, error };
    }
    this.commit(next); return structuredClone(d);
  }
  /** Later pass only, after its admission gate. Launch must not call this. */
  pinProtocol(id: string, pin: WorkerProtocolPin): WorkerRecord {
    const next = structuredClone(this.records), w = next.workers.find(worker => worker.id === id);
    if (!w) throw new Error("Unknown worker");
    if (w.protocol && !sameProtocolPin(w.protocol, pin)) throw new Error("protocol-conflict");
    if (!w.protocol) { w.protocol = structuredClone(pin); w.assignment ??= "open"; w.updatedAt = new Date().toISOString(); this.commit(next); }
    return structuredClone(w);
  }
  commitCompletion(id: string, input: { requestId: string; fingerprint: string; invocationKey: string; outcome: WorkerCompletion["outcome"]; cancelCommitted: boolean; uncertain: (worker: WorkerRecord) => boolean }): { status: "accepted"; worker: WorkerRecord; receipt: WorkerOperationReceipt } | { status: "conflict" } | { status: "terminal" } | { status: "cancelled" } | { status: "unavailable" } | { status: "blocked"; blockers: CompletionBlocker[] } {
    const next = structuredClone(this.records), w = next.workers.find(worker => worker.id === id);
    if (!w) throw new Error("Unknown worker");
    const existing = (w.operationReceipts ?? []).find(receipt => receipt.requestId === input.requestId);
    if (existing) return existing.fingerprint === input.fingerprint && existing.invocationKey === input.invocationKey && existing.operation === "complete" ? { status: "accepted", worker: structuredClone(w), receipt: structuredClone(existing) } : { status: "conflict" };
    if (!w.protocol || w.protocol.id !== "explicit-v1" || !w.protocol.operations.includes("complete")) return { status: "unavailable" };
    if (w.completion || w.assignment === "closing" || w.assignment === "terminal" || ["completed", "failed", "interrupted"].includes(w.state)) return { status: "terminal" };
    if (input.cancelCommitted || w.cancelRequestedAt || w.state === "cancelling") return { status: "cancelled" };
    const blockers = completionBlockers(w, descendants(next.workers, w.sessionId), input.uncertain);
    if (blockers.length) return { status: "blocked", blockers };
    const now = new Date().toISOString();
    const receipt: WorkerOperationReceipt = { requestId: input.requestId, fingerprint: input.fingerprint, invocationKey: input.invocationKey, operation: "complete", receipt: { id: crypto.randomUUID(), state: "accepted", revision: 1 }, at: now };
    w.completion = { requestId: input.requestId, fingerprint: input.fingerprint, invocationKey: input.invocationKey, at: now, outcome: input.outcome, receipt: receipt.receipt };
    w.assignment = "closing";
    // Receipt acceptance ends idle; "running" holds the assignment for settlement,
    // without reopening its Run or publishing an outcome before observation.
    if (w.state === "idle") w.state = "running";
    w.operationReceipts = [...(w.operationReceipts ?? []), receipt];
    w.updatedAt = now;
    this.commit(next);
    return { status: "accepted", worker: structuredClone(w), receipt };
  }
  commitCancellation(id: string): { worker: WorkerRecord; receiptWins: boolean } {
    const next = structuredClone(this.records), w = next.workers.find(worker => worker.id === id);
    if (!w) throw new Error("Unknown worker");
    if (w.protocol?.id === "explicit-v1" && (w.completion || w.assignment === "terminal")) return { worker: structuredClone(w), receiptWins: !!w.completion };
    if (!w.cancelRequestedAt) w.cancelRequestedAt = new Date().toISOString();
    if (!["completed", "failed", "interrupted"].includes(w.state)) w.state = "cancelling";
    w.updatedAt = new Date().toISOString();
    this.commit(next);
    return { worker: structuredClone(w), receiptWins: false };
  }
  commitAttention(id: string, attention: WorkerAttention, wait?: WorkerWait): { status: "accepted"; worker: WorkerRecord; attention: WorkerAttention } | { status: "conflict" } | { status: "terminal" } | { status: "wait-conflict" } | { status: "unavailable" } {
    const next = structuredClone(this.records), w = next.workers.find(worker => worker.id === id);
    if (!w) throw new Error("Unknown worker");
    const existing = (w.operationReceipts ?? []).find(receipt => receipt.requestId === attention.requestId);
    if (existing) {
      const prior = (w.attention ?? []).find(item => item.requestId === attention.requestId);
      return existing.fingerprint === attention.fingerprint && existing.invocationKey === attention.invocationKey && existing.operation === "notify" && prior ? { status: "accepted", worker: structuredClone(w), attention: structuredClone(prior) } : { status: "conflict" };
    }
    if (!w.protocol || w.protocol.id !== "explicit-v1" || !w.protocol.operations.includes("notify")) return { status: "unavailable" };
    if (w.assignment === "closing" || w.assignment === "terminal") return { status: "terminal" };
    if (wait && (w.wait?.reason === "parent" || w.wait?.reason === "user")) return { status: "wait-conflict" };
    const now = new Date().toISOString();
    const receipt: WorkerOperationReceipt = { requestId: attention.requestId, fingerprint: attention.fingerprint, invocationKey: attention.invocationKey, operation: "notify", receipt: { id: crypto.randomUUID(), state: "accepted", revision: 1 }, at: now };
    w.attention = [...(w.attention ?? []), attention];
    w.operationReceipts = [...(w.operationReceipts ?? []), receipt];
    if (wait) w.wait = wait;
    w.updatedAt = now;
    this.commit(next);
    return { status: "accepted", worker: structuredClone(w), attention };
  }
  /**
   * Accepted user input resolves only the awaiting-user wait captured at acceptance.
   * A parent wait, a newer correlation, notification read, and a non-explicit session are left unchanged.
   */
  resolveAcceptedUserWait(sessionId: string, correlationId: string): WorkerRecord | undefined {
    const current = this.records.workers.find(worker => worker.sessionId === sessionId);
    if (!current || current.protocol?.id !== "explicit-v1" || current.wait?.reason !== "user" || !correlationId || current.wait.correlationId !== correlationId) return;
    const next = structuredClone(this.records), w = next.workers.find(worker => worker.sessionId === sessionId)!;
    const now = new Date().toISOString();
    w.wait = { reason: "none", since: now };
    w.updatedAt = now;
    this.commit(next);
    return structuredClone(w);
  }
  commitExchange(id: string, exchange: WorkerExchange, wait?: WorkerWait, clearWaitCorrelation?: string): { status: "accepted"; worker: WorkerRecord; exchange: WorkerExchange } | { status: "conflict" } | { status: "terminal" } | { status: "wait-conflict" } | { status: "unavailable" } | { status: "relationship" } {
    const next = structuredClone(this.records), w = next.workers.find(worker => worker.id === id);
    if (!w) throw new Error("Unknown worker");
    const existing = (w.exchanges ?? []).find(item => item.requestId === exchange.requestId);
    const receipt = (w.operationReceipts ?? []).find(item => item.requestId === exchange.requestId);
    if (existing || receipt) return existing && receipt?.fingerprint === exchange.fingerprint && receipt.invocationKey === exchange.invocationKey && existing.fingerprint === exchange.fingerprint ? { status: "accepted", worker: structuredClone(w), exchange: structuredClone(existing) } : { status: "conflict" };
    if (w.protocol?.id !== "explicit-v1") return { status: "unavailable" };
    if (exchange.direction === "child-to-parent" && !w.protocol.operations.includes("message-parent")) return { status: "unavailable" };
    if (w.assignment === "closing" || w.assignment === "terminal") return { status: "terminal" };
    if (wait && (w.wait?.reason === "parent" || w.wait?.reason === "user")) return { status: "wait-conflict" };
    if (exchange.direction === "parent-to-child" && w.parent.sessionId !== exchange.sender.sessionId) return { status: "relationship" };
    if (exchange.direction === "child-to-parent" && w.parent.sessionId !== exchange.recipient.sessionId) return { status: "relationship" };
    const now = new Date().toISOString();
    const stored = { ...exchange, sequence: (w.exchanges?.length ?? 0) + 1, createdAt: now };
    w.exchanges = [...(w.exchanges ?? []), stored];
    w.operationReceipts = [...(w.operationReceipts ?? []), { requestId: exchange.requestId, fingerprint: exchange.fingerprint, invocationKey: exchange.invocationKey, operation: exchange.direction === "child-to-parent" ? "message-parent" : "message-child", receipt: { id: stored.id, state: "accepted", revision: 1 }, at: now }];
    if (wait) w.wait = wait;
    else if (clearWaitCorrelation && w.wait?.reason === "parent" && w.wait.correlationId === clearWaitCorrelation) w.wait = { reason: "none", since: now };
    w.updatedAt = now;
    this.commit(next);
    return { status: "accepted", worker: structuredClone(w), exchange: structuredClone(stored) };
  }
  claimExchange(workerId: string, exchangeId: string, delivery: { deliveryId: string; runId: string; commandId: string }): WorkerExchange | undefined {
    if (this.records.workers.some(worker => worker.exchanges?.some(exchange => exchange.id === exchangeId && exchange.delivery.state !== "queued"))) return;
    const next = structuredClone(this.records), w = next.workers.find(worker => worker.id === workerId), exchange = w?.exchanges?.find(item => item.id === exchangeId);
    if (!w || !exchange || exchange.delivery.state !== "queued") return;
    const recipient = next.workers.find(worker => worker.sessionId === exchange.recipient.sessionId);
    if (recipient?.protocol?.id === "explicit-v1" && (recipient.assignment === "closing" || recipient.assignment === "terminal")) return;
    if ([...this.activeExchangeRecipients].includes(exchange.recipient.sessionId) || next.workers.some(worker => worker.exchanges?.some(item => item.recipient.sessionId === exchange.recipient.sessionId && (item.delivery.state === "claimed" || item.delivery.state === "acceptance-unknown")))) return;
    exchange.delivery = { state: "acceptance-unknown", ...delivery };
    w.updatedAt = new Date().toISOString();
    this.commit(next);
    return structuredClone(exchange);
  }
  advanceExchange(exchangeId: string, state: WorkerExchange["delivery"]["state"], error?: string) {
    const next = structuredClone(this.records);
    const located = next.workers.flatMap(worker => (worker.exchanges ?? []).map(exchange => ({ worker, exchange }))).find(item => item.exchange.id === exchangeId);
    if (!located) throw new Error("Unknown worker exchange");
    const { worker, exchange } = located;
    if (exchange.delivery.state === "accepted") return structuredClone(exchange);
    if (state === "not-submitted") exchange.delivery = { state: "queued", error, retryAfter: new Date(Date.now() + 30000).toISOString() };
    else exchange.delivery = { ...exchange.delivery, state, error };
    worker.updatedAt = new Date().toISOString();
    this.commit(next);
    return structuredClone(exchange);
  }
  noteExchange(exchangeId: string, error: string) {
    const current = this.exchangesById.get(exchangeId);
    // No await separates this read from publication. Repeated refusals must not
    // copy the store, change its revision, or write unchanged durable evidence.
    if (!current || current.delivery.error === error) return;
    const next = structuredClone(this.records);
    const located = next.workers.flatMap(worker => (worker.exchanges ?? []).map(exchange => ({ worker, exchange }))).find(item => item.exchange.id === exchangeId);
    if (!located || located.exchange.delivery.error === error) return;
    located.exchange.delivery = { ...located.exchange.delivery, error };
    located.worker.updatedAt = new Date().toISOString();
    this.commit(next);
  }
  /** Offline operator repair only: require installation/data ownership and verified native run identity. */
  recoverUsageFailure(id: string, runId: string): WorkerRecord {
    const next = structuredClone(this.records), w = next.workers.find(worker => worker.id === id);
    const recoveredBoundary = w?.usageRecovery;
    const closureRunId = recoveredBoundary?.throughRunId ?? runId;
    if (!w || w.protocol?.id !== "explicit-v1" || w.assignment !== "terminal" || !["failed", "interrupted"].includes(w.state)
      || w.completion || w.cancelRequestedAt || w.continuationCancellation
      || !w.outcome || w.outcome.log?.runId !== closureRunId
      || recoveredBoundary && (recoveredBoundary.runId !== runId || w.results?.some(result => result.revision > recoveredBoundary.throughRevision && result.runId !== closureRunId))
      || !w.results?.length || w.results.at(-1)?.runId !== closureRunId
      || w.results.some(result => !["delivered", "wait-consumed"].includes(result.notification.state))
      || this.hasActiveExchange(w.sessionId) || this.hasActiveDelivery(w.sessionId)) throw new Error("Worker is not a settled, uncancelled quota-recovery candidate");
    const events = readFileSync(join(this.dataDir, `${runId}.jsonl`), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const lastMessage = events.findLast(event => event.kind === "message")?.data;
    if (events.at(-1)?.kind !== "status" || events.at(-1)?.data?.status !== "failed"
      || lastMessage?.error?.type !== "provider.quota") throw new Error("Original run does not prove a terminal provider.quota failure");
    const metadata = JSON.parse(readFileSync(join(this.dataDir, "metadata.json"), "utf8"));
    const runs = (metadata.runs as import("./history").Run[]).filter(run => run.sessionId === w.sessionId && run.operation !== "compact");
    const failedIndex = runs.findIndex(run => run.runId === runId && run.status === "failed");
    const boundaryIndex = recoveredBoundary ? runs.findIndex(run => run.runId === recoveredBoundary.throughRunId) : runs.length - 1;
    if (failedIndex < 0 || boundaryIndex < failedIndex || runs.slice(failedIndex + 1, boundaryIndex + 1).some(run => run.status !== "interrupted")
      || runs.slice(boundaryIndex + 1).some(run => !["running", "completed"].includes(run.status))) throw new Error("Later worker execution must be inspected before recovery");
    w.usageRecovery = { runId, throughRunId: runs[boundaryIndex]!.runId, throughRevision: w.results.at(-1)!.revision, at: new Date().toISOString() };
    delete w.stopRecovery;
    w.assignment = "open";
    w.state = "idle";
    delete w.outcome;
    delete w.notification;
    delete w.continuation;
    const latestRun = runs.at(-1)!;
    if (latestRun.runId !== w.usageRecovery.throughRunId) {
      w.state = latestRun.status === "running" ? "running" : "idle";
      w.continuation = { runId: latestRun.runId, state: latestRun.status };
    }
    delete w.error;
    w.updatedAt = w.usageRecovery.at;
    // Recovery is not permission to execute old queued guidance automatically.
    next.suppressedParents = [...new Set([...next.suppressedParents, w.sessionId])];
    this.commit(next);
    return structuredClone(w);
  }
  /** Offline operator repair only, under installation/data ownership and after native idle proof. */
  recoverStoppedAssignment(id: string, runId: string, throughRunId: string): WorkerRecord {
    const next = structuredClone(this.records), w = next.workers.find(worker => worker.id === id);
    if (!w || w.protocol?.id !== "explicit-v1" || w.assignment !== "terminal" || w.state !== "interrupted"
      || !w.cancelRequestedAt || w.completion || w.continuationCancellation || !w.outcome || w.outcome.log?.runId !== runId
      || !w.results?.length || w.results.at(-1)?.runId !== runId
      || w.results.some(result => !["delivered", "wait-consumed"].includes(result.notification.state))
      || this.hasActiveExchange(w.sessionId) || this.hasActiveDelivery(w.sessionId)) throw new Error("Worker is not a settled Stop-recovery candidate");
    const metadata = JSON.parse(readFileSync(join(this.dataDir, "metadata.json"), "utf8"));
    const runs = (metadata.runs as import("./history").Run[]).filter(run => run.sessionId === w.sessionId && run.operation !== "compact");
    const index = runs.findIndex(run => run.runId === runId);
    if (index < 0 || runs.at(-1)?.runId !== throughRunId || runs.slice(index).some(run => !["interrupted", "completed"].includes(run.status))) throw new Error("Worker execution changed; inspect later runs before recovery");
    const events = readFileSync(join(this.dataDir, `${runId}.jsonl`), "utf8").trim().split("\n").map(line => JSON.parse(line));
    if (!events.some(event => event.kind === "status" && event.data?.connection === "stopping" && event.data?.reason === "Stop requested; waiting for terminal evidence")
      || events.at(-1)?.kind !== "status" || events.at(-1)?.data?.status !== "interrupted") throw new Error("Original run does not prove a settled Stop");
    w.stopRecovery = { runId, throughRunId, throughRevision: w.results.at(-1)!.revision, at: new Date().toISOString() };
    delete w.usageRecovery;
    delete w.cancelRequestedAt;
    delete w.outcome;
    delete w.notification;
    delete w.continuation;
    delete w.error;
    w.assignment = "open";
    w.state = "idle";
    w.updatedAt = w.stopRecovery.at;
    next.suppressedParents = [...new Set([...next.suppressedParents, w.sessionId])];
    this.commit(next);
    return structuredClone(w);
  }
  /** Publish an outcome once per assignment attempt; preserve recovered historical results. */
  publishExplicitObservation(id: string, change: Partial<WorkerRecord>): WorkerRecord {
    const next = structuredClone(this.records), w = next.workers.find(worker => worker.id === id);
    if (!w) throw new Error("Unknown worker");
    if (w.protocol?.id !== "explicit-v1") throw new Error("Explicit observation requires an explicit protocol pin");
    // An observation begun before admission must not republish a superseded closure.
    const recovery = w.usageRecovery ?? w.stopRecovery;
    if (recovery && change.outcome?.log && [recovery.runId, recovery.throughRunId].includes(change.outcome.log.runId)
      && !w.completion && !w.cancelRequestedAt) return structuredClone(w);
    if (change.state) w.state = change.state;
    if (change.error !== undefined) w.error = change.error;
    if (change.continuation) w.continuation = change.continuation;
    if (change.assignment && w.assignment !== "terminal") w.assignment = change.assignment;
    if (change.settlement && !w.settlement) w.settlement = change.settlement;
    if (change.outcome && !w.outcome && !(w.results ?? []).some(result => result.revision > (recovery?.throughRevision ?? 0))) {
      const runId = change.outcome.log?.runId ?? w.runId;
      const revision = (w.results?.length ?? 0) + 1;
      const notification = { id: revision === 1 ? `worker-outcome:${w.id}` : `worker-outcome:${w.id}:${runId}`, state: "pending" as const };
      w.outcome = change.outcome;
      w.notification = notification;
      w.results = [...(w.results ?? []), { revision, runId, outcome: change.outcome, notification }];
      w.assignment = "terminal";
      w.state = change.outcome.status;
    } else if (w.outcome && w.assignment !== "terminal") w.assignment = "terminal";
    w.updatedAt = new Date().toISOString();
    this.commit(next);
    return structuredClone(w);
  }
}
