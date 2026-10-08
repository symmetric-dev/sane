import { expect, test } from "bun:test";
import type { Event, Run, Session } from "./history";
import { OpenCodeRunService, type OpenCodeRunAdapter, type OpenCodeRunDependencies, type VerifyCompletionRequest } from "./opencode-run-service";
import type { RunOwner } from "./run-owner";

function fixture() {
  const run: Run = { runId: "run_fixture", sessionId: "session_fixture", cwd: "/fixture", status: "running", createdAt: "2026-01-01T00:00:00Z", nativeCommandId: "msg_request", nativePhase: "accepted" };
  const session: Session = { sessionId: run.sessionId, harness: "opencode", authorityId: "fixture", nativeSessionId: "ses_fixture", cwd: run.cwd, lastRunId: run.runId, lastStatus: "running" };
  const finished = Promise.withResolvers<void>();
  const owner: RunOwner = { run, native: true, settled: false, done: finished.promise, stopRequested: true };
  const records: Event[] = [{ runId: run.runId, sessionId: run.sessionId, seq: 1, time: run.createdAt, kind: "status", data: { completionBoundary: { messageId: "msg_synthetic", type: "synthetic" } } }];
  const trace: string[] = [];
  const state: { current?: RunOwner; storageFailed: boolean; afterRead?: () => void; failEmit?: boolean; failPersist?: boolean; active?: boolean; autoRelease?: boolean } = { current: owner, storageFailed: false };
  const forbidden = async (): Promise<never> => { throw new Error("Native mutation forbidden"); };
  const oc: OpenCodeRunAdapter = {
    assertIdle: forbidden, select: forbidden, prompt: forbidden, snapshot: forbidden, interactions: forbidden,
    compact: forbidden, compactionSnapshot: forbidden, cancel: forbidden,
    async activity() { trace.push("activity"); state.afterRead?.(); return { session: { id: "ses_fixture", location: { directory: "/fixture" }, time: { created: 1, updated: 5, idle: 5 }, outcome: "succeeded" }, active: !!state.active, pending: false }; },
    async history() { trace.push("history"); return { activity: "idle", messages: [], rawMessages: [
      { id: "msg_request", type: "user", time: { created: 2 } },
      { id: "msg_synthetic", type: "synthetic", time: { created: 3 } },
      { id: "msg_idle", type: "idle", time: { created: 5 }, outcome: "succeeded" },
    ] }; },
  };
  const deps: OpenCodeRunDependencies = {
    oc, closing: () => false, storageFailed: () => state.storageFailed, currentOwner: () => state.current, session: () => session, events: () => records,
    async emit(_run, kind, data) { trace.push(`emit:${kind}:${run.status}`); if (state.failEmit) throw new Error("disk unavailable"); records.push({ runId: run.runId, sessionId: run.sessionId, seq: records.length + 1, time: run.createdAt, kind, data }); },
    async persist() {
      trace.push(`persist:${run.status}`); if (state.failPersist) throw new Error("metadata unavailable");
      if (run.status !== "running" && state.autoRelease !== false) void (async () => {
        await owner.completionTerminalization?.done;
        owner.settled = true; state.current = undefined; finished.resolve();
      })();
    },
    execution: forbidden, executionContext: forbidden, compactExecution: forbidden, refreshCompactHistory: forbidden,
    assertWorkerDeliverySubmission() {}, workerHasRun: () => false, completionInboxEmpty: async () => true, saneSession: async () => null, sleep: async () => {}, takeFrameworkDelivery: () => undefined,
  };
  const request: VerifyCompletionRequest = { requestId: "00000000-0000-4000-8000-000000000001", nativeSessionId: "ses_fixture", nativeCommandId: "msg_request", confirm: true, reason: "Verify stuck research completion" };
  return { run, session, owner, state, records, trace, oc, deps, request, service: new OpenCodeRunService(deps) };
}

test("operator repair permits historical Stop, reads only, audits before terminal and waits for lifecycle release", async () => {
  const f = fixture();
  const result = await f.service.verifyCompletion(f.run, f.request);
  expect(result.status).toBe("completed");
  expect(result.evidence.proofKind).toBe("operator-verified");
  expect(result.evidence.native.boundaryIds).toEqual([{ messageId: "msg_synthetic", type: "synthetic" }]);
  expect(f.trace).toEqual(["activity", "history", "activity", "emit:context:running", "persist:running", "emit:status:completed", "persist:completed"]);
  expect(f.state.current).toBeUndefined(); expect(f.owner.settled).toBe(true);
});

