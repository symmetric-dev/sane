import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedAgentProfiles } from "../src/agent-profiles-contract";
import { WorkerStore } from "../src/worker-store";
import { WorkerService, type WorkerExecutor, type WorkerParent } from "../src/workers";
import type { WorkerCaller, WorkerDelivery, WorkerRecord } from "../src/worker-contract";
import { workerReportPrompt } from "../src/worker-outbox";
import { nativeWorkerRequestId, projectNativeWorkerReply } from "../../sane-cli/src/native-worker-contract";
import { OpenCodeWorkerInvocations } from "../../sane-cli/src/native-opencode";
import { createNativeWorkerHandler, type NativeWorkerOperations } from "../src/native-workers";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const id = () => crypto.randomUUID();
const now = "2026-09-29T10:00:00.000Z";

// Only execution is substituted. Admission, tree authorization, result revisions,
// arbitration and restart recovery all use the public service and disk store.
function fixture(limit = 4) {
  const dir = mkdtempSync(join(tmpdir(), "sane-worker-unit-")); dirs.push(dir);
  const store = new WorkerStore(dir);
  const parent: WorkerParent = { sessionId: id(), runId: id(), native: { harness: "oc", authorityId: "test-authority", nativeId: "parent-native" }, checkout: dir, holdsExecution: false };
  const caller: WorkerCaller = { envelope: {}, runId: parent.runId, toolCallId: "tool-start" };
  const launched: string[] = [], cancelled: string[] = [];
  const observations = new Map<string, Partial<WorkerRecord>>();
  const executing = new Set<string>();
  const executor: WorkerExecutor = {
    parent: async () => ({ ...parent }), assertCurrentParent: () => {}, assertCapacity: () => {},
    hasActiveExecution: w => executing.has(w.id),
    launch: async w => { launched.push(w.id); },
    observe: async w => observations.get(w.id) ?? {},
    cancel: async w => { cancelled.push(w.id); },
  };
  const service = new WorkerService(store, executor, seedAgentProfiles, limit);
  const start = (requestId: string = id()) => service.start(caller, { requestId, worker: "tester", prompt: "Check the assigned behavior" });
  async function complete(w: WorkerRecord, summary = "initial result", runId = id()) {
    observations.set(w.id, { state: "completed", runId, outcome: { status: "completed", at: now, summary, log: { sessionId: w.sessionId, runId } } });
    return service.refresh(w);
  }
  const delivery = (): Omit<WorkerDelivery, "workerIds" | "resultRefs" | "state"> => ({ id: id(), parentSessionId: parent.sessionId, native: parent.native, commandId: "report-command", run: { runId: id(), sessionId: parent.sessionId, cwd: dir, status: "running", createdAt: now }, createdAt: now, updatedAt: now });
  return { dir, store, parent, caller, launched, cancelled, observations, executing, executor, service, start, complete, delivery };
}
function ref(w: WorkerRecord, revision = 1) {
  const result = w.results!.find(r => r.revision === revision)!;
  return { workerId: w.id, revision, notificationId: result.notification.id };
}

