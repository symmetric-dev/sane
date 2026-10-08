import { expect, spyOn, test } from "bun:test";
import { validateMetadata, type Event, type Run, type Session } from "./history";
import { OpenCodeAdapter, OpenCodeCommandProtocolError, OpenCodeError, OpenCodeQueuedHandoffProtocolError, OpenCodeSourceMismatchError, type NativeMessage, type NativeQueuedHandoffAdmission } from "./opencode";
import { OpenCodeRunService, type OpenCodeRunAdapter, type OpenCodeRunDependencies } from "./opencode-run-service";
import type { RunOwner } from "./run-owner";
import { createDispatchEvidence } from "./dispatch-evidence";

const sessionId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const nativeId = "ses_queue_fixture", commandId = "msg_queue_fixture", cwd = "/fixture";
const time = "2026-10-01T00:00:00.000Z";
const message = (id: string, type = "user", outcome?: string): NativeMessage => ({ id, type, time: { created: 1 }, text: "fixture", ...(outcome ? { outcome } : {}) });
type Snapshot = Awaited<ReturnType<OpenCodeRunAdapter["snapshot"]>>;

/** No discovery, HTTP, process, disk or real timer. Mutations are injected spies. */
function fixture() {
  const run: Run = { runId, sessionId, cwd, createdAt: time, status: "running", nativeDelivery: "queue", nativeCommandId: commandId, nativePhase: "preparing", model: "provider/model", effort: "variant" };
  const session: Session = { sessionId, harness: "opencode", nativeSessionId: nativeId, cwd, lastRunId: runId, lastStatus: "running" };
  const owner: RunOwner = { run, native: true, nativeDispatched: false, done: Promise.resolve(), settled: false };
  const state: { current?: RunOwner; closing: boolean; storageFailed: boolean; sleeps: number; onSleep?: () => void } = { current: owner, closing: false, storageFailed: false, sleeps: 0 };
  const calls: string[] = [], records: Event[] = [], persisted: Run[] = [], ready: boolean[] = [];
  const forbidden = async () => { throw new Error("Queue must not change native configuration or interrupt unrelated work"); };
  const oc: OpenCodeRunAdapter = {
    assertIdle: forbidden, select: forbidden, bindSaneSession: forbidden,
    boundSaneSession: forbidden,
    async prompt(id, inputId, text, beforeSend, delivery) { expect([id, inputId, text, delivery]).toEqual([nativeId, commandId, "followup", "queue"]); beforeSend?.(); calls.push("prompt"); return { id: inputId, time: { created: 7 } }; },
    async snapshot() { return { messages: [message(commandId), message("msg_idle_queue", "idle", "succeeded")], outcome: "succeeded", pending: false }; },
    async interactions() { return []; }, compact: forbidden, compactionSnapshot: forbidden, activity: forbidden, cancel: forbidden,
    async cancelInput(id, inputId, beforeCancel) { expect([id, inputId]).toEqual([nativeId, commandId]); beforeCancel?.(); calls.push("delete-input"); return true; },
  };
  const deps: OpenCodeRunDependencies = {
    oc, closing: () => state.closing, storageFailed: () => state.storageFailed, currentOwner: () => state.current,
    session: () => session, events: requestedId => records.filter(event => event.runId === requestedId),
    async emit(r, kind, data) { records.push({ runId: r.runId, sessionId: r.sessionId, seq: records.length + 1, time, kind, data }); },
    async persist() { persisted.push(structuredClone(run)); },
    async execution() { return cwd; }, async executionContext() { return { executionCheckout: cwd, workstreamId: null, artifactsRoot: null }; },
    takeFrameworkDelivery: () => undefined, compactExecution: forbidden, refreshCompactHistory: forbidden,
    assertWorkerDeliverySubmission() {}, workerHasRun: () => false, saneSession: forbidden,
    async sleep(ms) { expect(ms).toBe(1000); if (++state.sleeps > 5) throw new Error("Unexpected endless monitor"); state.onSleep?.(); },
  };
  const service = new OpenCodeRunService(deps);
  return { run, session, owner, state, calls, records, persisted, ready, oc, deps, service, accepted: (value: boolean) => ready.push(value) };
}

const queueReceipt = (): NativeQueuedHandoffAdmission => ({ id: commandId, sessionID: nativeId, type: "user", delivery: "queue", time: { created: 7 } });
function handoffFixture() {
  const f = fixture(); Object.assign(f.session, { model: f.run.model, effort: f.run.effort });
  f.owner.nativeDeliveryPolicy = "native-queued-handoff";
  f.owner.nativeQueuedHandoff = { origin: "queued-user", requestId: "request_fixture", runId, nativeCommandId: commandId,
    source: { harnessId: "opencode", sessionId, authorityId: null, nativeSessionId: nativeId, cwd } };
  f.owner.beforeSend = () => { f.calls.push("claim-gate"); };
  const evidence = createDispatchEvidence(f.owner.nativeQueuedHandoff, { beforeNative: () => { f.calls.push("durable-intent"); } }, () => { f.state.storageFailed = true; });
  f.owner.dispatchEvidence = evidence;
  f.oc.preflightNativeSession = async (id, directory) => { expect([id, directory]).toEqual([nativeId, cwd]); f.calls.push("binding-read"); };
  f.oc.promptQueuedHandoff = async (id, inputId, text, guard) => {
    expect([id, inputId, text]).toEqual([nativeId, commandId, "followup"]); guard?.();
    expect(f.persisted.at(-1)).toMatchObject({ nativeDelivery: "queue", nativePhase: "sending", nativeCommandId: commandId });
    f.calls.push("handoff-prompt"); return queueReceipt();
  };
  return { ...f, evidence };
}

/** The only HTTP boundary is replaced. DELETE/POST alter fixture memory only. */
function httpFixture(history: NativeMessage[] = [], longHistory = false) {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1");
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const inbox = [{ id: "msg_foreign", sessionID: nativeId, type: "user", delivery: "queue", time: { created: 1 } },
    { id: commandId, sessionID: nativeId, type: "user", delivery: "queue", time: { created: 2 } },
    { id: "msg_compact", sessionID: nativeId, type: "compaction", delivery: "queue", time: { created: 3 } }];
  adapter.request = async <T>(path: string, method = "GET", body?: unknown, beforeSend?: () => void): Promise<T> => {
    beforeSend?.(); calls.push({ path, method, body });
    let result: unknown;
    if (path === `/api/session/${nativeId}/inbox/${commandId}` && method === "DELETE") { inbox.splice(inbox.findIndex(input => input.id === commandId), 1); }
    else if (method !== "GET") throw new Error(`Unexpected mutation: ${method} ${path}`);
    else if (path.endsWith("/inbox")) result = { data: [...inbox] };
    else if (path.endsWith("/active")) result = { data: { [nativeId]: { type: "running" } } };
    else if (path === `/api/session/${nativeId}/message/${commandId}`) {
      const exact = history.find(value => value.id === commandId);
      if (!exact) throw new OpenCodeError("Fixture exact message absent", 404);
      result = { data: exact };
    }
    else if (path.includes("/message?")) result = longHistory
      ? { data: Array.from({ length: 100 }, (_, index) => message(`msg_old_${calls.length}_${index}`, "assistant")), cursor: { next: `page_${calls.length}` } }
      : { data: [...history].reverse(), cursor: {} };
    else if (path === `/api/session/${nativeId}`) result = { data: { id: nativeId, location: { directory: cwd }, metadata: { saneContext: { sessionID: nativeId, text: "Native bound block" } }, outcome: "succeeded", time: { created: 0, updated: 2, idle: 2 } } };
    else throw new Error(`Unexpected read: ${path}`);
    return result as T;
  };
  return { adapter, calls, inbox };
}

