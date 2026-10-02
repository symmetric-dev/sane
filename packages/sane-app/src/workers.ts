import { isWorkerAgentId } from "sane-core/agent-catalog";
import type { ConversationRef } from "sane-core/contracts";
import { resolveWorkerProfile, type AgentProfiles } from "./agent-profiles-contract";
import { WorkerStore } from "./worker-store";
import { DEFAULT_MAX_WORKERS_PER_CHECKOUT, workerResults, workerTerminal, type WorkerCaller, type WorkerRecord, type WorkerStart } from "./worker-contract";
import { WorkstreamAdapterError } from "./workstreams";

export type WorkerParent = { sessionId: string; runId: string; native: ConversationRef; checkout: string; profileId?: string };
export type WorkerExecutor = {
  parent(caller: WorkerCaller, starting: boolean): Promise<WorkerParent>;
  assertCurrentParent(parent: WorkerParent): void;
  hasActiveExecution(worker: WorkerRecord): boolean;
  assertCapacity(): void;
  launch(worker: WorkerRecord): Promise<void>;
  observe(worker: WorkerRecord): Promise<Partial<WorkerRecord>>;
  cancel(worker: WorkerRecord): Promise<void>;
};
const error = (code: string, message: string): never => { throw new WorkstreamAdapterError(409, code, message); };

/** Public admission failure: only counts and recovery guidance cross the native boundary. */
export class WorkerCapacityError extends WorkstreamAdapterError {
  constructor(readonly activeCount: number, readonly limit: number) {
    super(409, "worker-capacity", `Checkout worker capacity reached (${activeCount}/${limit} active SANE workers). The limit includes scout crews, nested workers and active continuations in this checkout. This request did not admit a worker; other starts in the same batch may have succeeded. Inspect sane_worker_status before retrying only missing assignments when a slot is free. Do not relaunch the batch through native subagents to bypass capacity.`);
  }
}

