import { describe, expect, test } from "bun:test";
import type { DispatchSource } from "../shared/conversation/dispatch-contract";
import { dispatchOwnedOperation, HarnessOperationError, requireOwnedOperation } from "./harness-operations";
import { bindRunControls, requestRunCancellation, requireRunControls, type RunControlOperations } from "./run-controls";
import type { RunOwner } from "./run-owner";
import { ConversationCoordinator } from "./conversation-coordinator";

// Offline lifecycle resources only: no bridge, services, native clients or IO.
const originalSource: DispatchSource = { harnessId: "opencode", sessionId: "app-session", authorityId: "authority",
  nativeSessionId: "native-session", cwd: "/synthetic/run-controls" };
function owner(): RunOwner {
  return { run: { runId: "run", sessionId: originalSource.sessionId, cwd: originalSource.cwd, nativeCommandId: "msg_original",
    status: "running", createdAt: "2026-10-27T00:00:00.000Z" }, done: Promise.resolve(), settled: false };
}
function fixture(overrides: Partial<RunControlOperations> = {}, source = { ...originalSource }) {
  const owned = owner(), calls: string[] = [];
  const operations: RunControlOperations = {
    cancellation: "in-flight",
    interrupt: async mode => { calls.push(`interrupt:${mode}`); return { interrupted: true }; },
    cleanup: async () => { calls.push("cleanup"); return true; },
    shutdown: async () => { calls.push("shutdown"); return { drained: true, reconciliationRequired: false }; },
    ...overrides,
  };
  const controls = bindRunControls(owned, source, operations);
  const hooks = {
    emitStopping: async () => { calls.push("stopping"); },
    isCurrent: () => { calls.push("current"); return true; },
    release: (released: RunOwner) => { expect(released).toBe(owned); calls.push("release"); },
  };
  return { owned, source, operations, controls, calls, hooks };
}
function expectMismatch(action: () => unknown) {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(HarnessOperationError);
    expect(error).toMatchObject({ status: 409, code: "owner-harness-mismatch" });
    return;
  }
  throw new Error("Expected owner association refusal");
}