test("metadata permits native queued prompts but rejects CC and compact queue runs", () => {
  const f = fixture();
  const metadata = { sessions: [{ ...f.session, authorityId: `sane-native-v1:oc:${"a".repeat(64)}` }], runs: [f.run], reconciliationRequired: false };
  expect(validateMetadata(structuredClone(metadata)).runs[0]?.nativeDelivery).toBe("queue");
  const cc = structuredClone(metadata);
  Object.assign(cc.sessions[0]!, { harness: "claude-code", nativeSessionId: "33333333-3333-4333-8333-333333333333", authorityId: `sane-native-v1:cc:${"a".repeat(64)}` });
  expect(() => validateMetadata(cc)).toThrow("Corrupt metadata");
  const compact = structuredClone(metadata);
  Object.assign(compact.runs[0]!, { operation: "compact", compact: { requestId: "44444444-4444-4444-8444-444444444444", nativeRequestId: commandId } });
  expect(() => validateMetadata(compact)).toThrow("Corrupt metadata");
});

test("adapter prompt queues the caller's stable ID exactly once and does not add delivery to ordinary prompts", async () => {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1");
  const requests: unknown[] = []; let gates = 0;
  adapter.request = async <T>(path: string, method = "GET", body?: unknown, beforeSend?: () => void): Promise<T> => {
    beforeSend?.(); requests.push([path, method, body]); return { data: { id: commandId, time: { created: 7 } } } as T;
  };
  expect(await adapter.prompt(nativeId, commandId, "followup", () => gates++, "queue")).toEqual({ id: commandId, time: { created: 7 } });
  expect(gates).toBe(1);
  expect(requests).toEqual([[`/api/session/${nativeId}/prompt`, "POST", { id: commandId, text: "followup", delivery: "queue" }]]);
  await adapter.prompt(nativeId, commandId, "ordinary");
  expect(requests[1]).toEqual([`/api/session/${nativeId}/prompt`, "POST", { id: commandId, text: "ordinary" }]);
});

test("queue launch never reads/binds Session metadata or selects/idles and durably dispatches exactly once", async () => {
  const f = fixture();
  await f.service.executeNative(f.owner, "followup", true, f.accepted);
  expect(f.calls).toEqual(["prompt"]);
  expect(f.records.filter(event => event.kind === "context")).toEqual([]);
  expect(f.records.filter(event => event.kind === "submission").map(event => event.data)).toEqual([{ messageId: commandId, text: "followup" }]);
  expect(f.persisted.map(run => [run.nativeDelivery, run.nativeCommandId, run.nativePhase, run.status])).toEqual([
    ["queue", commandId, "preparing", "running"], ["queue", commandId, "sending", "running"], ["queue", commandId, "accepted", "running"], ["queue", commandId, "accepted", "completed"],
  ]);
  expect(f.owner.nativeDispatched).toBe(true); expect(f.run.nativeAcceptedAt).toBe(7); expect(f.ready).toContain(true);
});

test("boundSaneSession observes native metadata without any write", async () => {
  const f = httpFixture();
  expect(await f.adapter.boundSaneSession(nativeId)).toBe("Native bound block");
  expect(f.calls).toEqual([{ path: `/api/session/${nativeId}`, method: "GET", body: undefined }]);
});

test("pending exact queue input ignores old completed history and performs zero paginated reads", async () => {
  const f = httpFixture([message("msg_previous"), message("msg_previous_idle", "idle", "succeeded")], true);
  const snapshot = await f.adapter.snapshot(nativeId, commandId, cwd);
  expect(snapshot.messages).toEqual([]); expect(snapshot.pending).toBe(true); expect(snapshot.outcome).toBeUndefined();
  expect(f.calls.filter(call => call.path.includes("/message?"))).toHaveLength(0);
});

test("pending queue monitor retains ownership without terminal evidence or relabeling the previous completed run", async () => {
  const f = fixture(), http = httpFixture([message("msg_previous"), message("msg_previous_idle", "idle", "succeeded")]);
  const previous: Event = { runId: "33333333-3333-4333-8333-333333333333", sessionId, seq: 1, time, kind: "status", data: { status: "completed" } };
  f.records.push(previous); const before = structuredClone(previous);
  f.run.nativePhase = "accepted"; f.oc.snapshot = http.adapter.snapshot.bind(http.adapter);
  f.state.onSleep = () => { if (f.state.sleeps === 3) f.state.closing = true; };
  await f.service.monitorNative(f.owner);
  expect(f.state.sleeps).toBe(3); expect(f.state.current).toBe(f.owner);
  expect(f.run.status).toBe("running"); expect(f.run.endedAt).toBeUndefined(); expect(f.records.filter(event => event.runId === previous.runId)).toEqual([before]);
  expect(f.records.filter(event => event.kind === "message")).toHaveLength(0);
  const statuses = f.records.filter(event => event.kind === "status" && event.runId === runId).map(event => event.data);
  expect(statuses).toHaveLength(1); expect(statuses[0]).toMatchObject({ status: "running", connection: "connected" });
  expect(http.calls.filter(call => call.path.includes("/message?"))).toHaveLength(0);
});

test("lost queue acknowledgement observes pending input without replaying dispatch", async () => {
  const f = fixture(); let attempts = 0;
  f.oc.prompt = async (_id, _command, _text, beforeSend) => { beforeSend?.(); attempts++; throw new OpenCodeError("lost acknowledgement"); };
  f.oc.snapshot = async () => ({ messages: [], pending: true });
  f.state.onSleep = () => { f.state.closing = true; };
  await f.service.executeNative(f.owner, "followup", true, f.accepted);
  expect(attempts).toBe(1); expect(f.run.status).toBe("running"); expect(f.run.nativePhase).toBe("accepted"); expect(f.state.current).toBe(f.owner);
});

test("disappearance from inbox without an exact command terminal boundary cannot complete the queue run", async () => {
  const f = fixture(), http = httpFixture([message("msg_previous"), message("msg_previous_idle", "idle", "succeeded")]);
  f.run.nativePhase = "accepted"; f.oc.snapshot = http.adapter.snapshot.bind(http.adapter);
  f.state.onSleep = () => {
    if (f.state.sleeps === 1) http.inbox.splice(1, 1);
    if (f.state.sleeps === 3) f.state.closing = true;
  };
  await f.service.monitorNative(f.owner);
  expect(f.run.status).toBe("running"); expect(f.run.endedAt).toBeUndefined(); expect(f.state.current).toBe(f.owner);
  expect(f.records.filter(event => event.kind === "message")).toHaveLength(0);
  expect(f.records.filter(event => event.kind === "status").every(event => (event.data as { status: string }).status === "running")).toBe(true);
  expect(f.state.sleeps).toBe(3);
});

test("explicit pending cancel in long history requests exact deletion without terminal proof or pagination", async () => {
  const f = fixture(), http = httpFixture([], true);
  f.run.nativePhase = "accepted"; f.owner.submission = Promise.resolve(); f.owner.nativeDispatched = true;
  f.oc.snapshot = http.adapter.snapshot.bind(http.adapter); f.oc.cancelInput = http.adapter.cancelInput.bind(http.adapter); f.oc.cancel = http.adapter.cancel.bind(http.adapter);
  expect(await f.service.interruptCurrent(f.owner)).toEqual({ interrupted: false });
  const deletion = http.calls.findIndex(call => call.method === "DELETE");
  expect(deletion).toBeGreaterThanOrEqual(0);
  expect(http.calls.slice(0, deletion).filter(call => call.path.includes("/message?"))).toHaveLength(0);
  expect(http.calls.filter(call => call.path.includes("/message?"))).toHaveLength(0);
  expect(http.calls.filter(call => call.method !== "GET")).toEqual([{ path: `/api/session/${nativeId}/inbox/${commandId}`, method: "DELETE", body: undefined }]);
  expect(http.inbox.map(input => input.id)).toEqual(["msg_foreign", "msg_compact"]);
  expect(f.run.status).toBe("running"); expect(f.service.readPendingCancellation(f.owner)).toEqual({ ready: false });
});

