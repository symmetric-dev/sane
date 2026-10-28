import { describe, expect, test } from "bun:test";
import { ClaudeRunService, type ClaudeRunDependencies, type ClaudeRunRuntime } from "./claude-run-service";
import { OpenCodeRunService, type OpenCodeRunDependencies } from "./opencode-run-service";
import type { Run, Session } from "./history";
import type { RunOwner } from "./run-owner";
import { bindRunControls, requestRunCancellation } from "./run-controls";
import { requireOwnedOperation } from "./harness-operations";

// All clocks, children and adapters are local fakes. No process, native service,
// executable, model, filesystem write or network connection participates.
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await Promise.resolve(); }
  throw new Error("Fake lifecycle did not reach expected state");
}
async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
function clock() {
  const waits: { ms: number; resolve: () => void }[] = [];
  return { waits, sleep(ms: number) {
    const wait = deferred(); waits.push({ ms, resolve: () => wait.resolve() }); return wait.promise;
  } };
}
function ownerFixture(harness: "claude-code" | "opencode") {
  const run: Run = { runId: "synthetic-run", sessionId: "synthetic-session", cwd: "/synthetic/checkout",
    status: "running", createdAt: "2026-10-27T00:00:00Z", ...(harness === "opencode" ? { nativeCommandId: "synthetic-command" } : {}) };
  const session: Session = { sessionId: run.sessionId, harness, authorityId: "synthetic-authority", nativeSessionId: "synthetic-native", cwd: run.cwd,
    lastRunId: run.runId, lastStatus: "running" };
  const done = deferred();
  const owner: RunOwner = { run, done: done.promise, settled: false, ...(harness === "opencode" ? { native: true } : {}) };
  return { run, session, owner, done };
}
function unexpected(): never { throw new Error("Unexpected native effect"); }
function fakeChild(onKill: (signal: NodeJS.Signals) => void = unexpected, exited = deferred<number>().promise): NonNullable<RunOwner["child"]> {
  return { pid: 45678, exitCode: null, exited, kill: onKill } as unknown as NonNullable<RunOwner["child"]>;
}
function claudeFixture() {
  const f = ownerFixture("claude-code"), time = clock();
  const signals: [number, NodeJS.Signals | 0][] = [];
  const state = { closing: false, groupAlive: false, reconciliations: 0, spawns: 0 };
  const deps: ClaudeRunDependencies = {
    session: () => f.session, run: () => f.run, events: () => [], owns: candidate => candidate === f.owner,
    closing: () => state.closing, storageFailed: () => false, retained: () => false,
    requireReconciliation() { state.reconciliations++; }, failClosed: unexpected,
    emit: async () => {}, persist: async () => {}, enqueue: action => action(),
    execution: async () => f.run.cwd, compactExecution: async () => f.run.cwd,
    executionContext: unexpected, refreshCompactHistory: unexpected, assertWorkerDeliverySubmission: () => {},
  };
  const runtime: Partial<ClaudeRunRuntime> = {
    spawn() { state.spawns++; return unexpected(); },
    kill(pid, signal) { signals.push([pid, signal]); if (signal === 0 && !state.groupAlive) throw Object.assign(new Error("No fake group"), { code: "ESRCH" }); },
    sleep: time.sleep, randomUUID: () => "synthetic-secret", execPath: "/synthetic/bun", env: {},
    writeSettings: unexpected, agentSettings: unexpected, version: unexpected,
  };
  const service = new ClaudeRunService({ dataDir: "/synthetic/data", claudeBin: "/synthetic/claude", claudeRoot: "/synthetic/config",
    packageRoot: "/synthetic/package", hookUrl: () => "http://127.0.0.1:1/hooks" }, deps, runtime);
  return { ...f, service, deps, state, signals, time };
}
function openCodeFixture() {
  const f = ownerFixture("opencode"), time = clock(), cancellations: string[] = [];
  const state = { current: f.owner as RunOwner | undefined };
  const deps: OpenCodeRunDependencies = {
    oc: { assertIdle: unexpected, select: unexpected, prompt: unexpected, snapshot: unexpected, interactions: unexpected,
      compact: unexpected, compactionSnapshot: unexpected, activity: unexpected, cancelInput: unexpected,
      async cancel(id, beforeCancel) { beforeCancel?.(); cancellations.push(id); return { interrupted: true }; } },
    closing: () => false, storageFailed: () => false, failClosed: unexpected,
    currentOwner: () => state.current, session: () => f.session, events: () => [],
    emit: unexpected, persist: unexpected, execution: unexpected, executionContext: unexpected,
    compactExecution: unexpected, refreshCompactHistory: unexpected, assertWorkerDeliverySubmission: unexpected,
    workerHasRun: () => false, sleep: time.sleep,
  };
  return { ...f, service: new OpenCodeRunService(deps), deps, state, time, cancellations };
}
function boundControls(f: ReturnType<typeof claudeFixture> | ReturnType<typeof openCodeFixture>) {
  return bindRunControls(f.owner, { harnessId: f.session.harness!, sessionId: f.session.sessionId,
    authorityId: f.session.authorityId!, nativeSessionId: f.session.nativeSessionId!, cwd: f.session.cwd }, f.service.controls(f.owner));
}

