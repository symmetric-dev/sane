import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicAppRecord } from "./app-store";
import { uuid } from "./history";
import { isWorkerAgentId, workerJobsProblem } from "sane-core/agent-catalog";
import type { WorkerAttention, WorkerCompletion, WorkerExchange, WorkerOperationReceipt, WorkerProtocolPin, WorkerRecord, WorkerRecords, WorkerDelivery, WorkerWait } from "./worker-contract";
import { workerResults } from "./worker-contract";
import { completionBlockers, sameProtocolPin, validProtocolPin, type CompletionBlocker } from "./worker-protocol";

/** Detached selection metadata; complete result history is only cloned after selection. */
export type WorkerSelection = Omit<WorkerRecord, "results"> & {
  /** Any historical result may still need restoration of legacy truncated output. */
  requiresLegacyOutputObservation: boolean;
};
export function workerSelection(worker: WorkerRecord): WorkerSelection {
  const { results, ...selection } = worker;
  return { ...structuredClone(selection), requiresLegacyOutputObservation: workerResults(worker).some(result => result.outcome.summary.length === 4000) };
}

const PROTOCOL_OPS = ["complete", "notify", "message-parent", "message-child"];
const EXCHANGE_STATES = ["queued", "claimed", "acceptance-unknown", "accepted", "not-submitted"];
function executionRun(worker: WorkerRecord, runId: string) {
  return worker.runId === runId || worker.continuation?.runId === runId || !!worker.exchanges?.some(exchange => exchange.delivery.runId === runId);
}
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

/** Synchronous publication makes reservations and consumption atomic within the App owner. */
export class WorkerStore {
  private records: WorkerRecords;
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
    this.indexDeliveries();
    this.indexExchanges();
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
      if (w.outcome && (!["completed", "failed", "interrupted"].includes(w.outcome.status) || !w.notification?.id)) fail();
      if (w.coordination !== undefined && !(w.coordination === "scouts" && w.input.worker === "scout-crew" || w.coordination === "workers" && w.input.worker === "implementer")) fail();
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
  get(id: string) {
    const w = this.records.workers.find(w => w.id === id);
    return w ? structuredClone(w) : undefined;
  }
  /** Historical reservation identity, independent of the current parent run or worker state. */
  getByRequest(parentSessionId: string, requestId: string) {
    const w = this.records.workers.find(w => w.parent.sessionId === parentSessionId && w.input.requestId === requestId);
    return w ? structuredClone(w) : undefined;
  }
  getBySession(sessionId: string) {
    const w = this.records.workers.find(w => w.sessionId === sessionId);
    return w ? structuredClone(w) : undefined;
  }
  hasSession(sessionId: string) { return this.records.workers.some(w => w.sessionId === sessionId); }
  /** Match only the recorded worker run, not continuation runs or historical result runs. */
  getByRun(runId: string) {
    const w = this.records.workers.find(w => w.runId === runId);
    return w ? structuredClone(w) : undefined;
  }
  hasRun(runId: string) { return this.records.workers.some(w => w.runId === runId); }
  /** Initial run, continuation, or exchange delivery. getByRun remains the initial run only. */
  getByExecutionRun(runId: string) {
    const w = this.records.workers.find(worker => executionRun(worker, runId));
    return w ? structuredClone(w) : undefined;
  }
  hasExecutionRun(runId: string) { return this.records.workers.some(worker => executionRun(worker, runId)); }
  hasActiveExchange(sessionId: string) { return this.activeExchangeRecipients.has(sessionId); }
  queuedExchanges(now = Date.now()) {
    return this.records.workers.flatMap(worker => (worker.exchanges ?? []).filter(exchange => exchange.delivery.state === "queued" && (!exchange.delivery.retryAfter || Date.parse(exchange.delivery.retryAfter) <= now)).map(exchange => ({ workerId: worker.id, exchange: structuredClone(exchange) }))).sort((a, b) => a.exchange.createdAt.localeCompare(b.exchange.createdAt) || a.exchange.id.localeCompare(b.exchange.id));
  }
  exchangesToReconcile() {
    return this.records.workers.flatMap(worker => (worker.exchanges ?? []).filter(exchange => exchange.delivery.state === "claimed" || exchange.delivery.state === "acceptance-unknown").map(exchange => ({ workerId: worker.id, exchange: structuredClone(exchange) })));
  }
  /** Preserve store order and complete result histories for exact delivery-revision rendering. */
  listForDelivery(delivery: Pick<WorkerDelivery, "workerIds">) {
    const ids = new Set(delivery.workerIds);
    return structuredClone(this.records.workers.filter(w => ids.has(w.id)));
  }
  private commit(next: WorkerRecords) { this.normalize(next); this.validate(next); atomicAppRecord(this.dataDir, "workers.json", next); this.records = next; this.generation++; this.indexDeliveries(); this.indexExchanges(); }
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
    const next = structuredClone(this.records);
    const located = next.workers.flatMap(worker => (worker.exchanges ?? []).map(exchange => ({ worker, exchange }))).find(item => item.exchange.id === exchangeId);
    if (!located || located.exchange.delivery.error === error) return;
    located.exchange.delivery = { ...located.exchange.delivery, error };
    located.worker.updatedAt = new Date().toISOString();
    this.commit(next);
  }
  /** Publish the accepted explicit outcome once. A later settlement annotation never adds a second result. */
  publishExplicitObservation(id: string, change: Partial<WorkerRecord>): WorkerRecord {
    const next = structuredClone(this.records), w = next.workers.find(worker => worker.id === id);
    if (!w) throw new Error("Unknown worker");
    if (w.protocol?.id !== "explicit-v1") throw new Error("Explicit observation requires an explicit protocol pin");
    if (change.state) w.state = change.state;
    if (change.error !== undefined) w.error = change.error;
    if (change.continuation) w.continuation = change.continuation;
    if (change.assignment && w.assignment !== "terminal") w.assignment = change.assignment;
    if (change.settlement && !w.settlement) w.settlement = change.settlement;
    if (change.outcome && !w.outcome && !(w.results ?? []).length) {
      const runId = change.outcome.log?.runId ?? w.runId;
      const notification = { id: `worker-outcome:${w.id}`, state: "pending" as const };
      w.outcome = change.outcome;
      w.notification = notification;
      w.results = [{ revision: 1, runId, outcome: change.outcome, notification }];
      w.assignment = "terminal";
      w.state = change.outcome.status;
    } else if (w.outcome && w.assignment !== "terminal") w.assignment = "terminal";
    w.updatedAt = new Date().toISOString();
    this.commit(next);
    return structuredClone(w);
  }
}
