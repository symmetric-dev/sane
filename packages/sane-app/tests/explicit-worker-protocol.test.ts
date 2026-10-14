import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedAgentProfiles } from "../src/agent-profiles-contract";
import { WorkerStore } from "../src/worker-store";
import { WorkerService, type WorkerExecutor, type WorkerParent } from "../src/workers";
import { DEFAULT_MAX_UNFINISHED_EXPLICIT_WORKERS, DEFAULT_MAX_WORKERS_PER_CHECKOUT, workerTerminal, type WorkerCaller, type WorkerExchange, type WorkerProtocolPin, type WorkerRecord } from "../src/worker-contract";
import { explicitObservationChange, workerWaitUnsettled } from "../src/worker-protocol";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const id = () => crypto.randomUUID();
const now = "2026-09-29T10:00:00.000Z";
const pin: WorkerProtocolPin = {
  id: "explicit-v1",
  operations: ["complete", "notify", "message-parent", "message-child"],
  executionRevision: "rev-execution",
  contextRevision: "rev-context",
  runtimeCapabilities: ["sane_worker_complete", "sane_worker_notify", "sane_worker_message_parent", "sane_worker_message"],
};
const done = { outcome: { status: "completed" as const, summary: "finished the assigned check" } };

// Only execution is substituted. Pins, receipts, waits and observation publication use the real service and disk store.
function fixture(limit = DEFAULT_MAX_WORKERS_PER_CHECKOUT, unfinishedLimit = DEFAULT_MAX_UNFINISHED_EXPLICIT_WORKERS) {
  const dir = mkdtempSync(join(tmpdir(), "sane-explicit-worker-")); dirs.push(dir);
  const store = new WorkerStore(dir);
  const rootId = id();
  const native = { harness: "oc" as const, authorityId: "test-authority", nativeId: "parent-native" };
  const parent: WorkerParent = { sessionId: rootId, runId: id(), native, checkout: dir, holdsExecution: false };
  const caller: WorkerCaller = { envelope: {}, runId: parent.runId, toolCallId: "tool-start" };
  const observations = new Map<string, Partial<WorkerRecord>>();
  const executing = new Set<string>();
  let cancelHook: ((worker: { id: string }) => boolean) | undefined;
  const executor: WorkerExecutor = {
    parent: async () => ({ ...parent }), assertCurrentParent: () => {}, assertCapacity: () => {},
    hasActiveExecution: w => executing.has(w.id),
    launch: async () => {},
    observe: async w => observations.get(w.id) ?? {},
    cancel: async () => {},
    cancellationCommitted: w => cancelHook?.(w) ?? false,
  };
  const service = new WorkerService(store, executor, seedAgentProfiles, limit, unfinishedLimit);
  const start = (requestId = id()) => service.start(caller, { requestId, worker: "tester", prompt: "Check the assigned behavior" });
  async function explicit(requestId = id()) {
    parent.sessionId = rootId;
    caller.toolCallId = "tool-start";
    const worker = await start(requestId);
    await service.drainLaunches();
    expect(store.get(worker.id)!.protocol).toBeUndefined();
    service.pinExplicitProtocol(worker.id, pin);
    return store.update(worker.id, { child: { harness: "oc", authorityId: "test-authority", nativeId: `child-${worker.id.slice(0, 8)}` } });
  }
  async function observeTurn(worker: WorkerRecord, status: "completed" | "failed" | "interrupted" = "completed") {
    const runId = worker.runId ?? id();
    if (!worker.runId) store.update(worker.id, { runId });
    const current = store.get(worker.id)!;
    observations.set(worker.id, explicitObservationChange(current, {
      run: { runId, status, endedAt: now }, ownerPresent: false, ownerSettled: true, terminationUncertain: false, cancelRequested: !!current.cancelRequestedAt,
    }));
    return service.refresh(current);
  }
  const delivery = () => ({ id: id(), parentSessionId: rootId, native, commandId: "report-command", run: { runId: id(), sessionId: rootId, cwd: dir, status: "running" as const, createdAt: now }, createdAt: now, updatedAt: now });
  return {
    dir, store, parent, caller, observations, executing, service, start, rootId, explicit, observeTurn, delivery,
    asParent() { parent.sessionId = rootId; caller.toolCallId = "tool-start"; },
    asWorker(worker: WorkerRecord, toolCallId = "tool-op") { parent.sessionId = worker.sessionId; caller.toolCallId = toolCallId; },
    setCancelHook(fn?: (worker: { id: string }) => boolean) { cancelHook = fn; },
  };
}