describe("original lifecycle completion fences", () => {
  for (const harness of ["claude-code", "opencode"] as const) {
    for (const replacementComplete of [false, true]) test(`${harness} shutdown ignores replaced done (replacement complete: ${replacementComplete})`, async () => {
      const f = harness === "claude-code" ? claudeFixture() : openCodeFixture(), controls = boundControls(f);
      f.owner.done = replacementComplete ? Promise.resolve() : deferred().promise;
      if (!replacementComplete) f.done.resolve();
      const stopping = controls.shutdown(); let settled = false;
      void stopping.then(() => { settled = true; });
      await flush();
      expect(settled).toBe(!replacementComplete);
      if (replacementComplete) f.done.resolve();
      expect(await stopping).toEqual({ drained: true, reconciliationRequired: false });
      expect(f.time.waits.map(wait => wait.ms)).toEqual([harness === "claude-code" ? 3000 : 12000]);
    });
  }
});

describe("Claude owner-bound lifecycle controls", () => {
  test("both interrupt modes and timing readers keep the original owner", async () => {
    const f = claudeFixture(), controls = f.service.controls(f.owner), called: RunOwner[] = [];
    f.service.terminate = async owner => { called.push(owner); return called.length === 1; };
    f.service.readSubmissionTiming = owner => { called.push(owner); return undefined; };
    // Mutable routing hints must not change the installed native control port.
    f.owner.native = true;
    expect(controls.cancellation).toBe("retain-result");
    expect(await controls.interrupt("worker")).toEqual({ interrupted: true });
    expect(await controls.interrupt("user")).toEqual({ interrupted: false });
    expect(controls.readPreparationTiming?.()).toBeUndefined();
    expect(called).toEqual([f.owner, f.owner, f.owner]);
    expect(f.owner.cancel).toBeUndefined();
  });

  test("cleanup consults the live child, not the child present at binding", async () => {
    const f = claudeFixture(), controls = f.service.controls(f.owner), called: RunOwner[] = [];
    f.service.terminate = async owner => { called.push(owner); return false; };
    expect(await controls.cleanup()).toBe(true);
    expect(called).toEqual([]);
    f.owner.child = fakeChild();
    expect(await controls.cleanup()).toBe(false);
    expect(called).toEqual([f.owner]);
  });

  test("prelaunch interrupt does not cache termination and miss a later child", async () => {
    const f = claudeFixture(), controls = f.service.controls(f.owner), killed: NodeJS.Signals[] = [];
    expect(await controls.interrupt("user")).toEqual({ interrupted: true });
    expect(f.owner.stopping).toBeUndefined();
    f.owner.child = fakeChild(signal => killed.push(signal), Promise.resolve(0));
    const cleaning = controls.cleanup();
    expect(killed).toEqual(["SIGTERM"]);
    expect(f.time.waits.map(wait => wait.ms)).toEqual([20]);
    await flush(); f.time.waits[0]!.resolve();
    expect(await cleaning).toBe(true);
    expect(await controls.cleanup()).toBe(true);
    expect(killed).toEqual(["SIGTERM"]);
    expect(f.signals).toContainEqual([-45678, "SIGTERM"]);
    expect(f.state.reconciliations).toBe(0);
  });

  test("bound local Stop reaches the original child after source and launch metadata drift", async () => {
    const f = claudeFixture(), killed: NodeJS.Signals[] = [];
    f.owner.child = fakeChild(signal => killed.push(signal), Promise.resolve(0));
    boundControls(f);
    f.session.authorityId = "changed-authority";
    f.session.nativeSessionId = "changed-native";
    f.session.cwd = "/changed-session";
    f.run.cwd = "/changed-run";
    f.run.nativeCommandId = "changed-metadata";
    f.owner.done = Promise.resolve();
    expect(requireOwnedOperation({ ...f.session, harness: f.session.harness! }, f.owner, "cancelOwnedRun").id).toBe("claude-code");
    const stopping = requestRunCancellation(f.owner, "user", {
      emitStopping: async () => {}, isCurrent: () => true, release: value => { expect(value).toBe(f.owner); },
    });
    await until(() => f.time.waits.length === 1);
    f.time.waits[0]!.resolve();
    expect(await stopping).toEqual({ interrupted: true });
    expect(killed).toEqual(["SIGTERM"]);
    expect(f.signals).toContainEqual([-45678, "SIGTERM"]);
    expect(f.state.spawns).toBe(0);
  });

  test("shutdown waits for lifecycle done, not cancellation, within exactly 3000 ms", async () => {
    const f = claudeFixture(); f.owner.cancel = deferred<{ interrupted: boolean }>().promise;
    const stopping = f.service.controls(f.owner).shutdown(); let settled = false;
    void stopping.then(() => { settled = true; });
    await flush(); expect(settled).toBe(false);
    expect(f.time.waits.map(wait => wait.ms)).toEqual([3000]);
    f.done.resolve();
    expect(await stopping).toEqual({ drained: true, reconciliationRequired: false });
  });

  test("shutdown timeout requires retention and reconciliation even without a child", async () => {
    const f = claudeFixture(), stopping = f.service.controls(f.owner).shutdown();
    expect(f.time.waits.map(wait => wait.ms)).toEqual([3000]);
    f.time.waits[0]!.resolve();
    expect(await stopping).toEqual({ drained: false, reconciliationRequired: true });
    expect(f.state.reconciliations).toBe(0); // Caller applies the returned policy.
  });

  test("shutdown starts its drain budget only after existing-child termination", async () => {
    const f = claudeFixture(), termination = deferred<boolean>(), called: RunOwner[] = [];
    f.owner.child = fakeChild();
    f.service.terminate = async owner => { called.push(owner); return termination.promise; };
    const stopping = f.service.controls(f.owner).shutdown();
    f.done.resolve(); await flush();
    expect(called).toEqual([f.owner]); expect(f.time.waits).toEqual([]);
    // The old policy checks done/group absence, not terminate's boolean alone.
    termination.resolve(false);
    expect(await stopping).toEqual({ drained: true, reconciliationRequired: false });
    expect(f.time.waits.map(wait => wait.ms)).toEqual([3000]);
    expect(f.signals).toEqual([[-45678, 0]]);
  });

  for (const groupAlive of [false, true]) test(`shutdown freshly checks a child attached during drain (group alive: ${groupAlive})`, async () => {
    const f = claudeFixture(); let terminations = 0;
    f.service.terminate = async () => { terminations++; return true; };
    const stopping = f.service.controls(f.owner).shutdown();
    f.owner.child = fakeChild(); f.state.groupAlive = groupAlive; f.done.resolve();
    expect(await stopping).toEqual({ drained: !groupAlive, reconciliationRequired: groupAlive });
    expect(terminations).toBe(0); expect(f.signals).toEqual([[-45678, 0]]);
  });

  test("a surviving group still requires reconciliation after done and termination", async () => {
    const f = claudeFixture(); f.owner.child = fakeChild(); f.state.groupAlive = true;
    f.service.terminate = async () => false;
    f.done.resolve();
    expect(await f.service.controls(f.owner).shutdown()).toEqual({ drained: false, reconciliationRequired: true });
  });

  test("shutdown during real service preparation drains without a late native spawn", async () => {
    const f = claudeFixture(), entered = deferred(), release = deferred();
    f.run.operation = "compact";
    f.deps.emit = async (_run, kind, data) => {
      if (kind === "status" && (data as { status: string }).status === "running") { entered.resolve(); await release.promise; }
    };
    f.owner.done = f.service.execute(f.owner, "/compact", true, () => {});
    await entered.promise;
    f.state.closing = true;
    const stopping = f.service.controls(f.owner).shutdown();
    expect(f.time.waits.map(wait => wait.ms)).toEqual([3000]);
    release.resolve();
    expect(await stopping).toEqual({ drained: true, reconciliationRequired: false });
    expect(f.run.status).toBe("interrupted"); expect(f.owner.streamsDrained).toBe(true);
    expect(f.owner.stopping).toBeUndefined(); expect(f.state.spawns).toBe(0); expect(f.signals).toEqual([]);
    expect(f.time.waits.map(wait => wait.ms)).toEqual([3000, 2200]);
  });
});