for (const wrong of [{ type: "synthetic", sessionID: nativeId }, { type: "compaction", sessionID: nativeId }, { type: "user", sessionID: "ses_foreign" }]) {
  test(`cancelInput rejects exact ID with wrong inbox ownership ${JSON.stringify(wrong)}`, async () => {
    const f = httpFixture(); Object.assign(f.inbox[1]!, wrong);
    await expect(f.adapter.cancelInput(nativeId, commandId)).rejects.toThrow("not this session's prompt");
    expect(f.calls.every(call => call.method === "GET")).toBe(true);
  });
}

test("cancelInput does not delete a different pending user when the exact ID is absent", async () => {
  const f = httpFixture(); f.inbox.splice(1, 1);
  expect(await f.adapter.cancelInput(nativeId, commandId)).toBe(false);
  expect(f.calls.every(call => call.method === "GET")).toBe(true);
});

test("cancelInput cannot claim cancellation if native consumption won the DELETE race", async () => {
  const f = httpFixture([message(commandId)]);
  expect(await f.adapter.cancelInput(nativeId, commandId)).toBe(false);
  expect(f.calls.filter(call => call.method !== "GET")).toEqual([{ path: `/api/session/${nativeId}/inbox/${commandId}`, method: "DELETE", body: undefined }]);
  expect(f.calls.filter(call => call.path.includes("/message?"))).toHaveLength(0);
});

for (const phase of ["before", "after"] as const) for (const defect of ["malformed", "duplicate"] as const) {
  test(`strict cancelInput refuses ${defect} inbox entry ${phase} DELETE`, async () => {
    const f = httpFixture(); let reads = 0;
    const request = f.adapter.request.bind(f.adapter);
    f.adapter.request = async <T>(path: string, method = "GET", body?: unknown, beforeSend?: () => void): Promise<T> => {
      const result = await request<T>(path, method, body, beforeSend);
      if (path.endsWith("/inbox") && ++reads === (phase === "before" ? 1 : 2)) {
        const data = (result as { data: unknown[] }).data;
        data.push(defect === "malformed" ? { id: 7 } : { ...queueReceipt() });
        if (defect === "duplicate" && phase === "after") data.push({ ...queueReceipt() });
      }
      return result;
    };
    await expect(f.adapter.cancelInput(nativeId, commandId, undefined, "native-queued-handoff")).rejects.toBeInstanceOf(OpenCodeCommandProtocolError);
    expect(f.calls.filter(call => call.method === "DELETE")).toHaveLength(phase === "before" ? 0 : 1);
    expect(f.calls.filter(call => call.path === `/api/session/${nativeId}/message/${commandId}`)).toHaveLength(phase === "before" ? 0 : 1);
  });
}

