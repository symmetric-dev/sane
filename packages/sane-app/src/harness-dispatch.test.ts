import { expect, test } from "bun:test";
import type { DispatchSource, DispatchTerminalGuards, HarnessDispatchRequest } from "../shared/conversation/dispatch-contract";
import { isHarness } from "../shared/conversation/harness-capabilities";
import {
  createClaudeDispatchAdapter, createOpenCodeDispatchAdapter, HarnessDispatchRegistry,
  terminalDispatchReadiness, type ClaudeSettlementEvidence, type DispatchLifecycleHooks,
  type HarnessDispatchAdapter, type OpenCodeSettlementEvidence,
} from "./harness-dispatch";
import type { RunOwner } from "./run-owner";
import { ConversationCoordinator, type ConversationAdmissionLease } from "./conversation-coordinator";

const automation = { "queued-user": { supported: true }, "worker-report": { supported: true }, handoff: { supported: true } } as const;
const source: DispatchSource = { harnessId: "third-harness", sessionId: "conversation", authorityId: "authority", nativeSessionId: "native", cwd: "/checkout" };
const request = (patch: Partial<HarnessDispatchRequest> = {}): HarnessDispatchRequest => ({ source, origin: "user", prompt: "prompt", resume: true, ...patch });
const pending = <T>() => Promise.withResolvers<T>();
const safeGuards = (): DispatchTerminalGuards => ({ settled: true, released: true, status: "completed", cancelling: false, stopRequested: false, stopping: false, closing: false, storageFailed: false, reconciliationRequired: false });
const completedOwner = (): RunOwner => ({ run: { runId: "run", sessionId: source.sessionId, cwd: source.cwd, status: "completed", createdAt: "now", nativeCommandId: "exact-command" }, settled: true, done: Promise.resolve() });

function fixture() {
  const calls: string[] = [], execution = pending<void>(), reconciliation = pending<void>(), proof = pending<void>();
  let installed: RunOwner | undefined;
  const state = { closing: false, storageFailed: false, reconciliationRequired: false, proofAllowed: true, failClosed: 0 };
  const adapter: HarnessDispatchAdapter = {
    id: source.harnessId, automation,
    readiness: async expected => ({ source: expected, readiness: { ready: true } }),
    execute: async (owner, prompt, resume, ready) => {
      calls.push("execute");
      expect(installed).toBe(owner); expect(owner.done).toBeInstanceOf(Promise);
      expect(prompt).toBe("prompt"); expect(resume).toBe(true);
      ready(true); ready(false); // Service finalizers must not erase admission.
      await execution.promise;
      owner.run.status = "completed";
    },
    successfulSettlement: async () => { calls.push("proof"); await proof.promise; return state.proofAllowed ? { ready: true } : { ready: false, reason: "No terminal proof" }; },
  };
  const hooks: DispatchLifecycleHooks = {
    install: done => { calls.push("install"); const owner = completedOwner(); owner.run.status = "running"; owner.done = done; owner.settled = false; installed = owner; return owner; },
    owns: owner => installed === owner,
    settle: owner => { calls.push("settle"); owner.settled = true; },
    release: owner => { calls.push("release"); if (!state.reconciliationRequired && !owner.cancelling) installed = undefined; },
    failClosed: () => { calls.push("failClosed"); state.failClosed++; state.storageFailed = state.reconciliationRequired = true; },
    terminate: async () => { calls.push("terminate"); },
    guards: () => ({ ...safeGuards(), ...state }),
    wake: () => { calls.push("wake"); },
  };
  const registry = new HarnessDispatchRegistry(); registry.register(adapter);
  return { calls, adapter, hooks, state, registry, execution, reconciliation, proof, installed: () => installed };
}

/** Compose the real lifecycle and arbitration, with no domain policy masking a
 * reconciliation gap and no native transport or timers. */
