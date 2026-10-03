import { expect, test } from "bun:test";
import type { Event, Run, Session } from "./history";
import { OpenCodeError, normalizeMessage, type NativeMessage } from "./opencode";
import { OpenCodeRunService, type OpenCodeRunAdapter, type OpenCodeRunDependencies } from "./opencode-run-service";
import type { RunOwner } from "./run-owner";

const message = (id: string, type = "user"): NativeMessage => ({ id, type, time: { created: 1 }, text: "fixture" });
const completeCompact = (id: string): Awaited<ReturnType<OpenCodeRunAdapter["compactionSnapshot"]>> => ({
  messages: [{ id, type: "compaction", time: { created: 1, completed: 2 }, status: "completed", reason: "manual" }],
  outcome: "succeeded", observed: true, pending: false, active: false,
});

/** Entirely injected: no HTTP, service discovery, processes, real sleeps or model calls. */
function fixture(compact = false) {
  const trace: string[] = [], records: Event[] = [], persisted: Run[] = [], ready: boolean[] = [];
  const run: Run = { runId: "run_fixture", sessionId: "session_fixture", cwd: "/fixture", createdAt: "2026-01-01T00:00:00.000Z", status: "running", nativeCommandId: "msg_request", nativePhase: "preparing",
    ...(compact ? { operation: "compact", compact: { requestId: "request_fixture", nativeRequestId: "msg_request" } } : {}) };
  const session: Session = { sessionId: run.sessionId, harness: "opencode", nativeSessionId: "ses_fixture", cwd: run.cwd, lastRunId: run.runId, lastStatus: "running" };
  const owner: RunOwner = { run, native: true, nativeDispatched: false, done: Promise.resolve(), settled: false };
  const state: { closing: boolean; storageFailed: boolean; currentOwner?: RunOwner; worker: boolean; sleeps: number; onSleep?: () => void } = { closing: false, storageFailed: false, currentOwner: owner, worker: false, sleeps: 0 };
  const oc: OpenCodeRunAdapter = {
    async assertIdle() { trace.push("idle"); },
    async select() { trace.push("select"); },
    async prompt(id, commandId, text, beforeSend) { trace.push("prompt"); beforeSend?.(); return { id: commandId, time: { created: 5 } }; },
    async snapshot(id, commandId, cwd) { trace.push(`snapshot:${commandId}`); return { messages: [message(commandId)], outcome: "succeeded", pending: false }; },
    async interactions() { trace.push("interactions"); return []; },
    async compact(id, requestId, beforeSend) { trace.push("compact"); beforeSend?.(); return { id: "msg_coalesced", sessionID: id, type: "compaction", time: { created: 5 }, delivery: "queue" }; },
    async compactionSnapshot(id, admittedId) { trace.push(`compactSnapshot:${admittedId}`); return completeCompact(admittedId); },
    async activity() { trace.push("activity"); return { session: { id: "ses_fixture", time: { created: 1, updated: 2 } }, active: false, pending: false }; },
    async cancel(id) { trace.push(`interrupt:${id}`); return { interrupted: true }; },
  };
  const deps: OpenCodeRunDependencies = {
    oc, closing: () => state.closing, storageFailed: () => state.storageFailed,
    currentOwner: () => state.currentOwner, session: () => session, events: () => records,
    async emit(run, kind, data) { trace.push(`emit:${kind}`); records.push({ runId: run.runId, sessionId: run.sessionId, seq: records.length + 1, time: run.createdAt, kind, data }); },
    async persist() { trace.push(`persist:${run.nativePhase}:${run.status}`); persisted.push(structuredClone(run)); },
    async execution() { trace.push("execution"); return "/fixture"; },
    async compactExecution() { trace.push("compactExecution"); return "/fixture"; },
    async refreshCompactHistory() { trace.push("refresh"); },
    assertWorkerDeliverySubmission() { trace.push("workerGate"); if (owner.workerDeliveryId && (owner.stopRequested || state.closing || state.storageFailed || state.currentOwner !== owner || session.hidden)) throw new Error("worker withheld"); },
    workerHasRun: () => state.worker,
    async sleep(ms) { trace.push(`sleep:${ms}`); if (++state.sleeps > 12) throw new Error("unexpected endless monitor"); state.onSleep?.(); },
  };
  const service = new OpenCodeRunService(deps);
  const accepted = (value: boolean) => { ready.push(value); trace.push(`ready:${value}`); };
  const statuses = () => records.filter(e => e.kind === "status").map(e => e.data);
  return { service, deps, oc, run, session, owner, state, trace, records, persisted, ready, accepted, statuses };
}