test("strict cancelInput cannot certify valid-looking removal after DELETE and exact message 404", async () => {
  const f = httpFixture();
  expect(await f.adapter.cancelInput(nativeId, commandId, undefined, "native-queued-handoff")).toBe(false);
  expect(f.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
  expect(f.inbox.some(input => input.id === commandId)).toBe(false);
});

test("strict Stop retains owner after disappearance and later exact terminal settles independently", async () => {
  const f = handoffFixture(), history: NativeMessage[] = [], http = httpFixture(history);
  f.run.nativePhase = "accepted"; f.owner.nativeDispatched = true; f.owner.submission = Promise.resolve(); f.owner.stopRequested = true;
  f.oc.snapshot = http.adapter.snapshot.bind(http.adapter); f.oc.cancelInput = http.adapter.cancelInput.bind(http.adapter);
  expect(await f.service.interruptCurrent(f.owner)).toEqual({ interrupted: false });
  expect(f.run.status).toBe("running"); expect(f.service.readPendingCancellation(f.owner)).toEqual({ ready: false });
  f.state.onSleep = () => { if (f.state.sleeps === 1) history.push(message(commandId), message("msg_terminal", "idle", "succeeded")); };
  await f.service.monitorNative(f.owner);
  expect(f.run.status).toBe("completed"); expect(f.service.readPendingCancellation(f.owner)).toEqual({ ready: false });
});

for (const defect of ["malformed", "duplicate"] as const) test(`strict Stop with ${defect} post-DELETE inbox cannot release ownership`, async () => {
  const f = handoffFixture(), http = httpFixture(); let inboxReads = 0;
  const request = http.adapter.request.bind(http.adapter);
  http.adapter.request = async <T>(path: string, method = "GET", body?: unknown, beforeSend?: () => void): Promise<T> => {
    const result = await request<T>(path, method, body, beforeSend);
    if (path.endsWith("/inbox") && ++inboxReads === 3) {
      const data = (result as { data: unknown[] }).data;
      data.push(defect === "malformed" ? { id: 7 } : { ...queueReceipt() }, ...(defect === "duplicate" ? [{ ...queueReceipt() }] : []));
    }
    return result;
  };
  f.run.nativePhase = "accepted"; f.owner.nativeDispatched = true; f.owner.submission = Promise.resolve();
  f.oc.snapshot = http.adapter.snapshot.bind(http.adapter); f.oc.cancelInput = http.adapter.cancelInput.bind(http.adapter);
  expect(await f.service.interruptCurrent(f.owner)).toEqual({ interrupted: false });
  expect(f.service.readPendingCancellation(f.owner)).toEqual({ ready: false });
  expect(f.run.status).toBe("running"); expect(f.state.current).toBe(f.owner);
  expect(http.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
});

test("adapter currentInputId belongs to the latest committed input, not the queued command anchor", async () => {
  const f = httpFixture([message(commandId), message("msg_queue_answer", "assistant"), message("msg_foreign")]);
  f.inbox.splice(1, 1);
  const snapshot = await f.adapter.snapshot(nativeId, commandId, cwd);
  expect(snapshot.currentInputId).toBe("msg_foreign"); expect(snapshot.pending).toBe(false); expect(snapshot.outcome).toBeUndefined();
  expect(snapshot.messages.map(value => value.id)).toEqual([commandId, "msg_queue_answer"]);
});

for (const currentInputId of [commandId, "msg_foreign", undefined]) {
  test(`consumed queue command refuses session-wide interrupt even for currentInputId (${currentInputId})`, async () => {
    const f = fixture(); f.run.nativePhase = "accepted"; f.owner.submission = Promise.resolve();
    f.oc.snapshot = async () => ({ messages: [message(commandId)], pending: false, currentInputId });
    f.oc.cancel = async (id, beforeCancel) => { beforeCancel?.(); f.calls.push(`interrupt:${id}`); return { interrupted: true }; };
    expect(await f.service.interruptCurrent(f.owner)).toEqual({ interrupted: false });
    expect(f.calls).toEqual([]);
    expect(f.run.status).toBe("running");
  });
}

test("currentInputId alone without the exact committed user is not permission to interrupt", async () => {
  const f = fixture(); f.run.nativePhase = "accepted";
  f.oc.snapshot = async () => ({ messages: [message(commandId, "synthetic")], pending: false, currentInputId: commandId });
  expect(await f.service.interruptCurrent(f.owner)).toEqual({ interrupted: false }); expect(f.calls).toEqual([]);
});

test("a queue input consumed during cancellation cannot interrupt a newer external input", async () => {
  const f = fixture(); f.run.nativePhase = "accepted"; let reads = 0;
  f.oc.snapshot = async () => ++reads === 1 ? { messages: [], pending: true } : { messages: [message(commandId)], pending: false, currentInputId: "msg_foreign" };
  f.oc.cancelInput = async () => { f.calls.push("delete-raced"); return false; };
  expect(await f.service.interruptCurrent(f.owner)).toEqual({ interrupted: false });
  expect(f.calls).toEqual(["delete-raced"]); expect(f.run.status).toBe("running");
});

test("a completed queued input never interrupts newer native work", async () => {
  const f = fixture(); f.run.nativePhase = "accepted";
  expect(await f.service.interruptCurrent(f.owner)).toEqual({ interrupted: false }); expect(f.calls).toEqual([]);
});

test("queue monitor drops terminal snapshots read after ownership changed", async () => {
  const f = fixture(); f.run.nativePhase = "accepted";
  f.oc.snapshot = async () => { f.state.current = undefined; return { messages: [message(commandId)], pending: false, outcome: "succeeded" }; };
  await f.service.monitorNative(f.owner);
  expect(f.run.status).toBe("running"); expect(f.session.lastStatus).toBe("running"); expect(f.records).toHaveLength(0); expect(f.persisted).toHaveLength(0);
});

test("queue submission admission gate withholds after discovery changes ownership", async () => {
  const f = fixture();
  f.oc.prompt = async (_id, _input, _text, beforeSend) => { f.state.current = undefined; beforeSend?.(); f.calls.push("unexpected-dispatch"); throw new Error("unreachable"); };
  await f.service.executeNative(f.owner, "followup", true, f.accepted);
  expect(f.calls).toEqual([]); expect(f.owner.nativeDispatched).toBe(false); expect(f.run.status).toBe("running");
  expect(f.records.filter(event => event.kind === "status").map(event => event.data)).not.toContainEqual({ status: "failed" });
});

test("stale queued cancellation rechecks owner after waiting for submission", async () => {
  const f = fixture(), submission = Promise.withResolvers<void>(); f.run.nativePhase = "sending"; f.owner.submission = submission.promise;
  const stop = f.service.interruptCurrent(f.owner); f.state.current = undefined; submission.resolve();
  expect(await stop).toEqual({ interrupted: false }); expect(f.calls).toEqual([]);
});

for (const consumed of [false, true]) test(`queued cancellation gate prevents native mutation if ownership changes after discovery (consumed=${consumed})`, async () => {
  const f = fixture(); f.run.nativePhase = "accepted";
  f.oc.snapshot = async (): Promise<Snapshot> => ({ messages: consumed ? [message(commandId)] : [], pending: !consumed, currentInputId: consumed ? commandId : undefined });
  f.oc.cancelInput = async (_id, _command, beforeCancel) => { f.state.current = undefined; beforeCancel?.(); f.calls.push("unexpected-delete"); return true; };
  f.oc.cancel = async (_id, beforeCancel) => { f.state.current = undefined; beforeCancel?.(); f.calls.push("unexpected-interrupt"); return { interrupted: true }; };
  if (consumed) expect(await f.service.interruptCurrent(f.owner)).toEqual({ interrupted: false });
  else await expect(f.service.interruptCurrent(f.owner)).rejects.toThrow("withheld after ownership changed");
  expect(f.calls).toEqual([]); expect(f.run.status).toBe("running"); expect(f.records).toHaveLength(0);
});

test("explicit handoff keeps captured App launch settings and never selects/idles/delivers startup context", async () => {
  const f = handoffFixture();
  await f.service.executeNative(f.owner, "followup", false, f.accepted);
  expect(f.calls).toEqual(["binding-read", "claim-gate", "durable-intent", "handoff-prompt"]);
  expect(f.records.filter(event => event.kind === "context")).toEqual([]);
  expect(f.records.find(event => event.kind === "launch")?.data).toMatchObject({ model: f.session.model, variant: f.session.effort });
  expect(f.evidence.snapshot()).toMatchObject({ submission: "submitted", nativeAcceptance: "accepted" });
  expect(f.run.status).toBe("completed"); expect(f.state.current).toBe(f.owner); expect(f.owner.settled).toBe(false);
});

for (const invalid of ["delivery", "harness", "origin", "request", "run", "command", "source", "settings", "hooks", "gate", "api", "compact", "worker"] as const) test(`explicit handoff withholds inconsistent ${invalid} before HTTP`, async () => {
  const f = handoffFixture();
  if (invalid === "delivery") f.run.nativeDelivery = undefined;
  if (invalid === "harness") f.session.harness = "claude-code";
  if (invalid === "origin") (f.owner.nativeQueuedHandoff as any).origin = "worker-report";
  if (invalid === "request") f.owner.nativeQueuedHandoff = { ...f.owner.nativeQueuedHandoff!, requestId: "" };
  if (invalid === "run") f.owner.nativeQueuedHandoff = { ...f.owner.nativeQueuedHandoff!, runId: "foreign" };
  if (invalid === "command") f.owner.nativeQueuedHandoff = { ...f.owner.nativeQueuedHandoff!, nativeCommandId: "msg_foreign" };
  if (invalid === "source") f.session.cwd = "/foreign";
  if (invalid === "settings") f.run.model = "provider/changed";
  if (invalid === "hooks") f.owner.dispatchEvidence = undefined;
  if (invalid === "gate") f.owner.beforeSend = undefined;
  if (invalid === "api") f.oc.promptQueuedHandoff = undefined;
  if (invalid === "compact") f.run.operation = "compact";
  if (invalid === "worker") f.owner.workerDeliveryId = "worker";
  await f.service.executeNative(f.owner, "followup", true, f.accepted);
  expect(f.calls).toEqual([]); expect(f.owner.nativeDispatched).toBe(false); expect(f.run.status).toBe("failed");
  expect(f.evidence.snapshot().submission).toBe("not-submitted");
});

test("post-claim foreign busy race retains the one exact native head until consumption and terminal, without steer/fallback/replay", async () => {
  const f = handoffFixture(); let reads = 0;
  f.oc.preflightNativeSession = async () => { f.calls.push("foreign-busy-binding-valid"); };
  f.oc.snapshot = async (id, exact, directory, policy) => {
    expect([id, exact, directory, policy]).toEqual([nativeId, commandId, cwd, "native-queued-handoff"]);
    expect(f.run.status).toBe("running"); expect(f.state.current).toBe(f.owner);
    return ++reads === 1 ? { messages: [], pending: true, pendingInput: queueReceipt() }
      : { messages: [message(commandId), message("msg_terminal", "idle", "succeeded")], pending: false, outcome: "succeeded" };
  };
  await f.service.executeNative(f.owner, "followup", true, f.accepted);
  expect(reads).toBe(2); expect(f.calls.filter(call => call === "handoff-prompt")).toHaveLength(1);
  expect(f.run.status).toBe("completed"); expect(f.state.current).toBe(f.owner);
});

const badReceipts = [
  { id: "msg_foreign" }, { sessionID: "ses_foreign" }, { type: "synthetic" }, { delivery: "steer" },
  { time: { created: NaN } }, { time: { created: Infinity } }, { sessionID: undefined }, { delivery: undefined },
];
for (const bad of badReceipts) test(`injected handoff ack mismatch ${JSON.stringify(bad)} stays unknown even with a later exact terminal`, async () => {
  const f = handoffFixture(); let sends = 0;
  f.oc.promptQueuedHandoff = async (_id, _exact, _text, guard) => { guard?.(); sends++; return { ...queueReceipt(), ...bad } as NativeQueuedHandoffAdmission; };
  f.state.onSleep = () => { f.state.closing = true; };
  await f.service.executeNative(f.owner, "followup", true, f.accepted);
  expect(f.run.status).toBe("running"); expect(f.run.nativePhase).toBe("sending"); expect(f.run.nativeAcceptedAt).toBeUndefined();
  expect(f.evidence.snapshot()).toMatchObject({ submission: "unknown", nativeAcceptance: "unknown" });
  expect(f.owner.nativeHandoffProtocolUnsafe).toBe(true);
  // Recovered observation uses the journaled refusal even without its transient flag.
  f.owner.nativeHandoffProtocolUnsafe = undefined; f.state.closing = false;
  await f.service.executeNative(f.owner, "followup", true, f.accepted);
  expect(sends).toBe(1); expect(f.run.status).toBe("running");
});

for (const status of [400, 401, 403, 404, 409]) test(`handoff HTTP ${status} alone is not definitive native non-acceptance`, async () => {
  const f = handoffFixture(); let sends = 0;
  f.oc.promptQueuedHandoff = async (_id, _exact, _text, guard) => { guard?.(); sends++; throw new OpenCodeError("unknown native receipt", status); };
  f.oc.snapshot = async () => ({ messages: [], pending: false, outcome: "succeeded" });
  f.state.onSleep = () => { f.state.closing = true; };
  await f.service.executeNative(f.owner, "followup", true, f.accepted);
  expect(sends).toBe(1); expect(f.owner.nativeDispatched).toBe(true); expect(f.run.status).toBe("running");
  expect(f.evidence.snapshot()).toMatchObject({ submission: "unknown", nativeAcceptance: "unknown" });
});

for (const pendingInput of [undefined, { id: commandId }, queueReceipt()]) test(`only typed exact queue pending DTO proves acceptance (${JSON.stringify(pendingInput)})`, async () => {
  const f = handoffFixture();
  f.oc.promptQueuedHandoff = async (_id, _exact, _text, guard) => { guard?.(); throw new OpenCodeError("missing ack"); };
  f.oc.snapshot = async () => ({ messages: [], pending: true, pendingInput });
  f.state.onSleep = () => { f.state.closing = true; };
  await f.service.executeNative(f.owner, "followup", true, f.accepted);
  const accepted = pendingInput !== undefined && "delivery" in pendingInput;
  expect(f.run.nativePhase).toBe(accepted ? "accepted" : "sending");
  expect(f.evidence.snapshot().nativeAcceptance).toBe(accepted ? "accepted" : "unknown");
  expect(f.run.status).toBe("running"); expect(f.records.filter(event => event.kind === "message")).toEqual([]);
});

for (const wrong of [{ sessionID: "ses_foreign" }, { type: "compaction" }, { delivery: "steer" }]) test(`pending handoff contradiction ${JSON.stringify(wrong)} is sticky and cannot borrow completion`, async () => {
  const f = handoffFixture(); let reads = 0;
  f.oc.promptQueuedHandoff = async (_id, _exact, _text, guard) => { guard?.(); throw new OpenCodeError("lost ack"); };
  f.oc.snapshot = async () => ++reads === 1 ? { messages: [], pending: true, pendingInput: { ...queueReceipt(), ...wrong } }
    : { messages: [message(commandId)], pending: false, outcome: "succeeded" };
  f.state.onSleep = () => { if (f.state.sleeps === 2) f.state.closing = true; };
  await f.service.executeNative(f.owner, "followup", true, f.accepted);
  expect(f.run.status).toBe("running"); expect(f.evidence.snapshot().nativeAcceptance).toBe("unknown");
  expect(f.owner.nativeHandoffProtocolUnsafe).toBe(true);
});

test("lost handoff ack plus consumed user anchor cannot reconstruct actual delivery policy", async () => {
  const f = handoffFixture();
  f.oc.promptQueuedHandoff = async (_id, _exact, _text, guard) => { guard?.(); throw new OpenCodeError("lost ack"); };
  f.state.onSleep = () => { f.state.closing = true; };
  await f.service.executeNative(f.owner, "followup", true, f.accepted);
  expect(f.run.status).toBe("running"); expect(f.run.nativePhase).toBe("sending"); expect(f.evidence.snapshot().nativeAcceptance).toBe("unknown");
});

test("fresh handoff binding source mismatch is withheld, without native mutation or queue fallback", async () => {
  const f = handoffFixture(); f.oc.preflightNativeSession = async () => { throw new OpenCodeSourceMismatchError("native directory changed"); };
  await f.service.executeNative(f.owner, "followup", true, f.accepted);
  expect(f.calls).toEqual([]); expect(f.evidence.snapshot().submission).toBe("not-submitted"); expect(f.owner.nativeDispatched).toBe(false);
});

for (const bad of badReceipts) test(`typed adapter checks actual handoff ack fields ${JSON.stringify(bad)} after exactly one POST`, async () => {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1"); let sends = 0;
  adapter.request = async <T>(path: string, method = "GET", body?: unknown, guard?: () => void): Promise<T> => {
    expect([path, method, body]).toEqual([`/api/session/${nativeId}/prompt`, "POST", { id: commandId, text: "followup", delivery: "queue" }]);
    guard?.(); sends++; return { data: { ...queueReceipt(), ...bad } } as T;
  };
  await expect(adapter.promptQueuedHandoff(nativeId, commandId, "followup")).rejects.toBeInstanceOf(OpenCodeQueuedHandoffProtocolError);
  expect(sends).toBe(1);
});

test("typed adapter valid handoff receipt is checked before acceptance evidence", async () => {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1");
  adapter.request = async <T>(): Promise<T> => ({ data: queueReceipt() } as T);
  expect(await adapter.promptQueuedHandoff(nativeId, commandId, "followup")).toEqual(queueReceipt());
});

test("strict snapshot preserves exact pending DTO without inferring missing delivery", async () => {
  const f = httpFixture();
  expect(await f.adapter.snapshot(nativeId, commandId, cwd, "native-queued-handoff")).toMatchObject({ pending: true, pendingInput: { id: commandId, sessionID: nativeId, type: "user" } });
  expect(f.calls.filter(call => call.path.includes("/message?"))).toHaveLength(0);
});

for (const mode of ["disconnect", "timeout"] as const) test(`handoff post-headers body ${mode} retains unknown original ID and never replays after inbox disappearance`, async () => {
  const f = handoffFixture(), adapter = new OpenCodeAdapter("http://127.0.0.1:1"); let sends = 0, observations = 0;
  f.oc.promptQueuedHandoff = (id, exact, text, guard) => adapter.promptQueuedHandoff(id, exact, text, guard);
  const request = adapter.request.bind(adapter);
  adapter.request = <T>(path: string, method = "GET", body?: unknown, guard?: () => void) => request<T>(path, method, body, guard, 20);
  const transport = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    expect(JSON.parse(init?.body as string)).toEqual({ id: commandId, text: "followup", delivery: "queue" });
    sends++; return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"data":')); if (mode === "timeout") init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true }); },
      pull(controller) { if (mode === "disconnect") controller.error(new Error("offline body disconnected")); },
    }));
  }, { preconnect: fetch.preconnect }));
  f.oc.snapshot = async (_id, exact) => { expect(exact).toBe(commandId); return ++observations === 1 ? { messages: [], pending: true } : { messages: [], pending: false, outcome: "succeeded" }; };
  f.state.onSleep = () => { if (f.state.sleeps === 2) f.state.closing = true; };
  try {
    await f.service.executeNative(f.owner, "followup", true, f.accepted);
    expect(sends).toBe(1); expect(observations).toBe(2); expect(f.run.status).toBe("running"); expect(f.owner.nativeDispatched).toBe(true);
    expect(f.evidence.snapshot()).toMatchObject({ submission: "unknown", nativeAcceptance: "unknown" });
    f.state.closing = false; f.state.onSleep = () => { f.state.closing = true; };
    await f.service.executeNative(f.owner, "followup", true, f.accepted); expect(sends).toBe(1);
  } finally { transport.mockRestore(); }
});