function coordinatedFixture(order: "before-release" | "after-release" = "after-release") {
  const f = fixture(), entered = pending<void>(), wakes: boolean[] = [];
  const coordinator: ConversationCoordinator = new ConversationCoordinator({ maxConcurrentRuns: 1,
    retained: () => f.state.reconciliationRequired,
    wake: { dispatch: () => { wakes.push(coordinator.inspectReadiness({ conversationId: source.sessionId, intent: { kind: "user-prompt" }, phase: "dispatch" }).ready); }, onError: error => { throw error; } },
  });
  let lease: ConversationAdmissionLease;
  const install = f.hooks.install;
  f.hooks.install = done => {
    const owner = install(done);
    const decision = coordinator.installOwner(lease, owner);
    if (!decision.ready) throw new Error(decision.reason);
    return owner;
  };
  f.hooks.owns = owner => coordinator.owns(owner);
  f.hooks.release = owner => { f.calls.push("release"); coordinator.releaseOwner(owner); };
  f.hooks.wake = undefined;
  f.hooks.reconciliation = { order,
    begin: owner => {
      f.calls.push("barrier"); const token = coordinator.beginReconciliation(owner);
      return { end: () => { expect(coordinator.endReconciliation(token)).toBe(true); f.calls.push("barrier-ended"); } };
    },
    run: async () => { f.calls.push("reconcile"); entered.resolve(); await f.reconciliation.promise; f.calls.push("reconciled"); },
  };
  const start = () => {
    const admission = coordinator.reserveAdmission({ conversationIds: [source.sessionId], intent: { kind: "worker-report" } });
    if (!admission.ready) throw new Error(admission.reason);
    lease = admission.lease;
    try { return f.registry.start(request({ origin: order === "after-release" ? "worker-report" : "handoff" }), f.hooks); }
    finally { coordinator.releaseAdmission(lease); }
  };
  return { ...f, coordinator, entered, wakes, start };
}

for (const order of ["before-release", "after-release"] as const) test(`composed coordinator blocks admission, dispatch, idle and enqueue throughout ${order} reconciliation`, async () => {
  const f = coordinatedFixture(order), lifecycle = f.start();
  await lifecycle.admission; f.execution.resolve(); await f.entered.promise;
  await f.coordinator.drainWake();
  expect(f.coordinator.hasReconciliation(source.sessionId)).toBe(true);
  expect(f.coordinator.owns(lifecycle.owner)).toBe(order === "before-release");
  for (const phase of ["enqueue", "admission", "dispatch"] as const) {
    expect(f.coordinator.inspectReadiness({ conversationId: source.sessionId, intent: { kind: "user-prompt" }, phase })).toMatchObject({ ready: false, code: "reconciliation-pending" });
  }
  expect(f.coordinator.inspectReadiness({ conversationId: source.sessionId, intent: { kind: "inspect-idle" }, phase: "admission" }).ready).toBe(false);
  expect(f.coordinator.reserveAdmission({ conversationIds: [source.sessionId], intent: { kind: "user-prompt" } })).toMatchObject({ ready: false, code: "reconciliation-pending" });
  expect(f.coordinator.reserveAdmission({ conversationIds: ["other"], intent: { kind: "user-prompt" } })).toMatchObject({ ready: false, code: "capacity" });
  expect(f.wakes.every(ready => !ready)).toBe(true);
  expect(f.calls.filter(call => call === "execute")).toHaveLength(1);
  expect((await lifecycle.successfulSettlement()).ready).toBe(false);
  f.reconciliation.resolve(); await lifecycle.done; await f.coordinator.drainWake();
  expect(f.calls.indexOf("barrier")).toBeLessThan(f.calls.indexOf("release"));
  expect(f.calls.indexOf("release") < f.calls.indexOf("reconciled")).toBe(order === "after-release");
  expect(f.coordinator.hasReconciliation(source.sessionId)).toBe(false); expect(f.wakes.at(-1)).toBe(true);
  f.proof.resolve(); expect((await lifecycle.successfulSettlement()).ready).toBe(true);
  const next = f.start(); await next.admission; await next.done;
  expect(f.calls.filter(call => call === "execute")).toHaveLength(2);
});

