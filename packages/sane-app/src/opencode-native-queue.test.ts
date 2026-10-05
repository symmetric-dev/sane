import { expect, test } from "bun:test";
import { validateMetadata, type Event, type Run, type Session } from "./history";
import { OpenCodeAdapter, OpenCodeError, type NativeMessage } from "./opencode";
import { OpenCodeRunService, type OpenCodeRunAdapter, type OpenCodeRunDependencies } from "./opencode-run-service";
import type { RunOwner } from "./run-owner";

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
    async boundSaneSession(id) { expect(id).toBe(nativeId); calls.push("bound"); return "Existing native Session block"; },
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

/** The only HTTP boundary is replaced. DELETE/POST alter fixture memory only. */
function httpFixture(history: NativeMessage[] = [], longHistory = false) {
  const adapter = new OpenCodeAdapter("http://127.0.0.1:1");
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const inbox = [{ id: "msg_foreign", sessionID: nativeId, type: "user" }, { id: commandId, sessionID: nativeId, type: "user" }, { id: "msg_compact", sessionID: nativeId, type: "compaction" }];
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

test("queue launch reads existing binding, never idle/select/bind, and durably dispatches exactly once", async () => {
  const f = fixture();
  await f.service.executeNative(f.owner, "followup", true, f.accepted);
  expect(f.calls).toEqual(["bound", "prompt"]);
  expect(f.records.filter(event => event.kind === "context").map(event => event.data)).toEqual([{ type: "session-block", changed: false, text: "Existing native Session block" }]);
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

test("explicit pending cancel in long history deletes only the exact inbox user input before any pagination, never interrupts continuation", async () => {
  const f = fixture(), http = httpFixture([], true);
  f.run.nativePhase = "accepted"; f.owner.submission = Promise.resolve(); f.owner.nativeDispatched = true;
  f.oc.snapshot = http.adapter.snapshot.bind(http.adapter); f.oc.cancelInput = http.adapter.cancelInput.bind(http.adapter); f.oc.cancel = http.adapter.cancel.bind(http.adapter);
  expect(await f.service.interruptCurrent(f.owner)).toEqual({ interrupted: true });
  const deletion = http.calls.findIndex(call => call.method === "DELETE");
  expect(deletion).toBeGreaterThanOrEqual(0);
  expect(http.calls.slice(0, deletion).filter(call => call.path.includes("/message?"))).toHaveLength(0);
  expect(http.calls.filter(call => call.path.includes("/message?"))).toHaveLength(0);
  expect(http.calls.filter(call => call.method !== "GET")).toEqual([{ path: `/api/session/${nativeId}/inbox/${commandId}`, method: "DELETE", body: undefined }]);
  expect(http.inbox.map(input => input.id)).toEqual(["msg_foreign", "msg_compact"]);
  expect(f.run.status).toBe("interrupted"); expect(f.session.lastStatus).toBe("interrupted");
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

test("adapter currentInputId belongs to the latest committed input, not the queued command anchor", async () => {
  const f = httpFixture([message(commandId), message("msg_queue_answer", "assistant"), message("msg_foreign")]);
  f.inbox.splice(1, 1);
  const snapshot = await f.adapter.snapshot(nativeId, commandId, cwd);
  expect(snapshot.currentInputId).toBe("msg_foreign"); expect(snapshot.pending).toBe(false); expect(snapshot.outcome).toBeUndefined();
  expect(snapshot.messages.map(value => value.id)).toEqual([commandId, "msg_queue_answer"]);
});

for (const currentInputId of [commandId, "msg_foreign", undefined]) {
  test(`consumed queue command may interrupt only exact currentInputId (${currentInputId})`, async () => {
    const f = fixture(); f.run.nativePhase = "accepted"; f.owner.submission = Promise.resolve();
    f.oc.snapshot = async () => ({ messages: [message(commandId)], pending: false, currentInputId });
    f.oc.cancel = async (id, beforeCancel) => { beforeCancel?.(); f.calls.push(`interrupt:${id}`); return { interrupted: true }; };
    const exact = currentInputId === commandId;
    expect(await f.service.interruptCurrent(f.owner)).toEqual({ interrupted: exact });
    expect(f.calls).toEqual(exact ? [`interrupt:${nativeId}`] : []);
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
  expect(f.calls).toEqual(["bound"]); expect(f.owner.nativeDispatched).toBe(false); expect(f.run.status).toBe("running");
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
  await expect(f.service.interruptCurrent(f.owner)).rejects.toThrow("withheld after ownership changed");
  expect(f.calls).toEqual([]); expect(f.run.status).toBe("running"); expect(f.records).toHaveLength(0);
});