test("prompt publishes preparing, sending and accepted in the original event order", async () => {
  const f = fixture();
  await f.service.executeNative(f.owner, "hello", true, f.accepted);
  expect(f.trace).toEqual(["emit:status", "emit:submission", "persist:preparing:running", "execution", "idle", "select", "persist:sending:running", "execution", "workerGate", "ready:true", "prompt", "persist:accepted:running", "snapshot:msg_request", "emit:message", "emit:status", "persist:accepted:completed", "ready:false"]);
  expect(f.persisted.map(r => [r.nativePhase, r.status])).toEqual([["preparing", "running"], ["sending", "running"], ["accepted", "running"], ["accepted", "completed"]]);
  expect(f.run.nativeAcceptedAt).toBe(5); expect(f.session.lastStatus).toBe("completed");
  expect(f.state.currentOwner).toBe(f.owner); expect(f.owner.settled).toBe(false);
});

test("uncertain prompt is observed once without replay and acceptance precedes message publication", async () => {
  const f = fixture(); let observations = 0;
  f.oc.prompt = async () => { f.trace.push("prompt"); throw new OpenCodeError("lost acknowledgement"); };
  f.oc.snapshot = async () => {
    f.trace.push("snapshot");
    return ++observations === 1 ? { messages: [], outcome: undefined, pending: false } : { messages: [message("msg_request")], outcome: "succeeded", pending: false };
  };
  await f.service.executeNative(f.owner, "hello", false, f.accepted);
  expect(f.trace.filter(t => t === "prompt")).toHaveLength(1); expect(f.state.sleeps).toBe(1);
  expect(f.statuses()).toContainEqual({ status: "running", connection: "unconfirmed", reason: "lost acknowledgement" });
  expect(f.statuses()).toContainEqual({ status: "running", connection: "connected", reason: "Native state reconnected" });
  expect(f.trace.indexOf("persist:accepted:running")).toBeLessThan(f.trace.indexOf("emit:message"));
  expect(f.run.status).toBe("completed");
});

for (const status of [400, 401, 403, 404, 409]) test(`definitive prompt HTTP ${status} rejection fails without observation or retry`, async () => {
  const f = fixture(); f.oc.prompt = async () => { f.trace.push("prompt"); throw new OpenCodeError("rejected", status); };
  await f.service.executeNative(f.owner, "hello", true, f.accepted);
  expect(f.run.status).toBe("failed"); expect(f.run.nativePhase).toBe("sending");
  expect(f.trace.filter(t => t === "prompt")).toHaveLength(1); expect(f.trace.some(t => t.startsWith("snapshot"))).toBe(false);
  expect(f.statuses().at(-1)).toEqual({ status: "failed", reason: "rejected" });
});

for (const outcome of ["succeeded", "failed", "interrupted"] as const) test(`exact normalized command outcome ${outcome} controls prompt status`, async () => {
  const f = fixture(); f.run.nativePhase = "sending";
  f.oc.snapshot = async (id, commandId, cwd) => {
    expect([id, commandId, cwd]).toEqual(["ses_fixture", "msg_request", "/fixture"]);
    return { messages: [message(commandId)], outcome, pending: false };
  };
  await f.service.monitorNative(f.owner);
  expect(f.run.status).toBe(outcome === "succeeded" ? "completed" : outcome);
});

test("worker beforeSend gate can withhold after discovery without an acceptance-unknown event", async () => {
  const f = fixture(); f.owner.workerDeliveryId = "delivery_fixture";
  f.oc.prompt = async (id, commandId, text, beforeSend) => {
    f.session.hidden = true; beforeSend?.(); throw new Error("must not dispatch");
  };
  await f.service.executeNative(f.owner, "worker report", true, f.accepted);
  expect(f.trace.filter(t => t === "workerGate")).toHaveLength(2);
  expect(f.run.status).toBe("failed"); expect(f.run.nativePhase).toBe("sending");
  expect(f.statuses().at(-1)).toEqual({ status: "failed", workerDeliveryNotSubmitted: "delivery_fixture" });
  expect(f.statuses().some(s => typeof s === "object" && s !== null && "connection" in s)).toBe(false);
});