/** Orchestration records only. Execution, logs and recovery belong to the existing bridge. */
export class WorkerService {
  private launches = new Set<Promise<void>>();
  constructor(readonly store: WorkerStore, private executor: WorkerExecutor, private profiles: () => AgentProfiles, readonly checkoutLimit = DEFAULT_MAX_WORKERS_PER_CHECKOUT) {}
  active() { return this.store.list().filter(w => !workerTerminal(w) || this.executor.hasActiveExecution(w)); }
  tree(parentSessionId: string) {
    const all = this.store.list(), parents = new Set([parentSessionId]), result: WorkerRecord[] = [];
    for (let changed = true; changed;) {
      changed = false;
      for (const w of all) if (parents.has(w.parent.sessionId) && !parents.has(w.sessionId)) { parents.add(w.sessionId); result.push(w); changed = true; }
    }
    return result;
  }
  async start(caller: WorkerCaller, input: WorkerStart, assertActive: () => void = () => {}) {
    if (!input || !isWorkerAgentId(input.worker) || typeof input.requestId !== "string" || !input.requestId || input.requestId.length > 200 || typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 100000 || input.context !== undefined && (typeof input.context !== "string" || input.context.length > 100000)) error("invalid-worker-input", "Worker role, request ID and bounded prompt/context text required");
    let parent = await this.executor.parent(caller, false);
    const payload: WorkerStart = { requestId: input.requestId, worker: input.worker, prompt: input.prompt, ...(input.context !== undefined ? { context: input.context } : {}) };
    const old = this.store.getByRequest(parent.sessionId, input.requestId);
    if (old) {
      if (JSON.stringify(old.input) !== JSON.stringify(payload) || old.parent.runId !== parent.runId || old.parent.toolCallId !== caller.toolCallId || JSON.stringify(old.parent.invocation?.opencode) !== JSON.stringify(caller.invocation?.opencode)) error("worker-request-conflict", "Request ID already bound to another invocation/payload");
      return old;
    }
    parent = await this.executor.parent(caller, true);
    const concurrent = this.store.getByRequest(parent.sessionId, input.requestId);
    if (concurrent) {
      if (JSON.stringify(concurrent.input) !== JSON.stringify(payload) || concurrent.parent.runId !== parent.runId || concurrent.parent.toolCallId !== caller.toolCallId || JSON.stringify(concurrent.parent.invocation?.opencode) !== JSON.stringify(caller.invocation?.opencode)) error("worker-request-conflict", "Request ID already bound to another invocation/payload");
      return concurrent;
    }
    const launch = resolveWorkerProfile(this.profiles(), input.worker, parent.profileId);
    this.executor.assertCapacity();
    const activeCount = this.active().filter(w => w.checkout === parent.checkout).length;
    if (activeCount >= this.checkoutLimit) throw new WorkerCapacityError(activeCount, this.checkoutLimit);
    const now = new Date().toISOString();
    const w: WorkerRecord = { id: crypto.randomUUID(), sessionId: crypto.randomUUID(), runId: null, parent: { sessionId: parent.sessionId, runId: parent.runId, toolCallId: caller.toolCallId, native: parent.native, ...(caller.invocation ? { invocation: caller.invocation } : {}) }, input: payload, checkout: parent.checkout, launch, child: null, state: "reserved", createdAt: now, updatedAt: now };
    this.executor.assertCurrentParent(parent); // No await between this ownership check and durable reservation.
    assertActive();
    this.store.insert(w); // Reserve before any asynchronous creation; retries never launch again.
    const task = this.executor.launch(w).catch(e => { if (!this.store.get(w.id)?.outcome) this.store.update(w.id, { state: "uncertain", error: e instanceof Error ? e.message : "Worker launch unconfirmed" }); });
    this.launches.add(task);
    void task.then(() => this.launches.delete(task), () => {}); // Failed persistence remains visible to shutdown drain.
    return w;
  }
  async drainLaunches() { await Promise.all(this.launches); }
  async refresh(w: WorkerRecord): Promise<WorkerRecord> {
    w = this.store.get(w.id)!;
    const change = await this.executor.observe(w);
    const latest = this.store.get(w.id)!;
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
    if (!changed) return latest;
    const updated = this.store.update(w.id, change);
    return change.results ? this.refresh(updated) : updated;
  }
  private async scoped(caller: WorkerCaller, ids?: string[]) {
    const p = await this.executor.parent(caller, false), tree = this.tree(p.sessionId);
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 256 || ids.some(id => !tree.some(w => w.id === id)))) error("worker-scope", "Workers must belong to the caller's descendant tree");
    return ids ? tree.filter(w => ids.includes(w.id)) : tree;
  }
  async status(caller: WorkerCaller, ids?: string[]) { return Promise.all((await this.scoped(caller, ids)).map(w => this.refresh(w))); }
  async result(caller: WorkerCaller, id: string) { return (await this.status(caller, [id]))[0]!; }
  async wait(caller: WorkerCaller, ids: string[], timeoutSec = 0) {
    if (!Array.isArray(ids) || !ids.length || !Number.isFinite(timeoutSec) || timeoutSec < 0 || timeoutSec > 10) error("worker-wait", "Wait requires IDs and a timeout between 0 and 10 seconds");
    const end = Date.now() + timeoutSec * 1000;
    let workers = await this.status(caller, ids);
    while (workers.some(w => !workerTerminal(w)) && Date.now() < end) { await Bun.sleep(Math.min(200, end - Date.now())); workers = await this.status(caller, ids); }
    // Deliberately separate acknowledgement from wait: transport loss must not silently consume outcomes.
    return { workers, timedOut: workers.some(w => !workerTerminal(w)) };
  }
  async acknowledgeWait(caller: WorkerCaller, refs: { workerId: string; revision: number; notificationId: string }[]) {
    if (!Array.isArray(refs) || !refs.length || refs.length > 256 || refs.some(r => !r || typeof r.workerId !== "string" || !Number.isInteger(r.revision) || r.revision < 1 || typeof r.notificationId !== "string")) error("worker-wait", "Exact result revision and notification IDs required");
    const workers = await this.scoped(caller, refs.map(r => r.workerId));
    const recipient = await this.executor.parent(caller, false);
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
    const tree = this.tree(parentSessionId);
    if (ids !== "all" && (!Array.isArray(ids) || !ids.length || ids.length > 256 || ids.some(id => !tree.some(w => w.id === id)))) error("worker-scope", "Explicit workers must belong to the selected parent session's tree");
    return this.cancelSelected(ids === "all" ? tree : tree.filter(w => ids.includes(w.id)), includeDescendants);
  }
  private async cancelSelected(selected: WorkerRecord[], includeDescendants: boolean) {
    if (includeDescendants) selected = [...new Map(selected.flatMap(w => [w, ...this.tree(w.sessionId)]).map(w => [w.id, w])).values()];
    return Promise.all(selected.map(async row => {
      let w = await this.refresh(row);
      this.store.suppress(w.sessionId, true);
      if (w.outcome) {
        if (!this.executor.hasActiveExecution(w)) return w;
        const requestedAt = new Date().toISOString();
        w = this.store.update(w.id, { state: "cancelling", continuation: w.continuation ? { ...w.continuation, state: "cancelling" } : undefined, continuationCancellation: { requestedAt } });
        try { await this.executor.cancel(w); } catch (e) { return this.store.update(w.id, { continuationCancellation: { requestedAt, error: e instanceof Error ? e.message : "Continuation cancellation unconfirmed" } }); }
        return w; // Requested only; actual continuation termination remains in its ordinary run log.
      }
      w = this.store.update(w.id, { state: "cancelling", cancelRequestedAt: w.cancelRequestedAt ?? new Date().toISOString() });
      try { await this.executor.cancel(w); } catch (e) { return this.store.update(w.id, { error: e instanceof Error ? e.message : "Cancellation unconfirmed" }); }
      return this.refresh(this.store.get(w.id)!);
    }));
  }
  async cancelAll(caller: WorkerCaller, scope: { parentSessionId: string }) {
    const p = await this.executor.parent(caller, false);
    if (scope?.parentSessionId !== p.sessionId) error("worker-scope", "Explicit cancel-all scope must equal the caller's App session");
    return this.cancelForSession(p.sessionId, "all");
  }
}