for (const order of ["before-release", "after-release"] as const) test(`composed ${order} reconciliation failure retains its barrier without hanging done`, async () => {
  const f = coordinatedFixture(order);
  f.hooks.reconciliation = { ...f.hooks.reconciliation!, run: async () => { f.entered.resolve(); await f.reconciliation.promise; throw new Error("source journal failed"); } };
  const lifecycle = f.start(); await lifecycle.admission; f.execution.resolve(); await f.entered.promise;
  f.reconciliation.resolve(); await lifecycle.done;
  expect(f.state.failClosed).toBe(1); expect(f.coordinator.hasReconciliation(source.sessionId)).toBe(true);
  expect(f.coordinator.owns(lifecycle.owner)).toBe(order === "before-release");
  expect(f.calls).not.toContain("barrier-ended"); expect(f.calls).not.toContain("proof");
  expect((await lifecycle.successfulSettlement()).ready).toBe(false);
  expect(f.coordinator.reserveAdmission({ conversationIds: [source.sessionId], intent: { kind: "user-prompt" } }).ready).toBe(false);
  await f.coordinator.close(); expect(f.coordinator.hasReconciliation(source.sessionId)).toBe(true);
});

test("done covers processing and reconciliation, not ownership retained by in-flight cancellation", async () => {
  const f = coordinatedFixture(), lifecycle = f.start(); await lifecycle.admission;
  lifecycle.owner.cancelling = true; lifecycle.owner.stopRequested = true;
  f.execution.resolve(); await f.entered.promise; f.reconciliation.resolve(); await lifecycle.done;
  expect(lifecycle.owner.done).toBe(lifecycle.done); expect(lifecycle.owner.settled).toBe(true);
  expect(f.coordinator.hasReconciliation(source.sessionId)).toBe(false);
  expect(f.coordinator.owns(lifecycle.owner)).toBe(true);
  expect(f.coordinator.reserveAdmission({ conversationIds: [source.sessionId], intent: { kind: "user-prompt" } })).toMatchObject({ ready: false, code: "conversation-busy" });
  expect((await lifecycle.successfulSettlement()).ready).toBe(false);
  lifecycle.owner.cancelling = false; expect(f.coordinator.releaseOwner(lifecycle.owner)).toBe(true);
  expect(f.coordinator.inspectReadiness({ conversationId: source.sessionId, intent: { kind: "user-prompt" }, phase: "admission" })).toEqual({ ready: true });
  expect((await lifecycle.successfulSettlement()).ready).toBe(false); expect(f.calls).not.toContain("proof");
});

test("failed barrier acquisition retains ownership and resolves done without entering unprotected reconciliation", async () => {
  const f = coordinatedFixture();
  f.hooks.reconciliation = { ...f.hooks.reconciliation!, begin: () => { throw new Error("barrier unavailable"); }, run: async () => { throw new Error("unprotected source hook must not run"); } };
  const lifecycle = f.start(); await lifecycle.admission; f.execution.resolve(); await lifecycle.done;
  expect(f.state.failClosed).toBe(1); expect(f.coordinator.owns(lifecycle.owner)).toBe(true);
  expect(f.calls).not.toContain("release"); expect((await lifecycle.successfulSettlement()).ready).toBe(false);
});

test("fake third harness dispatches through registration without widening production validators", async () => {
  const f = fixture(); expect(isHarness(source.harnessId)).toBe(false);
  expect(await f.registry.readiness(source, "worker-report")).toEqual({ ready: true });
  const lifecycle = f.registry.start(request({ origin: "handoff" }), f.hooks);
  expect(f.calls).toEqual(["install"]); // No execute during synchronous installation.
  expect(f.installed()).toBe(lifecycle.owner); expect(lifecycle.owner.done).toBe(lifecycle.done);
  expect(await lifecycle.admission).toEqual({ state: "admitted" });
  expect(await lifecycle.admission).not.toHaveProperty("nativeAcceptance");
  f.execution.resolve(); f.proof.resolve(); await lifecycle.done;
  expect(f.calls).toEqual(["install", "execute", "settle", "release", "proof", "wake"]);
});