test("worker discovery failure before beforeSend is definitive non-submission", async () => {
  const f = fixture(); f.owner.workerDeliveryId = "delivery_fixture";
  f.oc.prompt = async () => { throw new OpenCodeError("discovery unavailable"); };
  await f.service.executeNative(f.owner, "worker report", true, f.accepted);
  expect(f.run.status).toBe("failed");
  expect(f.statuses().at(-1)).toEqual({ status: "failed", workerDeliveryNotSubmitted: "delivery_fixture" });
});

test("worker accepted beforeSend follows ordinary correlated observation", async () => {
  const f = fixture(); f.owner.workerDeliveryId = "delivery_fixture";
  await f.service.executeNative(f.owner, "worker report", true, f.accepted);
  expect(f.trace.filter(t => t === "workerGate")).toHaveLength(2);
  expect(f.run.status).toBe("completed"); expect(f.statuses()).not.toContainEqual({ status: "completed", workerDeliveryNotSubmitted: "delivery_fixture" });
});

test("worker waiting transitions and repeated snapshots/errors are deduplicated with 1000ms backoff", async () => {
  const f = fixture(); f.state.worker = true; f.run.nativePhase = "sending"; let step = 0, interactions = 0;
  const raw = message("msg_request");
  await f.deps.emit(f.run, "message", normalizeMessage(raw));
  f.oc.snapshot = async () => {
    if (++step <= 2) throw new OpenCodeError("same read failure");
    return { messages: [raw], outcome: step === 6 ? "succeeded" : undefined, pending: false };
  };
  f.oc.interactions = async () => ++interactions < 3 ? [{ id: "permission_fixture", type: "permission", title: "Allow?" }] : [];
  await f.service.monitorNative(f.owner);
  expect(f.records.filter(e => e.kind === "message")).toHaveLength(1);
  const connections: unknown[] = f.statuses().filter(s => typeof s === "object" && s !== null && "connection" in s);
  expect(connections).toEqual([{ status: "running", connection: "unavailable", reason: "same read failure" }, { status: "running", connection: "connected", reason: "Native state reconnected" }]);
  expect(f.statuses()).toContainEqual({ status: "running", workerWaiting: true });
  expect(f.statuses()).toContainEqual({ status: "running", workerWaiting: false });
  expect(f.trace.filter(t => t === "sleep:1000")).toHaveLength(5);
});

for (const flag of ["closing", "storageFailed"] as const) test(`${flag} during native read detaches without terminal publication or interrupt`, async () => {
  const f = fixture(); f.run.nativePhase = "sending";
  f.oc.snapshot = async () => { f.state[flag] = true; return { messages: [message("msg_request")], outcome: "succeeded", pending: false }; };
  await f.service.monitorNative(f.owner);
  expect(f.run.status).toBe("running"); expect(f.run.nativePhase).toBe("sending"); expect(f.records).toHaveLength(0); expect(f.trace).toHaveLength(0);
});

test("live closing during preparation withholds the prompt", async () => {
  const f = fixture(); f.oc.select = async () => { f.state.closing = true; };
  await f.service.executeNative(f.owner, "hello", false, f.accepted);
  expect(f.run.status).toBe("interrupted"); expect(f.run.nativePhase).toBe("preparing"); expect(f.ready).not.toContain(true);
});

test("ordinary /compact text fails before prompt publication", async () => {
  const f = fixture(); await f.service.executeNative(f.owner, " /COMPACT more", true, f.accepted);
  expect(f.run.status).toBe("failed"); expect(f.records.map(e => e.kind)).toEqual(["status"]); expect(f.ready).not.toContain(true);
});

test("interrupt waits for submission before issuing interrupt and waits for its acknowledgement", async () => {
  const f = fixture(); f.run.nativePhase = "sending";
  const submission = Promise.withResolvers<void>(), interrupt = Promise.withResolvers<{ interrupted: boolean }>();
  f.owner.submission = submission.promise;
  f.oc.cancel = async id => { f.trace.push(`interrupt:${id}`); return interrupt.promise; };
  let resolved = false;
  const stop = f.service.interrupt(f.owner).then(value => { resolved = true; return value; });
  expect(f.trace).toEqual([]);
  submission.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(f.trace).toEqual(["interrupt:ses_fixture"]); expect(resolved).toBe(false);
  interrupt.resolve({ interrupted: true }); expect(await stop).toEqual({ interrupted: true });
  expect(f.run.status).toBe("running"); expect(f.state.currentOwner).toBe(f.owner);
});