for (const race of ["pending-delete", "consumed", "foreign-after-consumption"] as const) test(`explicit handoff Stop remains exact and does not advance/replay (${race})`, async () => {
  const f = handoffFixture(); f.run.nativePhase = "accepted"; f.owner.nativeDispatched = true; f.owner.submission = Promise.resolve(); let reads = 0;
  f.oc.snapshot = async () => ++reads === 1 ? { messages: [], pending: true, pendingInput: queueReceipt() } : { messages: [message(commandId)], pending: false, currentInputId: race === "consumed" ? commandId : "msg_foreign" };
  f.oc.cancelInput = async (_id, exact, guard) => { expect(exact).toBe(commandId); guard?.(); f.calls.push("delete-exact"); return race === "pending-delete"; };
  f.oc.cancel = async (_id, guard) => { guard?.(); f.calls.push("explicit-interrupt"); return { interrupted: true }; };
  expect(await f.service.interruptCurrent(f.owner)).toEqual({ interrupted: false });
  expect(f.calls).toEqual(["delete-exact"]);
  expect(f.state.current).toBe(f.owner); expect(f.calls).not.toContain("handoff-prompt");
});

for (const change of ["owner", "stop", "cancel", "source", "authority", "settings", "policy", "command", "claim", "storage"] as const) test(`handoff final gate withholds post-discovery ${change} without any native mutation`, async () => {
  const f = handoffFixture(); let sends = 0;
  f.oc.promptQueuedHandoff = async (_id, _exact, _text, guard) => {
    if (change === "owner") f.state.current = undefined;
    if (change === "stop") f.owner.stopRequested = true;
    if (change === "cancel") f.owner.cancelling = true;
    if (change === "source") f.session.nativeSessionId = "ses_other";
    if (change === "authority") f.session.authorityId = "foreign";
    if (change === "settings") f.session.model = "provider/foreign";
    if (change === "policy") f.owner.nativeDeliveryPolicy = "idle-only";
    if (change === "command") f.run.nativeCommandId = "msg_other";
    if (change === "claim") f.owner.beforeSend = () => { throw new Error("claim removed"); };
    if (change === "storage") f.state.storageFailed = true;
    guard?.(); sends++; return queueReceipt();
  };
  await f.service.executeNative(f.owner, "followup", true, f.accepted);
  expect(sends).toBe(0); expect(f.owner.nativeDispatched).toBe(false); expect(f.evidence.snapshot().submission).toBe("not-submitted");
  expect(f.run.nativeAcceptedAt).toBeUndefined();
});