describe("App-managed worker service and durable outbox", () => {
  test("two callbacks sharing one execute card create separate durable workers and retry independently", async () => {
    const f = fixture(), tracker = new OpenCodeWorkerInvocations();
    const tool = { sessionID: f.parent.native.nativeId, messageID: "message", id: f.caller.toolCallId, agent: "build", tool: "execute" };
    tracker.before(tool);
    const envelope = { version: 1, repository: f.dir, source: { version: 1, harness: "oc", kind: "local-registration", registrationFile: "/sources/service.json" }, authorityId: f.parent.native.authorityId, nativeId: tool.sessionID } as const;
    const callbacks = [tracker.callback(tool, "start"), tracker.callback(tool, "start")];
    const callers = callbacks.map(invocation => ({ ...f.caller, invocation }));
    const inputs = callbacks.map(invocation => ({ requestId: nativeWorkerRequestId(envelope, invocation), worker: "tester" as const, prompt: "bounded task" }));
    const rows = await Promise.all(inputs.map((input, i) => f.service.start(callers[i]!, input)));
    await f.service.drainLaunches();
    expect(new Set(rows.map(w => w.id)).size).toBe(2);
    expect(rows.map(w => w.parent.toolCallId)).toEqual([tool.id, tool.id]);
    const restarted = new WorkerService(new WorkerStore(f.dir), f.executor, seedAgentProfiles);
    for (let i = 0; i < rows.length; i++) expect((await restarted.start(callers[i]!, inputs[i]!)).id).toBe(rows[i]!.id);
    await expect(restarted.start(callers[1]!, inputs[0]!)).rejects.toMatchObject({ code: "worker-request-conflict" });
    expect(f.launched).toHaveLength(2);
    expect(new WorkerStore(f.dir).list().map(w => w.parent.invocation?.opencode?.invocationId).sort()).toEqual(callbacks.map(i => i.opencode!.invocationId).sort());
  });
  test("concurrent retries reserve once, launch once and recover the same reservation", async () => {
    const f = fixture();
    const rows = await Promise.all(Array.from({ length: 8 }, () => f.start("same-invocation")));
    await f.service.drainLaunches();
    expect(new Set(rows.map(w => w.id)).size).toBe(1);
    expect(f.launched).toEqual([rows[0]!.id]);
    const restarted = new WorkerService(new WorkerStore(f.dir), f.executor, seedAgentProfiles);
    expect((await restarted.start(f.caller, rows[0]!.input)).id).toBe(rows[0]!.id);
    expect(f.launched).toHaveLength(1);
  });

  test("reused admission identity rejects changed payload or trusted invocation", async () => {
    const f = fixture(), w = await f.start("request");
    await expect(f.service.start(f.caller, { ...w.input, prompt: "different" })).rejects.toMatchObject({ code: "worker-request-conflict" });
    await expect(f.service.start({ ...f.caller, toolCallId: "other-tool" }, w.input)).rejects.toMatchObject({ code: "worker-request-conflict" });
    expect(f.store.list()).toHaveLength(1);
  });

  test("concurrent admission cannot overbook checkout slots; an active continuation still occupies one", async () => {
    const f = fixture(2);
    const attempts = await Promise.allSettled([f.start(), f.start(), f.start()]);
    expect(attempts.filter(r => r.status === "fulfilled")).toHaveLength(2);
    expect(attempts.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "worker-capacity" } });
    const w = await f.complete(f.store.list()[0]!);
    f.executing.add(w.id);
    await expect(f.start()).rejects.toMatchObject({ code: "worker-capacity" });
    f.executing.delete(w.id);
    await f.start();
    expect(f.store.list()).toHaveLength(3);
  });

  test("parent suppression persists without cancelling workers; user resumption releases pending report", async () => {
    const f = fixture(), w = await f.start();
    f.store.suppress(f.parent.sessionId, true);
    await f.complete(w);
    const restarted = new WorkerStore(f.dir);
    expect(restarted.suppressed(f.parent.sessionId)).toBe(true);
    expect(restarted.claimDelivery(f.delivery())).toBeUndefined();
    expect(f.cancelled).toEqual([]);
    expect(restarted.get(w.id)!.latestResult!.notification.state).toBe("pending");
    restarted.suppress(f.parent.sessionId, false);
    expect(restarted.claimDelivery(f.delivery())!.workerIds).toEqual([w.id]);
  });

  test("individual, tree and all cancellation retain explicit descendant and parent scopes", async () => {
    const f = fixture(8), root = f.parent.sessionId;
    const a = await f.start(), sibling = await f.start();
    f.parent.sessionId = a.sessionId;
    const child = await f.start();
    f.parent.sessionId = root;
    await f.service.cancel(f.caller, [a.id]);
    expect(f.cancelled).toEqual([a.id]);
    expect(f.store.get(child.id)!.state).toBe("reserved");
    f.cancelled.length = 0;
    await f.service.cancel(f.caller, [a.id], true);
    expect(new Set(f.cancelled)).toEqual(new Set([a.id, child.id]));
    f.parent.sessionId = id();
    const unrelated = await f.start();
    f.parent.sessionId = root;
    f.cancelled.length = 0;
    await f.service.cancelForSession(root, "all");
    expect(new Set(f.cancelled)).toEqual(new Set([a.id, sibling.id, child.id]));
    expect(f.store.get(unrelated.id)!.state).toBe("reserved");
    await expect(f.service.cancelAll(f.caller, { parentSessionId: unrelated.sessionId })).rejects.toMatchObject({ code: "worker-scope" });
  });

  test("nested continuation publishes durable per-run revisions without rewriting the initial outcome", async () => {
    const f = fixture(), w = await f.start();
    const first = await f.complete(w);
    const second = await f.complete(first, "after nested worker returned");
    await f.service.refresh(second);
    const recovered = new WorkerStore(f.dir).get(w.id)!;
    expect(recovered.results!.map(r => r.revision)).toEqual([1, 2]);
    expect(recovered.outcome!.summary).toBe("initial result");
    expect(recovered.latestResult!.outcome.summary).toBe("after nested worker returned");
    expect(recovered.results![0]!.notification.id).toBe(first.results![0]!.notification.id);
    expect(recovered.results![1]!.notification.id).not.toBe(first.results![0]!.notification.id);
  });

  test("wait is observation only; exact acknowledgement is repeatable and does not consume a newer result", async () => {
    const f = fixture(), first = await f.complete(await f.start());
    await f.service.wait(f.caller, [first.id], 0);
    expect(f.store.get(first.id)!.latestResult!.notification.state).toBe("pending");
    await f.complete(first, "new result");
    for (let i = 0; i < 2; i++) expect(await f.service.acknowledgeWait(f.caller, [ref(first)])).toEqual([{ ...ref(first), state: "wait-consumed", acknowledged: true }]);
    const recovered = new WorkerStore(f.dir).get(first.id)!;
    expect(recovered.results!.map(r => r.notification.state)).toEqual(["wait-consumed", "pending"]);
  });

  test("ancestor can inspect but cannot acknowledge a nested worker's immediate-parent notification", async () => {
    const f = fixture(), root = f.parent.sessionId, outer = await f.start();
    f.parent.sessionId = outer.sessionId;
    const inner = await f.complete(await f.start());
    f.parent.sessionId = root;
    expect((await f.service.result(f.caller, inner.id)).id).toBe(inner.id);
    await expect(f.service.acknowledgeWait(f.caller, [ref(inner)])).rejects.toMatchObject({ code: "worker-notification-recipient" });
    expect(f.store.get(inner.id)!.latestResult!.notification.state).toBe("pending");
  });

  test("a restarted delivery reports its claimed revision, never a newer completion", async () => {
    const f = fixture(), first = await f.complete(await f.start());
    const claimed = f.store.claimDelivery(f.delivery())!;
    await f.complete(first, "newer result must stay pending");
    const restarted = new WorkerStore(f.dir);
    const prompt = workerReportPrompt(restarted.deliveries()[0]!, restarted.list());
    expect(prompt).toContain("initial result");
    expect(prompt).not.toContain("newer result must stay pending");
    expect(restarted.claimDelivery(f.delivery())).toBeUndefined();
    restarted.advanceDelivery(claimed.id, "acceptance-unknown");
    restarted.advanceDelivery(claimed.id, "delivered");
    expect(new WorkerStore(f.dir).get(first.id)!.results!.map(r => r.notification.state)).toEqual(["delivered", "pending"]);
    expect(restarted.claimDelivery(f.delivery())!.resultRefs).toEqual([ref(restarted.get(first.id)!, 2)]);
  });

  test("outbox claim wins against late acknowledgement; acknowledgement wins against a later claim", async () => {
    const f = fixture(), a = await f.complete(await f.start());
    f.store.claimDelivery(f.delivery());
    expect(await f.service.acknowledgeWait(f.caller, [ref(a)])).toEqual([{ ...ref(a), state: "claimed", acknowledged: false }]);
    const g = fixture(), b = await g.complete(await g.start());
    await g.service.acknowledgeWait(g.caller, [ref(b)]);
    expect(new WorkerStore(g.dir).claimDelivery(g.delivery())).toBeUndefined();
  });

  test("invalid mixed acknowledgement is atomic and cannot consume a valid prefix", async () => {
    const f = fixture(), w = await f.complete(await f.start());
    expect(() => f.store.acknowledgeResults([ref(w), { ...ref(w), revision: 99 }], f.caller)).toThrow("Unknown worker result");
    expect(new WorkerStore(f.dir).get(w.id)!.latestResult!.notification.state).toBe("pending");
  });

  test("initial and continuation cancellation failures survive restart and native reprojection", async () => {
    const f = fixture(), initial = await f.start(), continued = await f.complete(await f.start());
    f.executing.add(continued.id);
    f.executor.cancel = async () => { throw new Error("executor cancellation unavailable"); };
    await f.service.cancel(f.caller, [initial.id, continued.id]);
    const reply = projectNativeWorkerReply(projectNativeWorkerReply({ workers: new WorkerStore(f.dir).list() }));
    expect(reply.workers!.find(w => w.id === initial.id)).toMatchObject({ state: "cancelling", error: "executor cancellation unavailable" });
    expect(reply.workers!.find(w => w.id === continued.id)).toMatchObject({ continuationCancellation: { error: "executor cancellation unavailable" }, outcome: { summary: "initial result" } });
  });

  test("expired ingress deadline never qualifies a caller or dispatches cancellation", async () => {
    let qualified = false;
    const handler = createNativeWorkerHandler({
      deadline: () => 0,
      resolveCaller: async () => { qualified = true; throw new Error("must not qualify"); },
      operations: {} as NativeWorkerOperations,
    });
    const response = await handler(new Request("http://localhost/native-workers", { method: "POST", body: "{}" }));
    expect(response.status).toBe(504);
    expect(qualified).toBe(false);
  });

  test("native cancel-all derives scope from resolved owner and rejects forged model scope", async () => {
    const f = fixture(), w = await f.start();
    const handler = createNativeWorkerHandler({
      resolveCaller: async () => ({ caller: f.caller, sessionId: f.parent.sessionId }),
      operations: {
        start: (c, input, ctx) => f.service.start(c, input, ctx.assertActive),
        status: (c, ids) => f.service.status(c, ids),
        acknowledge: (c, refs) => f.service.acknowledgeWait(c, refs),
        cancel: (c, ids, descendants) => f.service.cancel(c, ids, descendants),
        cancelAll: (c, scope) => f.service.cancelAll(c, scope),
      },
    });
    const body = { operation: "cancel_all", caller: { version: 1, repository: f.dir, source: { version: 1, harness: "oc", kind: "local-registration", registrationFile: "/sources/test.json" }, authorityId: "test-authority", nativeId: "parent-native" }, invocation: { toolCallId: f.caller.toolCallId, messageId: "message" }, input: {} };
    const request = (value: unknown) => new Request("http://localhost/native-workers", { method: "POST", body: JSON.stringify(value) });
    expect((await handler(request({ ...body, input: { parentSessionId: id() } }))).status).toBe(400);
    expect(f.cancelled).toEqual([]);
    expect((await handler(request(body))).status).toBe(200);
    expect(f.cancelled).toEqual([w.id]);
  });
});