test("registry rejects duplicate, unknown and omitted IDs without a default", () => {
  const f = fixture();
  expect(() => f.registry.register(f.adapter)).toThrow("already registered");
  for (const id of [undefined, null, "unknown", "", 1]) {
    expect(f.registry.get(id)).toBeUndefined(); expect(() => f.registry.require(id)).toThrow("Unknown dispatch harness");
  }
  expect(() => f.registry.start(request({ source: { ...source, harnessId: "unknown" } }), f.hooks)).toThrow("Unknown dispatch harness");
  expect(f.calls).toEqual([]);
});

test("unsupported or undeclared automation fails closed before readiness or owner installation", async () => {
  for (const support of [{ supported: false, reason: "No unattended turns" }, undefined]) {
    const f = fixture(), registry = new HarnessDispatchRegistry();
    registry.register({ ...f.adapter, automation: { ...automation, handoff: support } as HarnessDispatchAdapter["automation"], readiness: async () => { throw new Error("must not evaluate"); } });
    expect(() => registry.start(request({ origin: "handoff" }), f.hooks)).toThrow(support ? "No unattended turns" : "not explicitly declared");
    await expect(registry.readiness(source, "handoff")).rejects.toThrow();
    expect(f.calls).toEqual([]);
  }
});

test("queued-user requires explicit automation support while immediate user remains supported", async () => {
  for (const support of [{ supported: false, reason: "Queued user drain unsupported" }, undefined]) {
    const f = fixture(), registry = new HarnessDispatchRegistry();
    const { "queued-user": _queued, ...otherAutomation } = automation;
    const declared = support ? { ...otherAutomation, "queued-user": support } : otherAutomation;
    const evaluated: string[] = [];
    registry.register({ ...f.adapter, automation: declared as HarnessDispatchAdapter["automation"],
      readiness: async (expected, origin) => { evaluated.push(origin); return { source: expected, readiness: { ready: true } }; },
    });
    expect(() => registry.start(request({ origin: "queued-user" }), f.hooks)).toThrow(support ? "Queued user drain unsupported" : "not explicitly declared");
    await expect(registry.readiness(source, "queued-user")).rejects.toThrow();
    expect(evaluated).toEqual([]); expect(f.calls).toEqual([]);
    expect(await registry.readiness(source, "user")).toEqual({ ready: true });
    const lifecycle = registry.start(request(), f.hooks);
    expect(await lifecycle.admission).toEqual({ state: "admitted" });
    f.execution.resolve(); f.proof.resolve(); await lifecycle.done;
  }
});

test("fake third harness explicitly supports automatic queued-user dispatch", async () => {
  const f = fixture();
  expect(await f.registry.readiness(source, "queued-user")).toEqual({ ready: true });
  const lifecycle = f.registry.start(request({ origin: "queued-user" }), f.hooks);
  expect(await lifecycle.admission).toEqual({ state: "admitted" });
  f.execution.resolve(); f.proof.resolve(); await lifecycle.done;
  expect(f.calls).toEqual(["install", "execute", "settle", "release", "proof", "wake"]);
});

test("readiness is pinned across asynchronous native identity and checkout changes", async () => {
  for (const change of [{ harnessId: "other" }, { sessionId: "other" }, { authorityId: "other" }, { nativeSessionId: "other" }, { cwd: "/other" }]) {
    const f = fixture(), registry = new HarnessDispatchRegistry();
    registry.register({ ...f.adapter, readiness: async expected => ({ source: { ...expected, ...change }, readiness: { ready: true } }) });
    expect(await registry.readiness(source, "user")).toMatchObject({ ready: false, code: "dispatch-source-mismatch" });
  }
  const f = fixture(), registry = new HarnessDispatchRegistry(), wait = pending<void>(), input = { ...source };
  registry.register({ ...f.adapter, readiness: async expected => { await wait.promise; return { source: expected, readiness: { ready: false, reason: "busy" } }; } });
  const evaluation = registry.readiness(input, "user"); input.nativeSessionId = "changed"; wait.resolve();
  expect(await evaluation).toEqual({ ready: false, reason: "busy" });
});