describe("owner-bound run controls", () => {
  test("installs one frozen capability and a cloned source without freezing lifecycle state", () => {
    const f = fixture(), run = f.owned.run, done = f.owned.done;
    expect(requireRunControls(f.owned)).toBe(f.controls);
    expect(Object.getOwnPropertyDescriptor(f.owned, "controls")).toMatchObject({ value: f.controls, writable: false, configurable: false });
    expect(Object.isFrozen(f.controls)).toBe(true);
    expect(Object.isFrozen(f.controls.source)).toBe(true);
    expect(f.controls.source).not.toBe(f.source);
    expect(f.controls.source).toEqual(originalSource);
    expect(Reflect.set(f.owned, "controls", {})).toBe(false);
    expect(Reflect.deleteProperty(f.owned, "controls")).toBe(false);
    expect(Reflect.set(f.controls, "cleanup", async () => false)).toBe(false);
    expectMismatch(() => bindRunControls(f.owned, f.source, f.operations));
    f.owned.run.status = "interrupted"; f.owned.settled = true; f.owned.native = true;
    expect(requireRunControls(f.owned)).toBe(f.controls);
    expect(f.owned.run).toBe(run); expect(f.owned.done).toBe(done);
  });

  test("copied controls cannot authorize another owner, even with an immutable descriptor", () => {
    const f = fixture(), copied = { ...f.owned };
    expectMismatch(() => f.controls.assertOwner(copied));
    expectMismatch(() => requireRunControls(copied));
    const foreign = owner();
    Object.defineProperty(foreign, "controls", { value: f.controls });
    expectMismatch(() => requireRunControls(foreign));
    expectMismatch(() => requireOwnedOperation({ sessionId: f.source.sessionId, harness: "opencode" }, foreign, "cancelOwnedRun"));
  });

  for (const key of ["runId", "sessionId", "cwd", "nativeCommandId"] as const) test(`rejects original ${key} mutation for launch but preserves resource ownership`, async () => {
    const f = fixture(); f.owned.run[key] += "-foreign";
    expect(requireRunControls(f.owned)).toBe(f.controls);
    expectMismatch(() => f.controls.assertIdentity(f.owned));
    expectMismatch(() => requireOwnedOperation({ sessionId: f.source.sessionId, harness: "opencode" }, f.owned, "prompt"));
    expect(await f.owned.controls!.cleanup()).toBe(true);
    expect(await f.owned.controls!.shutdown()).toEqual({ drained: true, reconciliationRequired: false });
    expect(f.calls).toEqual(["cleanup", "shutdown"]);
  });

  for (const key of ["run", "done"] as const) test(`replacement ${key} refuses launch without blocking original resource teardown`, async () => {
    const touched: string[] = [], resource = { id: "original" }, captured = resource;
    const f = fixture({ cleanup: async () => { touched.push(`cleanup:${captured.id}`); return true; },
      shutdown: async () => { touched.push(`shutdown:${captured.id}`); return { drained: false, reconciliationRequired: true }; } });
    if (key === "run") f.owned.run = { ...f.owned.run };
    else f.owned.done = Promise.resolve();
    expect(requireRunControls(f.owned)).toBe(f.controls);
    expectMismatch(() => f.controls.assertIdentity(f.owned));
    expectMismatch(() => requireOwnedOperation({ sessionId: f.source.sessionId, harness: "opencode" }, f.owned, "prompt"));
    expect(await f.owned.controls!.cleanup()).toBe(true);
    expect(await f.owned.controls!.shutdown()).toEqual({ drained: false, reconciliationRequired: true });
    expect(touched).toEqual(["cleanup:original", "shutdown:original"]);
    expect(f.calls).toEqual([]);
  });

  for (const key of ["harnessId", "sessionId", "authorityId", "nativeSessionId", "cwd"] as const) {
    for (const value of ["", "  ", null, undefined]) test(`rejects missing or blank ${key}: ${String(value)}`, () => {
      expectMismatch(() => bindRunControls(owner(), { ...originalSource, [key]: value } as DispatchSource, fixture().operations));
    });
  }

  for (const key of ["sessionId", "cwd"] as const) test(`rejects source/run ${key} mismatch at binding`, () => {
    expectMismatch(() => bindRunControls(owner(), { ...originalSource, [key]: "foreign" }, fixture().operations));
  });

  test("allows an explicitly bound internal harness without adding a production registry entry", async () => {
    const f = fixture({}, { ...originalSource, harnessId: "internal-offline-fixture" });
    expect(await f.controls.cleanup()).toBe(true);
    expect(() => requireOwnedOperation({ sessionId: f.source.sessionId, harness: f.source.harnessId }, f.owned, "cancelOwnedRun"))
      .toThrow("Unknown harness");
  });

  test("missing controls fail closed even when the legacy native marker agrees", () => {
    const owned = owner(); owned.native = true;
    expectMismatch(() => requireRunControls(owned));
    expectMismatch(() => requireOwnedOperation({ sessionId: owned.run.sessionId, harness: "opencode" }, owned, "cancelOwnedRun"));
  });

  test("supported operations route by the bound harness, never legacy native state", () => {
    for (const harness of ["claude-code", "opencode"] as const) {
      const f = fixture({}, { ...originalSource, harnessId: harness });
      f.owned.native = harness !== "opencode";
      const session = { ...f.source, harness };
      expect(requireOwnedOperation(session, f.owned, "cancelOwnedRun").id).toBe(harness);
      expect(dispatchOwnedOperation(session, f.owned, "cancelOwnedRun", {
        "claude-code": () => "cc", opencode: () => "oc",
        grok: () => { throw new HarnessOperationError("Grok is not available through this driver", 501, "unsupported-harness-operation"); },
      }))
        .toBe(harness === "opencode" ? "oc" : "cc");
    }
  });

  test("validates operation capability before missing owner controls", () => {
    try { requireOwnedOperation({ sessionId: "other", harness: "claude-code" }, owner(), "permissionReply"); }
    catch (error) { expect(error).toMatchObject({ status: 501, code: "unsupported-harness-operation" }); return; }
    throw new Error("Expected unsupported operation");
  });

  for (const key of ["harnessId", "sessionId", "authorityId", "nativeSessionId", "cwd"] as const) test(`launch rejects supplied session source ${key} drift`, () => {
    const f = fixture(), session = { sessionId: f.source.sessionId, harness: "opencode", source: { ...f.source, [key]: "foreign" } };
    expectMismatch(() => requireOwnedOperation(session, f.owned, "prompt"));
  });

  for (const key of ["authorityId", "nativeSessionId", "cwd"] as const) test(`launch rejects supplied session ${key} drift including explicit null/undefined`, () => {
    const f = fixture();
    for (const value of ["foreign", null, undefined]) {
      expectMismatch(() => requireOwnedOperation({ sessionId: f.source.sessionId, harness: "opencode", [key]: value }, f.owned, "prompt"));
    }
  });

  test("rejects another harness or App session even with valid controls", () => {
    const f = fixture();
    expectMismatch(() => requireOwnedOperation({ sessionId: f.source.sessionId, harness: "claude-code" }, f.owned, "cancelOwnedRun"));
    expectMismatch(() => requireOwnedOperation({ sessionId: "other", harness: "opencode" }, f.owned, "cancelOwnedRun"));
  });

  test("cleanup, shutdown and diagnostics retain original closures after configuration and source drift", async () => {
    const resource = { id: "original-resource" }, touched: string[] = [], timing = Object.freeze({});
    let current = resource;
    const captured = current;
    const f = fixture({ cleanup: async () => { touched.push(`cleanup:${captured.id}`); return false; },
      shutdown: async () => { touched.push(`shutdown:${captured.id}`); return { drained: false, reconciliationRequired: true }; },
      readPreparationTiming: () => timing });
    current = { id: "replacement-resource" };
    f.source.authorityId = "changed-authority"; f.source.nativeSessionId = "changed-session"; f.source.cwd = "/changed";
    // Replacing the supplied operations cannot retarget the installed capability.
    (f.operations as { cleanup: RunControlOperations["cleanup"] }).cleanup = async () => { throw new Error("replacement called"); };
    expect(await requireRunControls(f.owned).cleanup()).toBe(false);
    expect(await requireRunControls(f.owned).shutdown()).toEqual({ drained: false, reconciliationRequired: true });
    expect(f.controls.readPreparationTiming!()).toBe(timing);
    expect(touched).toEqual(["cleanup:original-resource", "shutdown:original-resource"]);
    expect(f.controls.source).toEqual(originalSource); expect(current.id).toBe("replacement-resource");
  });

  test("optional timing reads do not re-prove launch identity", () => {
    const timing = Object.freeze({}), f = fixture({ readPreparationTiming: () => timing });
    f.owned.run = { ...f.owned.run, runId: "changed-run", cwd: "/changed" };
    f.owned.done = Promise.resolve();
    expectMismatch(() => f.controls.assertIdentity(f.owned));
    expect(f.owned.controls?.readPreparationTiming?.()).toBe(timing);
  });

  for (const key of ["authorityId", "nativeSessionId", "cwd"] as const) test(`Stop authorizes the original resource despite current ${key} drift`, () => {
    const f = fixture({}, { ...originalSource, harnessId: "claude-code" });
    const session = { sessionId: f.source.sessionId, harness: "claude-code", [key]: "changed" };
    expect(requireOwnedOperation(session, f.owned, "cancelOwnedRun").id).toBe("claude-code");
    expectMismatch(() => requireOwnedOperation(session, f.owned, "prompt"));
  });

  test("shutdown preserves honest drain proof and does not imply interruption or release", async () => {
    const f = fixture();
    expect(await f.controls.shutdown()).toEqual({ drained: true, reconciliationRequired: false });
    expect(f.calls).toEqual(["shutdown"]); expect(f.owned.settled).toBe(false);
    expect(f.owned.stopRequested).toBeUndefined();
  });

  test("cleanup and shutdown failures propagate without synthesizing settlement", async () => {
    const failure = new Error("original resource unavailable");
    const f = fixture({ cleanup: async () => { throw failure; }, shutdown: async () => { throw failure; } });
    await expect(f.controls.cleanup()).rejects.toBe(failure);
    await expect(f.controls.shutdown()).rejects.toBe(failure);
    expect(f.owned.settled).toBe(false);
  });
});