test("known wrong-policy native input cannot become an accepted handoff via operator Stop's consumed anchor", async () => {
  const f = handoffFixture(); f.run.nativePhase = "sending"; f.owner.nativeDispatched = true; f.owner.nativeHandoffProtocolUnsafe = true;
  f.oc.snapshot = async () => ({ messages: [message(commandId)], pending: false, currentInputId: commandId });
  expect(await f.service.interruptCurrent(f.owner)).toEqual({ interrupted: false }); expect(f.calls).toEqual([]);
});

test("fresh native binding is read-only even if foreign preferences changed", async () => {
  const f = httpFixture();
  const request = f.adapter.request.bind(f.adapter);
  f.adapter.request = async <T>(path: string, method = "GET"): Promise<T> => {
    const result = await request<{ data: Record<string, unknown> }>(path, method);
    result.data.agent = "foreign-selected-agent"; result.data.model = { providerID: "foreign", id: "model", variant: "foreign" };
    return result as T;
  };
  await f.adapter.preflightNativeSession(nativeId, cwd);
  expect(f.calls).toEqual([{ path: `/api/session/${nativeId}`, method: "GET", body: undefined }]);
  await expect(f.adapter.preflightNativeSession(nativeId, "/different")).rejects.toBeInstanceOf(OpenCodeSourceMismatchError);
  expect(f.calls.every(call => call.method === "GET")).toBe(true);
});

test("handoff eligibility is ordinary queued-user origin, not a broad conversation-role exclusion", async () => {
  const f = handoffFixture(); f.session.agentKind = f.run.agentKind = "worker"; f.session.agent = f.run.agent = "scout";
  await f.service.executeNative(f.owner, "followup", true, f.accepted);
  expect(f.run.status).toBe("completed"); expect(f.evidence.snapshot().nativeAcceptance).toBe("accepted");
});

for (const change of ["command", "source", "authority", "directory"] as const) test(`handoff monitoring retains original ownership on claimed ${change} drift without borrowing a terminal`, async () => {
  const f = handoffFixture(); f.run.nativePhase = "accepted"; let reads = 0;
  if (change === "command") f.run.nativeCommandId = "msg_previous";
  if (change === "source") f.session.nativeSessionId = "ses_foreign";
  if (change === "authority") f.session.authorityId = "foreign";
  if (change === "directory") f.session.cwd = "/foreign";
  f.oc.snapshot = async () => { reads++; return { messages: [message("msg_previous")], pending: false, outcome: "succeeded" }; };
  f.state.onSleep = () => { f.state.closing = true; };
  await f.service.monitorNative(f.owner);
  expect(reads).toBe(0); expect(f.run.status).toBe("running"); expect(f.state.current).toBe(f.owner);
  expect(f.records.filter(event => event.kind === "message")).toHaveLength(0);
});

function driftSession(f: ReturnType<typeof handoffFixture>, replacement: boolean, change: "source" | "settings" | "authority" | "directory") {
  const session = replacement ? { ...f.session } : f.session;
  if (change === "source") session.nativeSessionId = "ses_unrelated_B";
  if (change === "settings") session.model = "provider/changed";
  if (change === "authority") session.authorityId = "authority_B";
  if (change === "directory") session.cwd = "/unrelated_B";
  if (replacement) f.deps.session = () => session;
}

for (const replacement of [false, true]) for (const change of ["source", "settings", "authority", "directory"] as const) {
  test(`suspended handoff terminal discards fresh ${replacement ? "replacement" : "mutable"} session ${change} drift`, async () => {
    const f = handoffFixture(), observed = Promise.withResolvers<Snapshot>(), entered = Promise.withResolvers<void>();
    f.run.nativePhase = "accepted"; f.owner.nativeDispatched = true;
    let reads = 0;
    f.oc.snapshot = async (id, exact, directory, policy) => {
      expect([id, exact, directory, policy]).toEqual([nativeId, commandId, cwd, "native-queued-handoff"]);
      reads++; entered.resolve(); return observed.promise;
    };
    f.state.onSleep = () => { f.state.closing = true; };
    const monitor = f.service.monitorNative(f.owner);
    await entered.promise; driftSession(f, replacement, change);
    observed.resolve({ messages: [message(commandId), message("msg_exact_terminal", "idle", "succeeded")], pending: false, outcome: "succeeded" });
    await monitor;
    expect(reads).toBe(1); expect(f.run.status).toBe("running"); expect(f.run.endedAt).toBeUndefined();
    expect(f.state.current).toBe(f.owner); expect(f.records.filter(event => event.kind === "message")).toEqual([]);
    expect(f.records.filter(event => event.kind === "status").every(event => (event.data as { status: string }).status === "running")).toBe(true);
    expect(f.persisted).toEqual([]); expect(f.calls).toEqual([]);
    f.state.closing = false;
    await expect(f.service.executeNative(f.owner, "followup", true, f.accepted)).rejects.toBeInstanceOf(OpenCodeSourceMismatchError);
    expect(await f.service.interruptCurrent(f.owner)).toEqual({ interrupted: false });
    expect(reads).toBe(1); expect(f.calls).toEqual([]);
  });
}