test("installation failure or incomplete owner publication cannot invoke execute", async () => {
  for (const badInstall of ["throws", "unowned", "wrong-done", "wrong-session", "wrong-cwd", "settled"] as const) {
    const f = fixture(), install = f.hooks.install;
    f.hooks.install = done => {
      if (badInstall === "throws") throw new Error("claim failed");
      const owner = install(done);
      if (badInstall === "wrong-done") owner.done = Promise.resolve();
      if (badInstall === "wrong-session") owner.run.sessionId = "wrong";
      if (badInstall === "wrong-cwd") owner.run.cwd = "/other";
      if (badInstall === "settled") owner.settled = true;
      return owner;
    };
    if (badInstall === "unowned") f.hooks.owns = () => false;
    expect(() => f.registry.start(request(), f.hooks)).toThrow();
    await Promise.resolve(); expect(f.calls).not.toContain("execute"); expect(f.state.failClosed).toBe(1);
  }
});

test("a false callback or execute failure preserves admission uncertainty, never definite non-submission", async () => {
  for (const mode of ["false", "throws", "silent"] as const) {
    const f = fixture(), registry = new HarnessDispatchRegistry();
    registry.register({ ...f.adapter, execute: async (owner, _prompt, _resume, ready) => {
      if (mode === "throws") throw new Error("ack lost after possible submission");
      if (mode === "false") { ready(false); ready(true); }
      owner.run.status = "completed";
    } });
    const lifecycle = registry.start(request(), f.hooks);
    expect(await lifecycle.admission).toEqual({ state: "unconfirmed" }); await lifecycle.done;
    expect(f.calls).not.toContain("wake"); expect(f.calls).not.toContain("proof");
    if (mode === "throws") { expect(f.calls).toContain("terminate"); expect(f.installed()).toBe(lifecycle.owner); }
  }
});

test("admitted run with lost execution outcome stays admitted, not natively accepted or wakeable", async () => {
  const f = fixture(), registry = new HarnessDispatchRegistry();
  registry.register({ ...f.adapter, execute: async (_owner, _prompt, _resume, ready) => { ready(true); throw new Error("native acceptance unknown"); } });
  const lifecycle = registry.start(request(), f.hooks);
  expect(await lifecycle.admission).toEqual({ state: "admitted" }); await lifecycle.done;
  expect(f.state.failClosed).toBe(1); expect(f.calls).not.toContain("wake");
});

for (const order of ["before-release", "after-release"] as const) test(`${order} reconciliation gates done and wake while preserving source-specific release order`, async () => {
  const f = fixture(), entered = pending<void>();
  f.hooks.reconciliation = { order, begin: () => ({ end: () => {} }), run: async () => { f.calls.push("reconcile"); entered.resolve(); await f.reconciliation.promise; f.calls.push("reconciled"); } };
  const lifecycle = f.registry.start(request(), f.hooks); let done = false; void lifecycle.done.then(() => { done = true; });
  await lifecycle.admission; f.execution.resolve(); await entered.promise;
  expect(f.calls).not.toContain("proof"); expect(f.calls).not.toContain("wake"); expect(done).toBe(false);
  expect(f.calls.includes("release")).toBe(order === "after-release");
  f.reconciliation.resolve(); f.proof.resolve(); await lifecycle.done;
  expect(f.calls).toEqual(order === "before-release"
    ? ["install", "execute", "reconcile", "reconciled", "settle", "release", "proof", "wake"]
    : ["install", "execute", "settle", "release", "reconcile", "reconciled", "proof", "wake"]);
});

test("failed reconciliation fails closed and blocks wake in either source ordering", async () => {
  for (const order of ["before-release", "after-release"] as const) {
    const f = fixture(); f.hooks.reconciliation = { order, begin: () => ({ end: () => {} }), run: async () => { throw new Error("journal failed"); } };
    const lifecycle = f.registry.start(request(), f.hooks); await lifecycle.admission; f.execution.resolve(); await lifecycle.done;
    expect(f.state.failClosed).toBe(1); expect(f.calls).not.toContain("wake"); expect(f.calls).not.toContain("proof");
  }
});