describe("owner-scoped cancellation bookkeeping", () => {
  test("Stop fences launch and begins journaling without an extra scheduling gap", async () => {
    const gate = Promise.withResolvers<void>(), f = fixture();
    f.hooks.emitStopping = async () => { f.calls.push("stopping"); await gate.promise; };
    const attempt = requestRunCancellation(f.owned, "user", f.hooks);
    expect(f.owned.stopRequested).toBe(true);
    expect(f.owned.cancelling).toBe(true);
    expect(f.calls).toEqual(["stopping"]);
    gate.resolve(); await attempt;
  });
  for (const cancellation of ["retain-result", "in-flight"] as const) test(`coalesces concurrent ${cancellation} attempts before stopping emission resolves`, async () => {
    const gate = Promise.withResolvers<void>(), f = fixture({ cancellation });
    f.hooks.emitStopping = async () => {
      expect(f.owned.cancelling).toBe(true); expect(f.owned.stopRequested).toBe(true);
      f.calls.push("stopping"); await gate.promise;
    };
    const first = requestRunCancellation(f.owned, "user", f.hooks);
    expect(f.owned.cancel).toBe(first); expect(f.owned.cancelling).toBe(true); expect(f.owned.stopRequested).toBe(true);
    const second = requestRunCancellation(f.owned, "worker", f.hooks); expect(second).toBe(first);
    await Promise.resolve(); expect(f.calls).toEqual(["stopping"]);
    gate.resolve(); expect(await first).toEqual({ interrupted: true });
    expect(f.calls).toEqual(["stopping", "current", "interrupt:user", "release"]);
    expect(f.owned.cancelling).toBe(false); expect(f.owned.stopRequested).toBe(true);
    expect(f.owned.cancel).toBe(cancellation === "retain-result" ? first : undefined);
  });

  test("remote policy allows later explicit Stop even without the legacy native marker", async () => {
    const f = fixture(); f.owned.native = false;
    await requestRunCancellation(f.owned, "worker", f.hooks);
    await requestRunCancellation(f.owned, "user", f.hooks);
    expect(f.calls.filter(call => call.startsWith("interrupt"))).toEqual(["interrupt:worker", "interrupt:user"]);
  });

  test("local policy retains success even with a disagreeing legacy native marker", async () => {
    const f = fixture({ cancellation: "retain-result" }); f.owned.native = true;
    const first = requestRunCancellation(f.owned, "worker", f.hooks); await first;
    expect(requestRunCancellation(f.owned, "user", f.hooks)).toBe(first);
    expect(f.calls).toEqual(["stopping", "interrupt:worker", "release"]);
  });

  for (const mode of ["user", "worker"] as const) test(`${mode} cancellation of a terminal run returns false without native work`, async () => {
    const f = fixture(); f.owned.run.status = "completed";
    expect(await requestRunCancellation(f.owned, mode, f.hooks)).toEqual({ interrupted: false });
    expect(f.calls).toEqual(["release"]); expect(f.owned.cancelling).toBe(false); expect(f.owned.stopRequested).toBe(true);
  });

  for (const mode of ["user", "worker"] as const) test(`${mode} preserves the original post-emit current-owner distinction`, async () => {
    const gate = Promise.withResolvers<void>(), f = fixture();
    f.hooks.emitStopping = async () => { f.calls.push("stopping"); await gate.promise; };
    f.hooks.isCurrent = () => { f.calls.push("current"); return false; };
    const attempt = requestRunCancellation(f.owned, mode, f.hooks);
    await Promise.resolve(); gate.resolve();
    expect(await attempt).toEqual({ interrupted: mode === "worker" });
    expect(f.calls).toEqual(mode === "worker" ? ["stopping", "interrupt:worker", "release"] : ["stopping", "current", "release"]);
  });

  test("user Stop rechecks terminal status after awaited emission", async () => {
    const f = fixture(); f.hooks.emitStopping = async () => { f.owned.run.status = "interrupted"; };
    expect(await requestRunCancellation(f.owned, "user", f.hooks)).toEqual({ interrupted: false });
    expect(f.calls).toEqual(["current", "release"]);
  });

  for (const mode of ["user", "worker"] as const) test(`${mode} cancellation leaves post-emit launch metadata checks to the adapter`, async () => {
    const f = fixture(); f.hooks.emitStopping = async () => { f.owned.run.runId = "foreign-run"; };
    expect(await requestRunCancellation(f.owned, mode, f.hooks)).toEqual({ interrupted: true });
    expect(f.calls).toEqual(mode === "user" ? ["current", "interrupt:user", "release"] : ["interrupt:worker", "release"]);
    expect(f.owned.cancel).toBeUndefined(); expect(f.owned.cancelling).toBe(false);
    expect(await f.owned.controls!.cleanup()).toBe(true);
    expect(await f.owned.controls!.shutdown()).toEqual({ drained: true, reconciliationRequired: false });
  });

  for (const stage of ["emit", "interrupt"] as const) test(`rejected ${stage} clears the shared local attempt and permits explicit retry`, async () => {
    const failure = new Error("ambiguous failure"); let fails = true;
    const f = fixture({ cancellation: "retain-result", interrupt: async () => { if (stage === "interrupt" && fails) throw failure; return { interrupted: true }; } });
    f.hooks.emitStopping = async () => { if (stage === "emit" && fails) throw failure; };
    const first = requestRunCancellation(f.owned, "worker", f.hooks);
    expect(requestRunCancellation(f.owned, "user", f.hooks)).toBe(first);
    await expect(first).rejects.toBe(failure);
    expect(f.owned.cancel).toBeUndefined(); expect(f.owned.cancelling).toBe(false); expect(f.owned.stopRequested).toBe(true);
    fails = false; expect(await requestRunCancellation(f.owned, "user", f.hooks)).toEqual({ interrupted: true });
    expect(f.calls.filter(call => call === "release")).toHaveLength(2);
  });

  test("rejection clears only its own attempt, not a subsequently installed attempt", async () => {
    const gate = Promise.withResolvers<{ interrupted: boolean }>(), f = fixture({ interrupt: () => gate.promise });
    const first = requestRunCancellation(f.owned, "worker", f.hooks);
    await Promise.resolve(); await Promise.resolve();
    const replacement = Promise.resolve({ interrupted: false }); f.owned.cancel = replacement;
    gate.reject(new Error("old request failed")); await expect(first).rejects.toThrow("old request failed");
    expect(f.owned.cancel).toBe(replacement);
  });

  test("two owners with the same source never share cancellation attempts", async () => {
    const a = fixture(), b = fixture();
    const first = requestRunCancellation(a.owned, "worker", a.hooks), second = requestRunCancellation(b.owned, "user", b.hooks);
    expect(first).not.toBe(second); await Promise.all([first, second]);
    expect(a.calls).toEqual(["stopping", "interrupt:worker", "release"]);
    expect(b.calls).toEqual(["stopping", "current", "interrupt:user", "release"]);
  });

  for (const retained of [false, true]) test(`terminal observation cannot release an in-flight cancellation; retained=${retained}`, async () => {
    let retain = false;
    const interrupt = Promise.withResolvers<{ interrupted: boolean }>(), entered = Promise.withResolvers<void>();
    const f = fixture({ interrupt: () => { entered.resolve(); return interrupt.promise; } });
    const coordinator = new ConversationCoordinator<RunOwner>({ maxConcurrentRuns: 1, retained: () => retain });
    const reserved = coordinator.reserveAdmission({ conversationIds: [f.owned.run.sessionId], intent: { kind: "user-prompt" } });
    if (!reserved.ready) throw new Error(reserved.reason);
    expect(coordinator.installOwner(reserved.lease, f.owned)).toEqual({ ready: true });
    coordinator.releaseAdmission(reserved.lease);
    const attempt = requestRunCancellation(f.owned, "user", { ...f.hooks, release: value => { coordinator.releaseOwner(value); } });
    await entered.promise;
    f.owned.settled = true; f.owned.run.status = "interrupted";
    expect(coordinator.releaseOwner(f.owned)).toBe(false);
    expect(coordinator.getOwner(f.owned.run.sessionId)).toBe(f.owned);
    expect(coordinator.reserveAdmission({ conversationIds: [f.owned.run.sessionId], intent: { kind: "user-prompt" } }).ready).toBe(false);
    retain = retained;
    interrupt.resolve({ interrupted: true });
    expect(await attempt).toEqual({ interrupted: true });
    expect(f.owned.cancelling).toBe(false);
    expect(coordinator.hasOwner(f.owned.run.sessionId)).toBe(retained);
    await coordinator.close();
  });
});