test("interrupt awaits rejected submission and does not release on native cancellation error", async () => {
  const f = fixture(); const submission = Promise.withResolvers<void>(); f.owner.submission = submission.promise;
  f.oc.cancel = async () => { f.trace.push("interrupt"); throw new OpenCodeError("interrupt unavailable"); };
  const stop = f.service.interrupt(f.owner);
  submission.reject(new OpenCodeError("uncertain submission"));
  await expect(stop).rejects.toThrow("interrupt unavailable"); expect(f.trace).toEqual(["interrupt"]); expect(f.state.currentOwner).toBe(f.owner);
});

test("terminal evidence arriving before submission settles prevents a redundant interrupt", async () => {
  const f = fixture(); const submission = Promise.withResolvers<void>(); f.owner.submission = submission.promise;
  const stop = f.service.interrupt(f.owner); f.run.status = "completed"; submission.resolve();
  expect(await stop).toEqual({ interrupted: false }); expect(f.trace).toEqual([]);
});

test("undispatched preparation and compact beforeSend failure never interrupt", async () => {
  const f = fixture(); expect(await f.service.interrupt(f.owner)).toEqual({ interrupted: false });
  const c = fixture(true); c.run.nativePhase = "sending";
  expect(await c.service.interrupt(c.owner)).toEqual({ interrupted: false });
  c.owner.submission = Promise.resolve();
  expect(await c.service.interrupt(c.owner)).toEqual({ interrupted: false }); expect(c.trace).toEqual([]);
});

test("direct stop acknowledges withheld preparation without interrupting native work", async () => {
  const f = fixture();
  expect(await f.service.interruptCurrent(f.owner)).toEqual({ interrupted: true });
  const c = fixture(true); c.run.nativePhase = "sending";
  expect(await c.service.interruptCurrent(c.owner)).toEqual({ interrupted: true });
  c.owner.submission = Promise.resolve();
  expect(await c.service.interruptCurrent(c.owner)).toEqual({ interrupted: true });
  expect(f.trace).toEqual([]); expect(c.trace).toEqual([]);
});

test("direct stop rechecks the current owner after waiting for submission", async () => {
  const f = fixture(); f.run.nativePhase = "sending";
  const submission = Promise.withResolvers<void>(); f.owner.submission = submission.promise;
  const stop = f.service.interruptCurrent(f.owner);
  f.state.currentOwner = undefined; submission.resolve();
  expect(await stop).toEqual({ interrupted: false }); expect(f.trace).toEqual([]);
});

test("direct stop waits for native submission and returns its cancellation acknowledgement", async () => {
  const f = fixture(); f.run.nativePhase = "sending";
  const submission = Promise.withResolvers<void>(); f.owner.submission = submission.promise;
  const stop = f.service.interruptCurrent(f.owner);
  expect(f.trace).toEqual([]); submission.resolve();
  expect(await stop).toEqual({ interrupted: true }); expect(f.trace).toEqual(["interrupt:ses_fixture"]);
});

test("coalesced compact admitted ID is durable before observation and idle is checked after refresh", async () => {
  const f = fixture(true); await f.service.executeNativeCompact(f.owner);
  expect(f.trace).toEqual(["compactExecution", "idle", "persist:sending:running", "compactExecution", "idle", "compact", "persist:accepted:running", "compactExecution", "compactSnapshot:msg_coalesced", "emit:message", "activity", "refresh", "activity", "emit:status", "persist:accepted:completed"]);
  expect(f.persisted[1]?.compact?.nativeAdmittedId).toBe("msg_coalesced");
  expect(f.run.nativeCommandId).toBe("msg_request"); expect(f.owner.nativeDispatched).toBe(true); expect(f.run.status).toBe("completed");
  expect(f.records.some(e => e.kind === "submission")).toBe(false);
});

test("compact beforeSend checks the live current owner after discovery", async () => {
  const f = fixture(true);
  f.oc.compact = async (id, requestId, beforeSend) => { f.state.currentOwner = undefined; beforeSend?.(); throw new Error("must not dispatch"); };
  await f.service.executeNativeCompact(f.owner);
  expect(f.owner.nativeDispatched).toBe(false); expect(f.run.status).toBe("failed");
  expect(f.statuses()).toContainEqual({ status: "running", operation: "compact", compactNotSubmitted: true });
});