test("matching terminal retry returns durable audit without reads or duplicate events; conflicts reject", async () => {
  const f = fixture(), first = await f.service.verifyCompletion(f.run, f.request);
  f.state.current = undefined; f.trace.length = 0;
  expect(await f.service.verifyCompletion(f.run, f.request)).toEqual(first);
  expect(f.trace).toEqual([]);
  await expect(f.service.verifyCompletion(f.run, { ...f.request, reason: "changed" })).rejects.toThrow("Conflicting");
  await expect(f.service.verifyCompletion(f.run, { ...f.request, requestId: "00000000-0000-4000-8000-000000000002" })).rejects.toThrow("Conflicting");
});

test("stale owner/source after native await cannot audit or finish", async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => { f.state.current = undefined; }, (f: ReturnType<typeof fixture>) => { f.session.authorityId = "foreign"; }, (f: ReturnType<typeof fixture>) => { f.run.nativeCommandId = "msg_foreign"; }]) {
    const f = fixture(); f.state.afterRead = () => change(f);
    await expect(f.service.verifyCompletion(f.run, f.request)).rejects.toThrow();
    expect(f.run.status).toBe("running"); expect(f.records).toHaveLength(1); expect(f.trace).toEqual(["activity"]);
  }
});

test("failed audit or metadata persistence never finishes", async () => {
  for (const field of ["failEmit", "failPersist", "storageFailed"] as const) {
    const f = fixture(); f.state[field] = true;
    await expect(f.service.verifyCompletion(f.run, f.request)).rejects.toThrow();
    expect(f.run.status).toBe("running"); expect(f.trace.some(item => item === "emit:status:completed")).toBe(false);
  }
});

test("audit retry rechecks native evidence and does not append duplicate audit", async () => {
  const f = fixture(); f.state.failPersist = true;
  await expect(f.service.verifyCompletion(f.run, f.request)).rejects.toThrow();
  f.state.failPersist = false;
  expect((await f.service.verifyCompletion(f.run, f.request)).status).toBe("completed");
  expect(f.records.filter(event => event.kind === "context")).toHaveLength(1);
  expect(f.trace.filter(item => item === "history")).toHaveLength(2);
});

test("active cancellation, compaction, workers and queued claims are ineligible", async () => {
  const changes = [
    (f: ReturnType<typeof fixture>) => { f.owner.cancelling = true; },
    (f: ReturnType<typeof fixture>) => { f.run.operation = "compact"; },
    (f: ReturnType<typeof fixture>) => { f.owner.workerDeliveryId = "delivery"; },
    (f: ReturnType<typeof fixture>) => { f.deps.workerHasRun = () => true; },
    (f: ReturnType<typeof fixture>) => { f.session.agentKind = "worker"; },
    (f: ReturnType<typeof fixture>) => { f.run.agentKind = "worker"; },
    (f: ReturnType<typeof fixture>) => { f.run.nativeDelivery = "queue"; },
    (f: ReturnType<typeof fixture>) => { f.owner.nativeDeliveryPolicy = "native-queued-handoff"; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f);
    await expect(f.service.verifyCompletion(f.run, f.request)).rejects.toThrow();
    expect(f.trace).toEqual([]); expect(f.run.status).toBe("running");
  }
});

test("active native or missing boundary cannot finish; explicit confirmation required", async () => {
  const f = fixture(); f.state.active = true;
  await expect(f.service.verifyCompletion(f.run, f.request)).rejects.toThrow("busy");
  f.state.active = false; f.records.length = 0;
  await expect(f.service.verifyCompletion(f.run, f.request)).rejects.toThrow("boundary");
  await expect(f.service.verifyCompletion(f.run, { ...f.request, confirm: false } as unknown as VerifyCompletionRequest)).rejects.toThrow("confirmation");
  expect(f.run.status).toBe("running");
});

test("scope is revalidated after audit persistence and before terminal mutation", async () => {
  const f = fixture(); let valid = true;
  f.deps.persist = async () => { valid = false; };
  await expect(f.service.verifyCompletion(f.run, f.request, () => { if (!valid) throw new Error("scope changed"); })).rejects.toThrow("scope changed");
  expect(f.run.status).toBe("running"); expect(f.records.filter(event => event.kind === "context")).toHaveLength(1);
});