describe("explicit worker protocol", () => {
  test("absent protocol still completes from an observed successful turn outcome", async () => {
    const f = fixture();
    const started = await f.start();
    await f.service.drainLaunches();
    expect(started.protocol).toBeUndefined();
    const runId = id();
    f.observations.set(started.id, { state: "completed", runId, outcome: { status: "completed", at: now, summary: "initial result", log: { sessionId: started.sessionId, runId } } });
    const completed = await f.service.refresh(started);
    expect(completed.protocol).toBeUndefined();
    expect(completed.assignment).toBeUndefined();
    expect(completed.state).toBe("completed");
    expect(completed.outcome).toMatchObject({ status: "completed", summary: "initial result" });
    expect(completed.results).toHaveLength(1);
    expect(completed.notification?.state).toBe("pending");
    expect(f.store.pendingParents()).toEqual([f.rootId]);
    expect(f.store.claimDelivery(f.delivery())!.workerIds).toEqual([started.id]);
    expect(new WorkerStore(f.dir).get(started.id)!.outcome?.summary).toBe("initial result");
  });

  test("an explicit turn end without completion stays unfinished and idle workers do not fill the execution cap", async () => {
    expect(DEFAULT_MAX_WORKERS_PER_CHECKOUT).toBe(8);
    expect(DEFAULT_MAX_UNFINISHED_EXPLICIT_WORKERS).toBe(24);
    const defaults = fixture();
    expect(defaults.service.checkoutLimit).toBe(8);
    expect(defaults.service.unfinishedExplicitLimit).toBe(24);

    const f = fixture(1);
    const worker = await f.explicit();
    expect(f.service.executionCount(f.parent.checkout)).toBe(1);
    await expect(f.start("blocked-while-reserved")).rejects.toMatchObject({ code: "worker-capacity" });
    const idle = await f.observeTurn(worker);
    expect(idle.outcome).toBeUndefined();
    expect(idle.assignment).toBe("open");
    expect(idle.state).toBe("idle");
    expect(idle.results ?? []).toEqual([]);
    expect(f.store.pendingParents()).toEqual([]);
    expect(f.service.executionCount(f.parent.checkout)).toBe(0);
    const restarted = new WorkerStore(f.dir).get(worker.id)!;
    expect(restarted.outcome).toBeUndefined();
    expect(restarted.assignment).not.toBe("terminal");
    const next = await f.start("fills-a-free-execution-slot");
    expect(f.service.executionOccupants().map(row => row.id)).toEqual([next.id]);
    expect(f.store.get(worker.id)!.state).toBe("idle");
  });

  test("unfinished explicit capacity rejects one pin past a reduced limit without a live checkout of 24", async () => {
    const f = fixture(8, 1);
    const first = await f.explicit();
    await f.observeTurn(first);
    expect(f.store.get(first.id)).toMatchObject({ state: "idle", assignment: "open" });
    expect(f.service.executionCount(f.parent.checkout)).toBe(0);
    const second = await f.start("second-unfinished");
    await f.service.drainLaunches();
    expect(() => f.service.pinExplicitProtocol(second.id, pin)).toThrow(/unfinished explicit worker capacity reached \(1\/1\)/);
    expect(f.store.get(second.id)!.protocol).toBeUndefined();
    expect(f.store.get(first.id)!.protocol?.id).toBe("explicit-v1");
  });

  test("complete accepts one receipt, does not publish a parent result, and keeps that receipt through terminalization", async () => {
    const f = fixture();
    const worker = await f.explicit();
    f.asWorker(worker, "tool-complete");
    const requestId = "complete-1";
    const accepted = await f.service.complete(f.caller, done, requestId);
    expect(accepted).toEqual({ completion: { state: "accepted", revision: 1 } });
    const stored = f.store.get(worker.id)!;
    const receiptId = stored.completion!.receipt.id;
    expect(stored.completion).toMatchObject({ requestId, outcome: done.outcome, receipt: { state: "accepted", revision: 1 } });
    expect(stored.assignment).toBe("closing");
    expect(stored.outcome).toBeUndefined();
    expect(stored.results ?? []).toEqual([]);
    expect(stored.notification).toBeUndefined();
    expect(f.store.pendingParents()).toEqual([]);
    expect(f.store.claimDelivery(f.delivery())).toBeUndefined();
    expect(new WorkerStore(f.dir).get(worker.id)!.completion!.receipt.id).toBe(receiptId);

    const replay = await f.service.complete(f.caller, done, requestId);
    expect(replay).toEqual(accepted);
    expect(f.store.get(worker.id)!.completion!.receipt.id).toBe(receiptId);
    expect(f.store.get(worker.id)!.operationReceipts).toHaveLength(1);

    await expect(f.service.complete(f.caller, { outcome: { status: "completed", summary: "different report" } }, requestId)).rejects.toThrow("already bound");
    f.asWorker(worker, "tool-other");
    await expect(f.service.complete(f.caller, done, requestId)).rejects.toThrow("already bound");
    expect(f.store.get(worker.id)!.completion!.receipt.id).toBe(receiptId);
    expect(f.store.get(worker.id)!.operationReceipts).toHaveLength(1);
    expect(f.store.claimDelivery(f.delivery())).toBeUndefined();

    f.asWorker(worker, "tool-complete");
    const terminal = await f.observeTurn(f.store.get(worker.id)!);
    expect(terminal.assignment).toBe("terminal");
    const resultsBefore = f.store.get(worker.id)!.results?.length ?? 0;
    const afterTerminal = await f.service.complete(f.caller, done, requestId);
    expect(afterTerminal).toEqual(accepted);
    expect(f.store.get(worker.id)!.completion!.receipt.id).toBe(receiptId);
    expect(f.store.get(worker.id)!.results?.length ?? 0).toBe(resultsBefore);
    await expect(f.service.complete(f.caller, { outcome: { status: "completed", summary: "a later final" } }, "complete-fresh")).rejects.toThrow("Assignment is already terminal");
    expect(f.store.get(worker.id)!.completion!.receipt.id).toBe(receiptId);
  });

  test("parent consultation blocks completion, a second user-or-parent wait is rejected, and a late exchange does not clear a newer wait", async () => {
    const f = fixture();
    const worker = await f.explicit();
    f.asWorker(worker, "tool-notify");
    const info = await f.service.notify(f.caller, { text: "status only", intent: "informational" }, "info-1");
    expect(info.attention.state).toBe("accepted");
    expect(f.store.get(worker.id)!.wait).toBeUndefined();
    const request = await f.service.notify(f.caller, { text: "need a decision", intent: "request" }, "ask-1");
    expect(request.attention.state).toBe("accepted");
    expect(f.store.get(worker.id)!.wait).toMatchObject({ reason: "user", correlationId: "ask-1" });
    await expect(f.service.notify(f.caller, { text: "another ask", intent: "request" }, "ask-2")).rejects.toMatchObject({ code: "wait-conflict" });
    await expect(f.service.messageParent(f.caller, { text: "and a consultation", awaitReply: true }, "consult-blocked")).rejects.toMatchObject({ code: "wait-conflict" });
    expect(f.store.get(worker.id)!.wait).toMatchObject({ reason: "user", correlationId: "ask-1" });

    f.asParent();
    const child = await f.explicit();
    f.asWorker(child, "tool-consult");
    const consult = await f.service.messageParent(f.caller, { text: "Which approach?", awaitReply: true }, "consult-1");
    expect(f.store.get(child.id)!.wait).toMatchObject({ reason: "parent", correlationId: consult.exchange.correlationId });
    await expect(f.service.complete(f.caller, done, "complete-blocked")).rejects.toMatchObject({ code: "completion-blocked", blockers: ["consultation"] });
    expect(f.store.get(child.id)!.completion).toBeUndefined();
    expect(f.store.get(child.id)!.assignment).toBe("open");
    await f.service.notify(f.caller, { text: "still working", intent: "informational" }, "info-2");
    expect(f.store.get(child.id)!.wait).toMatchObject({ reason: "parent", correlationId: consult.exchange.correlationId });
    await expect(f.service.notify(f.caller, { text: "ask the user too", intent: "request" }, "ask-3")).rejects.toMatchObject({ code: "wait-conflict" });
    await expect(f.service.messageParent(f.caller, { text: "second consult", awaitReply: true }, "consult-2")).rejects.toMatchObject({ code: "wait-conflict" });

    f.asParent();
    const reply = await f.service.messageChild(f.caller, { workerId: child.id, text: "Use the narrow path" }, "guide-1");
    expect(reply.exchange.correlationId).toBe(consult.exchange.correlationId);
    expect(f.store.get(child.id)!.wait?.reason).toBe("none");
    f.asWorker(child, "tool-consult");
    const newer = await f.service.messageParent(f.caller, { text: "One more check", awaitReply: true }, "consult-3");
    const current = f.store.get(child.id)!;
    const late: WorkerExchange = {
      id: id(), requestId: "late-guidance", fingerprint: "ab".repeat(32), invocationKey: "late-invocation",
      direction: "parent-to-child", kind: "guidance", correlationId: consult.exchange.correlationId, sequence: 1,
      sender: { sessionId: f.rootId, native: f.parent.native }, recipient: { sessionId: child.sessionId, native: current.child! },
      protocol: "explicit-v1", text: "stale reply", delivery: { state: "queued" }, createdAt: now,
    };
    const exchanged = f.store.commitExchange(child.id, late, undefined, consult.exchange.correlationId);
    expect(exchanged.status).toBe("accepted");
    expect(f.store.get(child.id)!.wait).toMatchObject({ reason: "parent", correlationId: newer.exchange.correlationId });
    expect(f.store.get(child.id)!.exchanges).toHaveLength((current.exchanges?.length ?? 0) + 1);
  });

  test("cancellation committed before complete wins and does not overwrite an accepted receipt", async () => {
    const f = fixture();
    const raced = await f.explicit();
    f.setCancelHook(() => true);
    f.asWorker(raced, "tool-complete");
    await expect(f.service.complete(f.caller, done, "complete-raced")).rejects.toThrow("Cancellation already committed");
    expect(f.store.get(raced.id)!.completion).toBeUndefined();
    expect(f.store.get(raced.id)!.cancelRequestedAt).toBeUndefined();
    expect(f.store.get(raced.id)!.operationReceipts ?? []).toEqual([]);

    f.setCancelHook(undefined);
    f.asParent();
    const cancelled = await f.explicit();
    await f.service.cancel(f.caller, [cancelled.id]);
    expect(f.store.get(cancelled.id)!.cancelRequestedAt).toBeDefined();
    expect(f.store.get(cancelled.id)!.completion).toBeUndefined();
    f.asWorker(cancelled, "tool-complete");
    await expect(f.service.complete(f.caller, done, "complete-cancelled")).rejects.toThrow("Cancellation already committed");
    expect(f.store.get(cancelled.id)!.completion).toBeUndefined();
    expect(f.store.get(cancelled.id)!.outcome).toBeUndefined();

    f.asParent();
    const accepted = await f.explicit();
    f.asWorker(accepted, "tool-complete");
    const receipt = await f.service.complete(f.caller, done, "complete-ok");
    expect(receipt).toEqual({ completion: { state: "accepted", revision: 1 } });
    const before = f.store.get(accepted.id)!;
    f.asParent();
    f.executing.add(accepted.id);
    f.setCancelHook(() => true);
    await f.service.cancel(f.caller, [accepted.id]);
    const after = f.store.get(accepted.id)!;
    expect(after.completion).toEqual(before.completion);
    expect(after.operationReceipts).toEqual(before.operationReceipts);
    expect(after.assignment).toBe("closing");
    expect(after.outcome).toBeUndefined();
    expect(after.cancelRequestedAt).toBeUndefined();
    f.asWorker(accepted, "tool-complete");
    expect(await f.service.complete(f.caller, done, "complete-ok")).toEqual(receipt);
    expect(f.store.get(accepted.id)!.completion!.receipt.id).toBe(before.completion!.receipt.id);
  });

  test("accepted user input resolves only the captured user-wait correlation", async () => {
    const f = fixture();
    const worker = await f.explicit();
    f.asWorker(worker, "tool-notify");
    await f.service.notify(f.caller, { text: "need a decision", intent: "request" }, "ask-1");
    const waiting = f.store.get(worker.id)!;
    expect(waiting.wait).toMatchObject({ reason: "user", correlationId: "ask-1" });
    expect(waiting.attention?.map(item => item.requestId)).toEqual(["ask-1"]);

    f.store.resolveAcceptedUserWait(worker.sessionId, "other-correlation");
    expect(f.store.get(worker.id)).toEqual(waiting);
    await expect(f.service.messageParent(f.caller, { text: "still blocked", awaitReply: true }, "consult-blocked")).rejects.toMatchObject({ code: "wait-conflict" });
    expect(f.store.get(worker.id)!.attention).toEqual(waiting.attention);
    expect(f.store.get(worker.id)!.operationReceipts).toEqual(waiting.operationReceipts);

    f.store.resolveAcceptedUserWait(worker.sessionId, "ask-1");
    const cleared = f.store.get(worker.id)!;
    expect(cleared.wait?.reason).toBe("none");
    expect(cleared.attention).toEqual(waiting.attention);
    expect(cleared.operationReceipts).toEqual(waiting.operationReceipts);
    expect(cleared.notification).toEqual(waiting.notification);
    const consult = await f.service.messageParent(f.caller, { text: "which path?", awaitReply: true }, "consult-after-user");
    expect(consult.exchange.state).toBe("accepted");
    const parentWait = f.store.get(worker.id)!;
    expect(parentWait.wait).toMatchObject({ reason: "parent", correlationId: consult.exchange.correlationId });
    f.store.resolveAcceptedUserWait(worker.sessionId, "ask-1");
    expect(f.store.get(worker.id)).toEqual(parentWait);
  });

  test("explicit wait joins a settled turn without reporting it as terminal", async () => {
    const f = fixture();
    const worker = await f.explicit();
    expect(workerWaitUnsettled(f.store.get(worker.id)!)).toBe(true);
    expect((await f.service.wait(f.caller, [worker.id], 0)).timedOut).toBe(true);

    const idle = await f.observeTurn(worker);
    expect(idle.state).toBe("idle");
    expect(workerWaitUnsettled(idle)).toBe(false);
    expect(workerWaitUnsettled(idle, true)).toBe(true);
    expect(workerTerminal(idle)).toBe(false);
    f.asParent();
    const joined = await f.service.wait(f.caller, [worker.id], 0);
    expect(joined.timedOut).toBe(false);
    expect(joined.workers[0]).toMatchObject({ id: worker.id, state: "idle", assignment: "open" });
    expect(joined.workers[0]!.outcome).toBeUndefined();
    expect(f.store.get(worker.id)).toMatchObject({ state: "idle", assignment: "open" });
    expect(f.store.get(worker.id)!.outcome).toBeUndefined();

    f.executing.add(worker.id);
    expect((await f.service.wait(f.caller, [worker.id], 0)).timedOut).toBe(true);
    expect(f.store.get(worker.id)!.assignment).not.toBe("terminal");
    f.executing.delete(worker.id);

    const legacy = await f.start("legacy-unfinished");
    expect(legacy.protocol).toBeUndefined();
    expect(workerWaitUnsettled(legacy)).toBe(true);
    const held = await f.service.wait(f.caller, [legacy.id], 0);
    expect(held.timedOut).toBe(true);
    expect(workerTerminal(held.workers[0]!)).toBe(false);
    expect(held.workers[0]!.state).toBe(legacy.state);
  });
});