test("no wake while ownership remains held or while native success proof is missing", async () => {
  for (const mode of ["retained", "no-proof"] as const) {
    const f = fixture();
    if (mode === "retained") f.hooks.release = () => { f.calls.push("release-held"); };
    else f.state.proofAllowed = false;
    const lifecycle = f.registry.start(request(), f.hooks); await lifecycle.admission; f.execution.resolve(); f.proof.resolve(); await lifecycle.done;
    expect(f.calls).not.toContain("wake");
  }
});

test("cancellation, stop, shutdown and reconciliation guards prevent wake, including after async proof", async () => {
  for (const flag of ["cancelling", "stopRequested", "stopping", "closing", "storageFailed", "reconciliationRequired"] as const) {
    for (const timing of ["before-proof", "during-proof"] as const) {
      const f = fixture(), proofEntered = pending<void>(), registry = new HarnessDispatchRegistry();
      registry.register({ ...f.adapter, successfulSettlement: async () => { f.calls.push("proof"); proofEntered.resolve(); await f.proof.promise; return { ready: true }; } });
      const lifecycle = registry.start(request(), f.hooks); await lifecycle.admission;
      const block = () => {
        if (flag === "stopping") lifecycle.owner.stopping = Promise.resolve(true);
        else if (flag === "cancelling" || flag === "stopRequested") lifecycle.owner[flag] = true;
        else f.state[flag] = true;
      };
      if (timing === "before-proof") block();
      f.execution.resolve();
      if (timing === "during-proof") { await proofEntered.promise; block(); }
      f.proof.resolve(); await lifecycle.done; expect(f.calls).not.toContain("wake");
    }
  }
});

test("terminal readiness requires successful completed lifecycle and released ownership", () => {
  for (const patch of [{ settled: false }, { released: false }, { status: "running" }, { status: "failed" }, { status: "interrupted" }]) {
    expect(terminalDispatchReadiness({ ...safeGuards(), ...patch }).ready).toBe(false);
  }
});

test("Claude success proof requires zero exit, dead process group AND drained streams", async () => {
  const f = fixture(), owner = completedOwner(), ccSource = { ...source, harnessId: "claude-code" };
  const good: ClaudeSettlementEvidence = { childPresent: true, exitCode: 0, groupAlive: false, streamsDrained: true };
  for (const patch of [{}, { childPresent: false }, { exitCode: null }, { exitCode: 1 }, { groupAlive: true }, { streamsDrained: false }]) {
    const adapter = createClaudeDispatchAdapter({ ...f.adapter, settlementEvidence: () => ({ ...good, ...patch }) });
    expect((await adapter.successfulSettlement(owner, ccSource, safeGuards)).ready).toBe(Object.keys(patch).length === 0);
  }
  const adapter = createClaudeDispatchAdapter({ ...f.adapter, settlementEvidence: () => good });
  expect((await adapter.successfulSettlement(owner, ccSource, () => ({ ...safeGuards(), cancelling: true }))).ready).toBe(false);
});

test("OpenCode success requires exact command outcome and fresh source-pinned native readiness", async () => {
  const f = fixture(), owner = completedOwner(), ocSource = { ...source, harnessId: "opencode" };
  for (const mode of ["success", "unknown", "failed", "interrupted", "other-command", "busy", "source-changed", "no-command"] as const) {
    const calls: string[] = [];
    owner.run.nativeCommandId = mode === "no-command" ? undefined : "exact-command";
    const adapter = createOpenCodeDispatchAdapter({ ...f.adapter,
      exactCommand: async (_owner, expected, commandId) => {
        calls.push("command"); expect(expected).toEqual(ocSource); expect(commandId).toBe("exact-command");
        return { commandId: mode === "other-command" ? "latest-message" : commandId,
          outcome: ["unknown", "failed", "interrupted"].includes(mode) ? mode as OpenCodeSettlementEvidence["outcome"] : "succeeded" };
      },
      nativeReadiness: async expected => { calls.push("native"); return { source: mode === "source-changed" ? { ...expected, authorityId: "other" } : expected,
        readiness: mode === "busy" ? { ready: false, reason: "Other pending input" } : { ready: true } }; },
    });
    expect((await adapter.successfulSettlement(owner, ocSource, safeGuards)).ready).toBe(mode === "success");
    if (["unknown", "failed", "interrupted", "other-command", "no-command"].includes(mode)) expect(calls).not.toContain("native");
  }
});