for (const replacement of [false, true]) for (const change of ["source", "settings"] as const) for (const stage of ["pending", "consumed"] as const) {
  test(`Stop discards suspended ${stage} proof on ${replacement ? "replacement" : "mutable"} session ${change} drift`, async () => {
    const f = handoffFixture(), observed = Promise.withResolvers<Snapshot>(), entered = Promise.withResolvers<void>();
    f.run.nativePhase = "accepted"; f.owner.nativeDispatched = true; f.owner.submission = Promise.resolve();
    let reads = 0;
    f.oc.snapshot = async (id, exact, directory, policy) => {
      expect([id, exact, directory, policy]).toEqual([nativeId, commandId, cwd, "native-queued-handoff"]);
      if (++reads === 1) { entered.resolve(); return observed.promise; }
      return { messages: [], pending: true, pendingInput: queueReceipt() };
    };
    f.oc.cancelInput = async (id, exact, guard) => { expect([id, exact]).toEqual([nativeId, commandId]); guard?.(); f.calls.push(`delete:${id}`); return false; };
    f.oc.cancel = async (id, guard) => { guard?.(); f.calls.push(`interrupt:${id}`); return { interrupted: true }; };
    const stop = f.service.interruptCurrent(f.owner);
    await entered.promise; driftSession(f, replacement, change);
    observed.resolve(stage === "pending" ? { messages: [], pending: true, pendingInput: queueReceipt() }
      : { messages: [message(commandId)], pending: false, currentInputId: commandId });
    expect(await stop).toEqual({ interrupted: false });
    expect(f.calls).toEqual([]);
    expect(f.run.status).toBe("running"); expect(f.state.current).toBe(f.owner); expect(f.records).toEqual([]); expect(f.persisted).toEqual([]);
  });
}

for (const replacement of [false, true]) for (const change of ["source", "settings"] as const) for (const consumed of [false, true]) {
  test(`Stop callback after discovery denies ${replacement ? "replacement" : "mutable"} ${change} drift (consumed=${consumed})`, async () => {
    const f = handoffFixture(), discovery = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    f.run.nativePhase = "accepted"; f.owner.nativeDispatched = true;
    f.oc.snapshot = async () => ({ messages: consumed ? [message(commandId)] : [], pending: !consumed, currentInputId: consumed ? commandId : undefined, ...(!consumed ? { pendingInput: queueReceipt() } : {}) });
    f.oc.cancelInput = async (id, exact, guard) => {
      expect([id, exact]).toEqual([nativeId, commandId]); entered.resolve(); await discovery.promise;
      guard?.(); f.calls.push(`delete:${id}`); return true;
    };
    f.oc.cancel = async (id, guard) => {
      expect(id).toBe(nativeId); entered.resolve(); await discovery.promise;
      guard?.(); f.calls.push(`interrupt:${id}`); return { interrupted: true };
    };
    const stop = f.service.interruptCurrent(f.owner);
    if (consumed) {
      expect(await stop).toEqual({ interrupted: false }); expect(f.calls).toEqual([]);
      return;
    }
    await entered.promise; driftSession(f, replacement, change); discovery.resolve();
    await expect(stop).rejects.toBeInstanceOf(OpenCodeSourceMismatchError);
    expect(f.calls).toEqual([]); expect(f.run.status).toBe("running"); expect(f.records).toEqual([]); expect(f.persisted).toEqual([]);
  });
}

for (const consumed of [false, true]) test(`Stop does not finalize cancellation proof returned after fresh session drift (consumed=${consumed})`, async () => {
  const f = handoffFixture(), result = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  f.run.nativePhase = "accepted"; f.owner.nativeDispatched = true;
  f.oc.snapshot = async () => ({ messages: consumed ? [message(commandId)] : [], pending: !consumed, currentInputId: consumed ? commandId : undefined, ...(!consumed ? { pendingInput: queueReceipt() } : {}) });
  f.oc.cancelInput = async (id, exact, guard) => { expect([id, exact]).toEqual([nativeId, commandId]); guard?.(); f.calls.push(`delete:${id}`); entered.resolve(); await result.promise; return true; };
  f.oc.cancel = async (id, guard) => { expect(id).toBe(nativeId); guard?.(); f.calls.push(`interrupt:${id}`); entered.resolve(); await result.promise; return { interrupted: true }; };
  const stop = f.service.interruptCurrent(f.owner);
  if (consumed) {
    expect(await stop).toEqual({ interrupted: false }); expect(f.calls).toEqual([]);
    return;
  }
  await entered.promise; driftSession(f, true, "source"); result.resolve();
  expect(await stop).toEqual({ interrupted: false }); expect(f.run.status).toBe("running"); expect(f.persisted).toEqual([]); expect(f.records).toEqual([]);
  expect(f.calls).toEqual([`${consumed ? "interrupt" : "delete"}:${nativeId}`]);
});

const invalidPolicies = [undefined, "idle-only", "future-policy", null, {}, 7] as const;
for (const policy of invalidPolicies) test(`handoff association rejects missing or invalid explicit policy ${JSON.stringify(policy)} before preparation`, async () => {
  const f = handoffFixture(); (f.owner as any).nativeDeliveryPolicy = policy;
  let preparations = 0;
  f.deps.execution = async () => { preparations++; return cwd; };
  await f.service.executeNative(f.owner, "followup", false, f.accepted);
  expect(f.run.status).toBe("failed"); expect(preparations).toBe(0); expect(f.calls).toEqual([]);
  expect(f.records.filter(event => event.kind === "submission" || event.kind === "launch" || event.kind === "context")).toEqual([]);
  expect(f.owner.nativeDispatched).toBe(false); expect(f.evidence.snapshot().submission).toBe("not-submitted");
});

for (const policy of ["future-policy", null, {}, 7] as const) test(`unassociated unknown policy ${JSON.stringify(policy)} cannot select, deliver startup, or submit a legacy prompt`, async () => {
  const f = fixture(); f.run.nativeDelivery = undefined; (f.owner as any).nativeDeliveryPolicy = policy;
  let nativeEffects = 0;
  f.oc.assertIdle = f.oc.select = async () => { nativeEffects++; };
  f.oc.prompt = async () => { nativeEffects++; throw new Error("Unexpected prompt"); };
  f.oc.deliverSaneSession = async () => { nativeEffects++; };
  f.deps.saneSession = async () => "startup";
  await f.service.executeNative(f.owner, "followup", false, f.accepted);
  expect(nativeEffects).toBe(0); expect(f.calls).toEqual([]); expect(f.run.status).toBe("failed");
});

for (const stage of ["execution", "preflight"] as const) for (const eraseAssociation of [false, true]) for (const policy of [undefined, "idle-only", "future-policy", null, {}] as const) {
  test(`policy ${JSON.stringify(policy)} changed during suspended ${stage}, association erased=${eraseAssociation}, never falls back`, async () => {
    const f = handoffFixture(), wait = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    if (stage === "execution") f.deps.execution = async () => { entered.resolve(); await wait.promise; return cwd; };
    else f.oc.preflightNativeSession = async () => { entered.resolve(); await wait.promise; };
    const execution = f.service.executeNative(f.owner, "followup", false, f.accepted);
    await entered.promise; (f.owner as any).nativeDeliveryPolicy = policy;
    if (eraseAssociation) f.owner.nativeQueuedHandoff = undefined;
    wait.resolve(); await execution;
    expect(f.calls).toEqual([]); expect(f.owner.nativeDispatched).toBe(false); expect(f.run.status).toBe("failed");
    expect(f.evidence.snapshot().submission).toBe("not-submitted"); expect(f.records.filter(event => event.kind === "context")).toEqual([]);
    expect(f.ready).not.toContain(true);
  });
}

for (const operation of ["monitor", "stop"] as const) test(`accepted immutable handoff ${operation} cannot escape strict pins by removing both association and policy`, async () => {
  const f = handoffFixture(), snapshot = Promise.withResolvers<Snapshot>(), entered = Promise.withResolvers<void>();
  f.run.nativePhase = "accepted"; f.owner.nativeDispatched = true;
  let reads = 0;
  f.oc.snapshot = async () => { reads++; entered.resolve(); return snapshot.promise; };
  f.state.onSleep = () => { f.state.closing = true; };
  const observing = operation === "monitor" ? f.service.monitorNative(f.owner) : f.service.interruptCurrent(f.owner);
  await entered.promise; f.owner.nativeQueuedHandoff = undefined; f.owner.nativeDeliveryPolicy = undefined;
  snapshot.resolve({ messages: [message(commandId)], pending: false, currentInputId: commandId, ...(operation === "monitor" ? { outcome: "succeeded" as const } : {}) });
  await observing;
  expect(f.run.status).toBe("running"); expect(f.calls).toEqual([]); expect(f.persisted).toEqual([]);
  f.state.closing = false;
  await expect(f.service.executeNative(f.owner, "followup", false, f.accepted)).rejects.toThrow("explicit native-queued-handoff policy");
  expect(reads).toBe(1); expect(f.calls).toEqual([]);
});