test("compact definitive rejection is journaled before failure and recovered without replay", async () => {
  const f = fixture(true);
  f.oc.compact = async (id, requestId, beforeSend) => { beforeSend?.(); throw new OpenCodeError("conflict", 409); };
  await f.service.executeNativeCompact(f.owner);
  expect(f.statuses()[0]).toEqual({ status: "running", operation: "compact", compactAdmissionRejected: true, nativeStatus: 409, reason: "conflict" });
  f.run.status = "running"; f.trace.length = 0;
  await f.service.recoverNativeCompact(f.owner);
  expect(f.run).toMatchObject({ status: "failed" }); expect(f.trace).toEqual(["emit:status", "persist:sending:failed"]);
});

test("lost compact acknowledgement retains ownership and observes requested ID without resending", async () => {
  const f = fixture(true);
  f.oc.compact = async (id, requestId, beforeSend) => { f.trace.push("compact"); beforeSend?.(); throw new OpenCodeError("lost ack"); };
  f.oc.compactionSnapshot = async (id, admittedId) => { f.trace.push(`compactSnapshot:${admittedId}`); return { messages: [], pending: false, active: false, observed: false }; };
  f.state.onSleep = () => { f.state.closing = true; };
  await f.service.executeNativeCompact(f.owner);
  expect(f.trace.filter(t => t === "compact")).toHaveLength(1); expect(f.trace).toContain("compactSnapshot:msg_request");
  expect(f.run.status).toBe("running"); expect(f.run.nativePhase).toBe("sending"); expect(f.state.currentOwner).toBe(f.owner);
  expect(f.trace.some(t => t.startsWith("interrupt"))).toBe(false);
});

test("compact outcome alone cannot release while other pending input exists", async () => {
  const f = fixture(true); f.run.nativePhase = "accepted";
  f.oc.activity = async () => ({ session: { id: "ses_fixture", time: { created: 1, updated: 2 } }, active: false, pending: true });
  f.state.onSleep = () => { f.state.closing = true; };
  await f.service.monitorNativeCompact(f.owner);
  expect(f.run.status).toBe("running"); expect(f.trace).not.toContain("refresh");
});

test("compact rechecks activity after refresh and never repeats refresh; process status is separate from compact failure", async () => {
  const f = fixture(true); let checks = 0;
  f.oc.compactionSnapshot = async () => ({ messages: [{ id: "msg_request", type: "compaction", time: { created: 1, completed: 2 }, status: "failed" }], outcome: "failed", pending: false, active: false, observed: true });
  f.oc.activity = async () => { f.trace.push("activity"); return { session: { id: "ses_fixture", time: { created: 1, updated: 2 } }, active: ++checks === 2, pending: false }; };
  await f.service.monitorNativeCompact(f.owner);
  expect(f.trace.filter(t => t === "refresh")).toHaveLength(1); expect(f.state.sleeps).toBe(1); expect(f.run.status).toBe("completed");
  expect(f.records.find(e => e.kind === "message")?.data).toMatchObject({ compaction: { lifecycle: "failed" } });
});

test("stopped compact with exact outcome and idle evidence ends interrupted", async () => {
  const f = fixture(true); f.owner.stopRequested = true;
  await f.service.monitorNativeCompact(f.owner); expect(f.run.status).toBe("interrupted");
});

test("preparing compact recovery closes definitive non-submission without native mutation", async () => {
  const f = fixture(true); await f.service.recoverNativeCompact(f.owner);
  expect(f.trace).toEqual(["emit:status", "emit:status", "persist:preparing:failed"]);
  expect(f.statuses()[0]).toEqual({ status: "running", operation: "compact", compactNotSubmitted: true });
});

test("sending compact recovery is read-only and uses the persisted coalesced identity", async () => {
  const f = fixture(true); f.run.nativePhase = "sending"; f.run.compact!.nativeAdmittedId = "msg_recovered";
  await f.service.recoverNativeCompact(f.owner);
  expect(f.trace).toContain("compactSnapshot:msg_recovered"); expect(f.trace).not.toContain("compact"); expect(f.trace).not.toContain("prompt"); expect(f.run.status).toBe("completed");
});