describe("OpenCode owner-bound lifecycle controls", () => {
  test("worker/user routing and timing readers keep the original owner", async () => {
    const f = openCodeFixture(), controls = f.service.controls(f.owner), calls: [string, RunOwner][] = [];
    f.service.interrupt = async owner => { calls.push(["worker", owner]); return { interrupted: false }; };
    f.service.interruptCurrent = async owner => { calls.push(["user", owner]); return { interrupted: true }; };
    f.service.readSubmissionTiming = owner => { calls.push(["timing", owner]); return undefined; };
    f.state.current = { ...f.owner }; f.owner.native = false;
    expect(controls.cancellation).toBe("in-flight");
    expect(await controls.interrupt("worker")).toEqual({ interrupted: false });
    expect(await controls.interrupt("user")).toEqual({ interrupted: true });
    expect(controls.readPreparationTiming?.()).toBeUndefined();
    expect(calls).toEqual([["worker", f.owner], ["user", f.owner], ["timing", f.owner]]);
    expect(f.owner.cancel).toBeUndefined();
  });

  test("withheld preparation acknowledges user Stop but not worker native interruption", async () => {
    const f = openCodeFixture(), controls = f.service.controls(f.owner);
    f.owner.nativeDispatched = false; f.run.nativePhase = "preparing";
    expect(await controls.interrupt("worker")).toEqual({ interrupted: false });
    expect(await controls.interrupt("user")).toEqual({ interrupted: true });
    expect(f.cancellations).toEqual([]);
  });

  for (const mode of ["worker", "user"] as const) test(`${mode} interrupt preserves its ownership check after submission settles`, async () => {
    const f = openCodeFixture(), submission = deferred();
    f.owner.nativeDispatched = true; f.owner.submission = submission.promise;
    const interrupting = f.service.controls(f.owner).interrupt(mode);
    await flush(); expect(f.cancellations).toEqual([]);
    f.state.current = { ...f.owner }; submission.resolve();
    expect(await interrupting).toEqual({ interrupted: mode === "worker" });
    expect(f.cancellations).toEqual(mode === "worker" ? [f.session.nativeSessionId!] : []);
  });

  for (const mode of ["worker", "user"] as const) {
    test(`bound ${mode} cancellation refuses source drift already present at invocation`, async () => {
      const f = openCodeFixture(), controls = boundControls(f);
      f.owner.nativeDispatched = true;
      f.session.nativeSessionId = "replacement-native";
      // Shared authorization no longer re-proves source metadata; the native
      // adapter must still refuse before sending an interrupt to any session.
      expect(requireOwnedOperation({ ...f.session, harness: f.session.harness! }, f.owner, "cancelOwnedRun").id).toBe("opencode");
      await expect(controls.interrupt(mode)).rejects.toThrow("Native cancellation withheld after original control source changed");
      expect(f.cancellations).toEqual([]);
    });
    for (const field of ["sessionId", "harness", "authorityId", "nativeSessionId", "cwd"] as const) {
      test(`bound ${mode} cancellation refuses ${field} drift during delayed submission`, async () => {
        const f = openCodeFixture(), submission = deferred(), controls = boundControls(f);
        f.owner.nativeDispatched = true; f.owner.submission = submission.promise;
        const interrupting = controls.interrupt(mode);
        void interrupting.catch(() => {});
        await flush(); expect(f.cancellations).toEqual([]);
        if (field === "harness") f.session.harness = "claude-code";
        else f.session[field] = "replacement-source";
        submission.resolve(); await expect(interrupting).rejects.toThrow(/original control source changed/);
        expect(f.cancellations).toEqual([]);
      });
    }

    test(`bound ${mode} cancellation refuses replaced run association after submission`, async () => {
      const f = openCodeFixture(), submission = deferred(), controls = boundControls(f);
      f.owner.nativeDispatched = true; f.owner.submission = submission.promise;
      const interrupting = controls.interrupt(mode);
      void interrupting.catch(() => {});
      f.owner.run = { ...f.run }; submission.resolve();
      await expect(interrupting).rejects.toThrow(/original owner and source/);
      expect(f.cancellations).toEqual([]);
    });

    test(`bound ${mode} cancellation preserves withheld acknowledgement and current-owner semantics`, async () => {
      const f = openCodeFixture(), controls = boundControls(f);
      f.owner.nativeDispatched = false;
      expect(await controls.interrupt(mode)).toEqual({ interrupted: mode === "user" });
      f.owner.nativeDispatched = true;
      const submission = deferred(); f.owner.submission = submission.promise;
      const interrupting = controls.interrupt(mode);
      f.state.current = { ...f.owner }; submission.resolve();
      expect(await interrupting).toEqual({ interrupted: mode === "worker" });
      expect(f.cancellations).toEqual(mode === "worker" ? ["synthetic-native"] : []);
    });
  }

  for (const drift of ["nativeSessionId", "authorityId", "run"] as const) test(`bound cancellation rechecks ${drift} after endpoint discovery before mutation`, async () => {
    const f = openCodeFixture(), controls = boundControls(f), discovery = deferred();
    const discoveredIds: string[] = [];
    f.owner.nativeDispatched = true;
    f.deps.oc.cancel = async (id, beforeCancel) => {
      discoveredIds.push(id); await discovery.promise;
      beforeCancel?.(); f.cancellations.push(id); return { interrupted: true };
    };
    const interrupting = controls.interrupt("user");
    void interrupting.catch(() => {});
    await until(() => discoveredIds.length === 1);
    if (drift === "run") f.run.nativeCommandId = "replacement-command";
    else f.session[drift] = "replacement-source";
    discovery.resolve(); await expect(interrupting).rejects.toThrow();
    expect(discoveredIds).toEqual(["synthetic-native"]); expect(f.cancellations).toEqual([]);
  });

  test("bound cancellation with stable source reaches only the pinned native session", async () => {
    const f = openCodeFixture(), controls = boundControls(f), ids: string[] = [];
    f.owner.nativeDispatched = true;
    f.deps.oc.cancel = async (id, beforeCancel) => {
      ids.push(id); expect(typeof beforeCancel).toBe("function");
      await Promise.resolve(); beforeCancel!(); f.cancellations.push(id); return { interrupted: true };
    };
    expect(await controls.interrupt("user")).toEqual({ interrupted: true });
    expect(ids).toEqual(["synthetic-native"]); expect(f.cancellations).toEqual(ids);
  });

  for (const change of ["owner", "terminal"] as const) test(`bound user cancellation rechecks ${change} after endpoint discovery`, async () => {
    const f = openCodeFixture(), controls = boundControls(f), discovery = deferred(), entered = deferred();
    f.owner.nativeDispatched = true;
    f.deps.oc.cancel = async (id, beforeCancel) => {
      entered.resolve(); await discovery.promise;
      beforeCancel!(); f.cancellations.push(id); return { interrupted: true };
    };
    const interrupting = controls.interrupt("user");
    void interrupting.catch(() => {});
    await entered.promise;
    if (change === "owner") f.state.current = { ...f.owner };
    else f.run.status = "completed";
    discovery.resolve();
    await expect(interrupting).rejects.toThrow("Native cancellation withheld after ownership changed");
    expect(f.cancellations).toEqual([]);
  });

  for (const validReceipt of [false, true]) test(`bound strict queued cancellation retains receipt rules (valid receipt: ${validReceipt})`, async () => {
    const f = openCodeFixture();
    f.run.nativeDelivery = "queue"; f.run.nativePhase = "sending";
    f.owner.nativeDispatched = true; f.owner.nativeDeliveryPolicy = "native-queued-handoff";
    const controls = boundControls(f);
    f.owner.nativeQueuedHandoff = { runId: f.run.runId, nativeCommandId: f.run.nativeCommandId!, requestId: "synthetic-request",
      source: controls.source, origin: "queued-user" };
    f.owner.dispatchEvidence = { beforeNative() {}, outcome() {}, withheld() {} }; f.owner.beforeSend = () => {};
    f.deps.oc.promptQueuedHandoff = unexpected; f.deps.oc.preflightNativeSession = unexpected;
    const pendingInput = { id: f.run.nativeCommandId, sessionID: validReceipt ? f.session.nativeSessionId : "foreign-native",
      type: "user", delivery: "queue", time: { created: 1 } };
    f.deps.oc.snapshot = async () => ({ messages: [], pending: true, pendingInput, observation: { kind: "pending", input: pendingInput } });
    const deleted: unknown[][] = [];
    f.deps.oc.cancelInput = async (id, command, beforeCancel, policy) => {
      beforeCancel?.(); deleted.push([id, command, policy]); return true;
    };
    expect(await controls.interrupt("user")).toEqual({ interrupted: false });
    expect(deleted).toEqual(validReceipt ? [["synthetic-native", "synthetic-command", "native-queued-handoff"]] : []);
    expect(f.cancellations).toEqual([]);
  });

  test("cleanup never kills a child, interrupts remote work or waits for lifecycle", async () => {
    const f = openCodeFixture(); f.owner.child = fakeChild();
    f.deps.oc.cancel = unexpected;
    f.service.interrupt = unexpected; f.service.interruptCurrent = unexpected;
    expect(await f.service.controls(f.owner).cleanup()).toBe(true);
    expect(f.time.waits).toEqual([]); expect(f.owner.stopping).toBeUndefined();
  });

  for (const first of ["done", "cancel"] as const) test(`shutdown joins both lifecycle and existing cancellation (${first} first)`, async () => {
    const f = openCodeFixture(), cancel = deferred<{ interrupted: boolean }>();
    f.owner.cancel = cancel.promise; f.owner.child = fakeChild();
    f.deps.oc.cancel = unexpected; f.service.interrupt = unexpected; f.service.interruptCurrent = unexpected;
    const stopping = f.service.controls(f.owner).shutdown(); let settled = false;
    void stopping.then(() => { settled = true; });
    expect(f.time.waits.map(wait => wait.ms)).toEqual([12000]);
    if (first === "done") f.done.resolve(); else cancel.resolve({ interrupted: false });
    await flush(); expect(settled).toBe(false);
    if (first === "done") cancel.resolve({ interrupted: false }); else f.done.resolve();
    expect(await stopping).toEqual({ drained: true, reconciliationRequired: false });
    expect(f.cancellations).toEqual([]);
  });

  test("shutdown drains rejected cancellation without treating it as reconciliation", async () => {
    const f = openCodeFixture(), cancel = deferred<{ interrupted: boolean }>();
    f.owner.cancel = cancel.promise;
    const stopping = f.service.controls(f.owner).shutdown();
    cancel.reject(new Error("Fake request rejected")); f.done.resolve();
    expect(await stopping).toEqual({ drained: true, reconciliationRequired: false });
    expect(f.cancellations).toEqual([]);
  });

  test("shutdown timeout retains local ownership without metadata reconciliation or remote mutation", async () => {
    const f = openCodeFixture(); f.owner.cancel = deferred<{ interrupted: boolean }>().promise;
    f.deps.oc.cancel = unexpected; f.service.interrupt = unexpected; f.service.interruptCurrent = unexpected;
    const stopping = f.service.controls(f.owner).shutdown();
    f.done.resolve(); await flush();
    expect(f.time.waits.map(wait => wait.ms)).toEqual([12000]); f.time.waits[0]!.resolve();
    expect(await stopping).toEqual({ drained: false, reconciliationRequired: false });
    expect(f.owner.stopping).toBeUndefined();
  });

  test("shutdown does not add a separate submission wait beyond the original done fence", async () => {
    const f = openCodeFixture(); f.owner.submission = deferred().promise; f.done.resolve();
    expect(await f.service.controls(f.owner).shutdown()).toEqual({ drained: true, reconciliationRequired: false });
    expect(f.cancellations).toEqual([]);
    expect(f.time.waits.map(wait => wait.ms)).toEqual([12000]);
  });
});