test("OpenCode rechecks live guards after each awaited observation", async () => {
  for (const phase of ["command", "native"] as const) {
    const f = fixture(), owner = completedOwner(), ocSource = { ...source, harnessId: "opencode" }, state = { ...safeGuards() };
    const adapter = createOpenCodeDispatchAdapter({ ...f.adapter,
      exactCommand: async () => { if (phase === "command") state.closing = true; return { commandId: "exact-command", outcome: "succeeded" }; },
      nativeReadiness: async expected => { if (phase === "command") throw new Error("must not observe native"); state.cancelling = true; return { source: expected, readiness: { ready: true } }; },
    });
    expect((await adapter.successfulSettlement(owner, ocSource, () => state)).ready).toBe(false);
  }
});

test("automation declarations cannot be widened by mutating the original registration", async () => {
  for (const origin of ["queued-user", "worker-report", "handoff"] as const) {
    const f = fixture(), registry = new HarnessDispatchRegistry();
    const support = { supported: false as boolean, reason: "No automation" };
    const mutable = { ...automation, [origin]: support } as HarnessDispatchAdapter["automation"];
    registry.register({ ...f.adapter, automation: mutable });
    support.supported = true;
    await expect(registry.readiness(source, origin)).rejects.toThrow("No automation");
    expect(Object.isFrozen(registry.require(source.harnessId).automation[origin])).toBe(true);
    expect(Object.isFrozen(registry.require(source.harnessId))).toBe(true);
  }
});

test("OpenCode cannot wake if exact command identity changes during native readiness", async () => {
  const f = fixture(), owner = completedOwner(), ocSource = { ...source, harnessId: "opencode" };
  const adapter = createOpenCodeDispatchAdapter({ ...f.adapter,
    exactCommand: async () => ({ commandId: "exact-command", outcome: "succeeded" }),
    nativeReadiness: async expected => { owner.run.nativeCommandId = "replacement"; return { source: expected, readiness: { ready: true } }; },
  });
  expect((await adapter.successfulSettlement(owner, ocSource, safeGuards)).ready).toBe(false);
});

test("settled lifecycle proof can be queried without optional wake and remains live", async () => {
  const f = fixture(); f.hooks.wake = undefined;
  const lifecycle = f.registry.start(request(), f.hooks);
  expect((await lifecycle.successfulSettlement()).ready).toBe(false);
  await lifecycle.admission; f.execution.resolve(); await lifecycle.done;
  expect(f.calls).not.toContain("proof");
  f.proof.resolve();
  expect(await lifecycle.successfulSettlement()).toEqual({ ready: true });
  expect(f.calls).not.toContain("wake");
  lifecycle.owner.stopRequested = true;
  expect((await lifecycle.successfulSettlement()).ready).toBe(false);
  expect(f.calls.filter(call => call === "proof")).toHaveLength(1);
});

for (const order of ["before-release", "after-release"] as const) test(`independent proof cannot bypass ${order} reconciliation`, async () => {
  const f = fixture(), entered = pending<void>(); f.hooks.wake = undefined;
  f.hooks.reconciliation = { order, begin: () => ({ end: () => {} }), run: async () => { entered.resolve(); await f.reconciliation.promise; } };
  const lifecycle = f.registry.start(request(), f.hooks);
  await lifecycle.admission; f.execution.resolve(); await entered.promise;
  expect((await lifecycle.successfulSettlement()).ready).toBe(false);
  expect(f.calls).not.toContain("proof");
  f.reconciliation.resolve(); await lifecycle.done; f.proof.resolve();
  expect(await lifecycle.successfulSettlement()).toEqual({ ready: true });
});
