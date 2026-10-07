import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicAppRecord } from "./app-store";
import { uuid } from "./history";
import { isWorkerAgentId, workerJobsProblem } from "sane-core/agent-catalog";
import type { WorkerRecord, WorkerRecords, WorkerDelivery } from "./worker-contract";
import { workerResults } from "./worker-contract";

/** Detached selection metadata; complete result history is only cloned after selection. */
export type WorkerSelection = Omit<WorkerRecord, "results"> & {
  /** Any historical result may still need restoration of legacy truncated output. */
  requiresLegacyOutputObservation: boolean;
};
export function workerSelection(worker: WorkerRecord): WorkerSelection {
  const { results, ...selection } = worker;
  return { ...structuredClone(selection), requiresLegacyOutputObservation: workerResults(worker).some(result => result.outcome.summary.length === 4000) };
}

/** Synchronous publication makes reservations and consumption atomic within the App owner. */
export class WorkerStore {
  private records: WorkerRecords;
  private deliveriesByParent = new Map<string, WorkerDelivery[]>();
  private activeDeliveries: WorkerDelivery[] = [];
  private activeDeliveryParents = new Set<string>();
  private generation = 0;
  constructor(private dataDir: string) {
    const path = join(dataDir, "workers.json");
    this.records = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { version: 1, workers: [], suppressedParents: [] };
    this.normalize(this.records);
    this.validate(this.records);
    this.indexDeliveries();
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
      if (!uuid(w.id) || !uuid(w.sessionId) || ids.has(w.id) || sessions.has(w.sessionId) || requests.has(key) || !uuid(w.parent?.sessionId) || !uuid(w.parent?.runId) || !w.parent.toolCallId || !w.parent.native?.nativeId || !w.parent.native.authorityId || !["cc", "oc"].includes(w.parent.native.harness) || !isWorkerAgentId(w.input?.worker) || typeof w.input.prompt !== "string" || !w.input.requestId || w.input.jobs !== undefined && workerJobsProblem(w.input.worker, w.input.jobs) !== undefined || !w.checkout?.startsWith("/") || !w.launch?.agent || !["claude-code", "opencode"].includes(w.launch.harness) || !["reserved", "launching", "running", "waiting", "uncertain", "cancelling", "completed", "failed", "interrupted"].includes(w.state) || !Number.isFinite(Date.parse(w.createdAt)) || !Number.isFinite(Date.parse(w.updatedAt)) || w.runId !== null && !uuid(w.runId)) fail();
      if (w.outcome && (!["completed", "failed", "interrupted"].includes(w.outcome.status) || !w.notification?.id)) fail();
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
  /** Preserve store order and complete result histories for exact delivery-revision rendering. */
  listForDelivery(delivery: Pick<WorkerDelivery, "workerIds">) {
    const ids = new Set(delivery.workerIds);
    return structuredClone(this.records.workers.filter(w => ids.has(w.id)));
  }
  private commit(next: WorkerRecords) { this.normalize(next); this.validate(next); atomicAppRecord(this.dataDir, "workers.json", next); this.records = next; this.generation++; this.indexDeliveries(); }
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
}