test("literal inbox verification rejects even startup synthetic input", async () => {
  const f = fixture(); f.deps.completionInboxEmpty = async () => false;
  await expect(f.service.verifyCompletion(f.run, f.request)).rejects.toThrow("inbox");
  expect(f.run.status).toBe("running"); expect(f.trace).toEqual([]); expect(f.records).toHaveLength(1);
});

test("concurrent operator requests cannot duplicate the audit or terminal transition", async () => {
  const f = fixture(), barrier = Promise.withResolvers<boolean>();
  f.deps.completionInboxEmpty = () => barrier.promise;
  const first = f.service.verifyCompletion(f.run, f.request);
  await expect(f.service.verifyCompletion(f.run, f.request)).rejects.toThrow("already in progress");
  barrier.resolve(true);
  expect((await first).status).toBe("completed");
  expect(f.records.filter(event => event.kind === "context")).toHaveLength(1);
});

test("monitor and release join terminal journal and metadata; verification also waits for original owner.done", async () => {
  const f = fixture(); f.state.autoRelease = false;
  const snapshot = Promise.withResolvers<Awaited<ReturnType<OpenCodeRunAdapter["snapshot"]>>>();
  const statusStarted = Promise.withResolvers<void>(), journal = Promise.withResolvers<void>();
  const persistStarted = Promise.withResolvers<void>(), metadata = Promise.withResolvers<void>();
  const finalizer = Promise.withResolvers<void>(), monitorExited = Promise.withResolvers<void>();
  f.oc.snapshot = () => snapshot.promise;
  const emit = f.deps.emit, persist = f.deps.persist;
  f.deps.emit = async (run, kind, data) => {
    if (kind === "status" && run.status === "completed") { statusStarted.resolve(); await journal.promise; }
    await emit(run, kind, data);
  };
  f.deps.persist = async () => {
    if (f.run.status === "completed") { persistStarted.resolve(); await metadata.promise; }
    await persist();
  };
  let exited = false, responded = false;
  f.owner.done = f.service.monitorNative(f.owner).then(async () => {
    exited = true; monitorExited.resolve(); await finalizer.promise;
    f.owner.settled = true;
    if (f.owner.completionTerminalization?.state === "committed") f.state.current = undefined;
  });
  const verification = f.service.verifyCompletion(f.run, f.request).then(result => { responded = true; return result; });
  await statusStarted.promise;
  snapshot.resolve({ messages: [], pending: false });
  await Bun.sleep(0);
  expect(exited).toBe(false); expect(responded).toBe(false); expect(f.state.current).toBe(f.owner);
  journal.resolve(); await persistStarted.promise; await Bun.sleep(0);
  expect(exited).toBe(false); expect(responded).toBe(false); expect(f.state.current).toBe(f.owner);
  metadata.resolve(); await monitorExited.promise;
  expect(responded).toBe(false); expect(f.state.current).toBe(f.owner);
  finalizer.resolve();
  expect((await verification).status).toBe("completed"); expect(f.state.current).toBeUndefined();
});

test("failed final persistence rejects monitor completion and retains fail-closed ownership", async () => {
  const f = fixture(); f.state.autoRelease = false;
  const snapshot = Promise.withResolvers<Awaited<ReturnType<OpenCodeRunAdapter["snapshot"]>>>();
  const persistStarted = Promise.withResolvers<void>(), metadata = Promise.withResolvers<void>();
  f.oc.snapshot = () => snapshot.promise;
  f.deps.persist = async () => {
    if (f.run.status === "completed") { persistStarted.resolve(); await metadata.promise; throw new Error("terminal disk failure"); }
  };
  let failed = false;
  f.owner.done = f.service.monitorNative(f.owner).catch(() => { failed = true; f.state.storageFailed = true; }).finally(() => {
    f.owner.settled = true;
    // Same barrier guard as bridge.releaseOwner, including startup recovery.
    if (f.owner.completionTerminalization?.state === "committed") f.state.current = undefined;
  });
  const verification = f.service.verifyCompletion(f.run, f.request).then(() => undefined, error => error as Error);
  await persistStarted.promise; snapshot.resolve({ messages: [], pending: false });
  await Bun.sleep(0); expect(failed).toBe(false); expect(f.state.current).toBe(f.owner);
  metadata.resolve(); expect((await verification)?.message).toBe("terminal disk failure"); await f.owner.done;
  expect(failed).toBe(true); expect(f.owner.completionTerminalization?.state).toBe("failed");
  expect(f.state.current).toBe(f.owner); expect(f.state.storageFailed).toBe(true);
});