test("frozen first-entry command and claim cannot be coherently repinned to a prior completed command during a snapshot", async () => {
  const f = handoffFixture(), snapshot = Promise.withResolvers<Snapshot>(), entered = Promise.withResolvers<void>();
  f.run.nativePhase = "accepted"; f.owner.nativeDispatched = true;
  f.oc.snapshot = async (id, exact) => { expect([id, exact]).toEqual([nativeId, commandId]); entered.resolve(); return snapshot.promise; };
  f.state.onSleep = () => { f.state.closing = true; };
  const monitor = f.service.monitorNative(f.owner);
  await entered.promise;
  f.run.nativeCommandId = "msg_prior_completed";
  f.owner.nativeQueuedHandoff = { ...f.owner.nativeQueuedHandoff!, nativeCommandId: "msg_prior_completed" };
  snapshot.resolve({ messages: [message("msg_prior_completed")], pending: false, outcome: "succeeded" });
  await monitor;
  expect(f.run.status).toBe("running"); expect(f.run.endedAt).toBeUndefined(); expect(f.records.filter(event => event.kind === "message")).toEqual([]);
  expect(f.calls).toEqual([]); expect(f.persisted).toEqual([]);
});

for (const change of ["source", "settings"] as const) test(`Stop pins survive suspended submission settlement and deny fresh ${change} drift before any observation`, async () => {
  const f = handoffFixture(), submission = Promise.withResolvers<void>();
  f.run.nativePhase = "sending"; f.owner.nativeDispatched = true; f.owner.submission = submission.promise;
  let reads = 0; f.oc.snapshot = async () => { reads++; return { messages: [message(commandId)], pending: false, currentInputId: commandId }; };
  const stop = f.service.interruptCurrent(f.owner);
  driftSession(f, true, change); submission.resolve();
  expect(await stop).toEqual({ interrupted: false }); expect(reads).toBe(0); expect(f.calls).toEqual([]); expect(f.run.status).toBe("running");
});

for (const change of ["source", "settings"] as const) test(`handoff acknowledgement cannot mark accepted after suspended ${change} drift`, async () => {
  const f = handoffFixture(), receipt = Promise.withResolvers<NativeQueuedHandoffAdmission>(), entered = Promise.withResolvers<void>();
  f.oc.promptQueuedHandoff = async (id, exact, _text, guard) => {
    expect([id, exact]).toEqual([nativeId, commandId]); guard?.(); f.calls.push("handoff-prompt"); entered.resolve(); return receipt.promise;
  };
  let reads = 0; f.oc.snapshot = async () => { reads++; return { messages: [message(commandId)], pending: false, outcome: "succeeded" }; };
  f.state.onSleep = () => { f.state.closing = true; };
  const execution = f.service.executeNative(f.owner, "followup", true, f.accepted);
  await entered.promise; driftSession(f, true, change); receipt.resolve(queueReceipt()); await execution;
  expect(f.run.status).toBe("running"); expect(f.run.nativePhase).toBe("sending"); expect(f.run.nativeAcceptedAt).toBeUndefined(); expect(reads).toBe(0);
  expect(f.evidence.snapshot()).toMatchObject({ submission: "unknown", nativeAcceptance: "unknown" });
  expect(f.calls).toEqual(["binding-read", "claim-gate", "durable-intent", "handoff-prompt"]);
});

for (const change of ["current-run", "run-object", "run-status", "settled", "cancelling"] as const) test(`handoff suspended terminal respects live ${change} guard`, async () => {
  const f = handoffFixture(), snapshot = Promise.withResolvers<Snapshot>(), entered = Promise.withResolvers<void>();
  f.run.nativePhase = "accepted"; f.owner.nativeDispatched = true;
  f.oc.snapshot = async () => { entered.resolve(); return snapshot.promise; };
  f.state.onSleep = () => { f.state.closing = true; };
  const monitor = f.service.monitorNative(f.owner);
  await entered.promise;
  if (change === "current-run") f.session.lastRunId = "run_unrelated";
  if (change === "run-object") f.owner.run = { ...f.run, runId: "run_unrelated" };
  if (change === "run-status") f.run.status = "interrupted";
  if (change === "settled") f.owner.settled = true;
  if (change === "cancelling") f.owner.cancelling = true;
  snapshot.resolve({ messages: [message(commandId)], pending: false, outcome: "succeeded" }); await monitor;
  expect(f.run.status).toBe(change === "run-status" ? "interrupted" : "running"); expect(f.owner.run.status).not.toBe("completed");
  expect(f.run.endedAt).toBeUndefined(); expect(f.calls).toEqual([]); expect(f.persisted).toEqual([]); expect(f.records.filter(event => event.kind === "message")).toEqual([]);
});

test("handoff configuration cannot be repinned by changing the run and replacement session together during observation", async () => {
  const f = handoffFixture(), snapshot = Promise.withResolvers<Snapshot>(), entered = Promise.withResolvers<void>();
  f.run.nativePhase = "accepted"; f.owner.nativeDispatched = true;
  f.oc.snapshot = async () => { entered.resolve(); return snapshot.promise; };
  f.state.onSleep = () => { f.state.closing = true; };
  const monitor = f.service.monitorNative(f.owner);
  await entered.promise; driftSession(f, true, "settings"); f.run.model = "provider/changed";
  snapshot.resolve({ messages: [message(commandId)], pending: false, outcome: "succeeded" }); await monitor;
  expect(f.run.status).toBe("running"); expect(f.persisted).toEqual([]); expect(f.calls).toEqual([]); expect(f.records.filter(event => event.kind === "message")).toEqual([]);
});

for (const operation of ["monitor", "stop"] as const) test(`native observed-source mismatch during ${operation} retains local ownership without global storage failure`, async () => {
  const f = handoffFixture(); f.run.nativePhase = "accepted"; f.owner.nativeDispatched = true;
  f.oc.snapshot = async () => { throw new OpenCodeSourceMismatchError("Native observed source differs from pinned A"); };
  f.state.onSleep = () => { f.state.closing = true; };
  if (operation === "monitor") await f.service.monitorNative(f.owner);
  else await expect(f.service.interruptCurrent(f.owner)).rejects.toBeInstanceOf(OpenCodeSourceMismatchError);
  expect(f.state.storageFailed).toBe(false); expect(f.owner.nativeHandoffProtocolUnsafe).toBeUndefined();
  expect(f.run.status).toBe("running"); expect(f.state.current).toBe(f.owner); expect(f.calls).toEqual([]); expect(f.persisted).toEqual([]);
});

test("queued Stop cannot escape to session-wide legacy cancellation by erasing delivery, policy, and claim while submission settles", async () => {
  const f = handoffFixture(), submission = Promise.withResolvers<void>();
  f.run.nativePhase = "sending"; f.owner.nativeDispatched = true; f.owner.submission = submission.promise;
  f.oc.cancel = async id => { f.calls.push(`unexpected-interrupt:${id}`); return { interrupted: true }; };
  let reads = 0; f.oc.snapshot = async () => { reads++; return { messages: [], pending: true }; };
  const stop = f.service.interruptCurrent(f.owner);
  f.run.nativeDelivery = undefined; f.owner.nativeDeliveryPolicy = undefined; f.owner.nativeQueuedHandoff = undefined;
  driftSession(f, true, "source"); submission.resolve();
  expect(await stop).toEqual({ interrupted: false }); expect(f.calls).toEqual([]); expect(reads).toBe(0);
  expect(f.run.status).toBe("running"); expect(f.persisted).toEqual([]);
});
