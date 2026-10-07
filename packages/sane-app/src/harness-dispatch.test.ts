import { expect, test } from "bun:test";
import type { DispatchSource, DispatchTerminalGuards, HarnessDispatchRequest } from "../shared/conversation/dispatch-contract";
import { isHarness } from "../shared/conversation/harness-capabilities";
import {
  createClaudeDispatchAdapter, createOpenCodeDispatchAdapter, HarnessDispatchRegistry,
  DispatchProofUnavailableError, HarnessDispatchError,
  terminalDispatchReadiness, type ClaudeSettlementEvidence, type DispatchLifecycleHooks,
  type HarnessDispatchAdapter, type OpenCodeSettlementEvidence,
} from "./harness-dispatch";
import type { RunOwner } from "./run-owner";
import { ConversationCoordinator, type ConversationAdmissionLease } from "./conversation-coordinator";
import { DispatchPreNativeRefusal } from "./dispatch-evidence";

const automation = { "queued-user": { supported: true }, "worker-report": { supported: true }, handoff: { supported: true } } as const;
const source: DispatchSource = { harnessId: "third-harness", sessionId: "conversation", authorityId: "authority", nativeSessionId: "native", cwd: "/checkout" };
const request = (patch: Partial<HarnessDispatchRequest> = {}): HarnessDispatchRequest => ({ source, origin: "user", prompt: "prompt", resume: true, ...patch });
const pending = <T>() => Promise.withResolvers<T>();
const safeGuards = (): DispatchTerminalGuards => ({ settled: true, released: true, status: "completed", cancelling: false, stopRequested: false, stopping: false, closing: false, storageFailed: false, reconciliationRequired: false });
const completedOwner = (): RunOwner => ({ run: { runId: "run", sessionId: source.sessionId, cwd: source.cwd, status: "completed", createdAt: "now", nativeCommandId: "exact-command" }, settled: true, done: Promise.resolve() });

test("unavailable read-only proof is coded, does not fail closed, and fresh proof succeeds", async () => {
  const f = fixture(); let unavailable = true;
  f.hooks.wake = undefined;
  const registry = new HarnessDispatchRegistry(); registry.register({ ...f.adapter, successfulSettlement: async () => {
    if (unavailable) throw new DispatchProofUnavailableError("offline timeout"); return { ready: true };
  } });
  const lifecycle = registry.start(request(), f.hooks); await lifecycle.admission; f.execution.resolve(); await lifecycle.done;
  expect(await lifecycle.successfulSettlement()).toMatchObject({ ready: false, code: "dispatch-proof-unavailable" });
  expect(f.state.failClosed).toBe(0); expect(f.state.storageFailed).toBe(false);
  unavailable = false; expect(await lifecycle.successfulSettlement()).toEqual({ ready: true });
});

test("explicit source drift is a denial, while an invariant failure still poisons lifecycle", async () => {
  const f = fixture(); f.hooks.wake = undefined; let drift = true;
  const registry = new HarnessDispatchRegistry(); registry.register({ ...f.adapter, successfulSettlement: async () => {
    if (drift) throw new HarnessDispatchError("dispatch-source-mismatch", "Source changed"); throw new Error("proof invariant failed");
  } });
  const lifecycle = registry.start(request(), f.hooks); await lifecycle.admission; f.execution.resolve(); await lifecycle.done;
  expect(await lifecycle.successfulSettlement()).toMatchObject({ ready: false, code: "dispatch-source-mismatch" }); expect(f.state.failClosed).toBe(0);
  drift = false; expect(await lifecycle.successfulSettlement()).toMatchObject({ ready: false, code: "reconciliation-required" }); expect(f.state.failClosed).toBe(1);
});

test("queued origin is independent of legacy receipt for a permitted adapter and ready does not prove submission", async () => {
  const f = fixture(); f.hooks.wake = undefined;
  const lifecycle = f.registry.start(request({ origin: "queued-user" }), f.hooks);
  await lifecycle.admission;
  expect(lifecycle.owner.run.queuedFollowupId).toBeUndefined();
  expect(lifecycle.submissionEvidence()).toMatchObject({ runId: "run", nativeCommandId: "exact-command", source, submission: "not-submitted" });
  f.execution.resolve(); await lifecycle.done;
  // This legacy/injected adapter never supplied native boundary evidence;
  // ready(true) alone is neither non-submission nor acceptance evidence.
  expect(lifecycle.submissionEvidence()).toMatchObject({ submission: "unknown", nativeAcceptance: "unknown" });
});

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

for (const propagated of [false, true]) test(`certified boundary refusal ${propagated ? "propagates" : "is caught by adapter"} without global poison or false success`, async () => {
  const f = fixture(), registry = new HarnessDispatchRegistry(), refusal = new DispatchPreNativeRefusal(new Error("durably paused"));
  const observations: unknown[] = [];
  f.hooks.evidence = { beforeNative: () => { throw refusal; }, outcome: value => { observations.push(value); expect(f.state.closing).toBe(true); } };
  registry.register({ ...f.adapter, execute: async (owner, _prompt, _resume, ready) => {
    ready(true); owner.run.status = "completed"; // A lying adapter must not prove success.
    f.state.closing = true;
    if (propagated) owner.dispatchEvidence!.beforeNative();
    else {
      expect(() => owner.dispatchEvidence!.beforeNative()).toThrow(refusal);
      expect(() => owner.dispatchEvidence!.beforeNative()).toThrow("replay forbidden");
    }
  } });
  const lifecycle = registry.start(request({ requestId: "request" }), f.hooks); await lifecycle.done;
  expect(f.state.failClosed).toBe(0); expect(f.installed()).toBeUndefined();
  expect(f.calls).not.toContain("terminate"); expect(f.calls).not.toContain("proof"); expect(f.calls).not.toContain("wake");
  expect(observations).toEqual([lifecycle.submissionEvidence()]);
  expect(lifecycle.submissionEvidence()).toMatchObject({ requestId: "request", runId: "run", source, submission: "not-submitted", nativeAcceptance: "not-accepted" });
  f.state.closing = false;
  expect(await lifecycle.successfulSettlement()).toMatchObject({ ready: false, code: "dispatch-native-withheld" });
  lifecycle.owner.run.runId = "replacement";
  expect((await lifecycle.successfulSettlement()).ready).toBe(false); expect(f.state.failClosed).toBe(1);
  lifecycle.owner.run.runId = "run"; expect((await lifecycle.successfulSettlement()).ready).toBe(false);
});

for (const mode of ["outside-boundary", "different-marker", "later-unknown", "outcome-same-marker", "outcome-after-native", "async-hook"] as const)
  test(`refusal classification does not suppress ${mode}`, async () => {
    const f = fixture(), registry = new HarnessDispatchRegistry(), refusal = new DispatchPreNativeRefusal(new Error("paused"));
    f.hooks.evidence = {
      beforeNative: mode === "async-hook" ? async () => { throw refusal; } : () => { if (mode !== "outcome-after-native") throw refusal; },
      outcome: () => { if (mode === "outcome-same-marker" || mode === "outcome-after-native") throw refusal; },
    };
    registry.register({ ...f.adapter, execute: async (owner, _prompt, _resume, ready) => {
      ready(true);
      if (mode === "outside-boundary") throw refusal;
      if (mode === "outcome-after-native" || mode === "async-hook") { owner.dispatchEvidence!.beforeNative(); return; }
      expect(() => owner.dispatchEvidence!.beforeNative()).toThrow(refusal);
      if (mode === "different-marker") throw new DispatchPreNativeRefusal(new Error("paused"));
      if (mode === "later-unknown") throw new Error("later invariant");
    } });
    const lifecycle = registry.start(request(), f.hooks); await lifecycle.done;
    expect(f.state.failClosed).toBeGreaterThan(0); expect(f.installed()).toBe(lifecycle.owner);
    expect((await lifecycle.successfulSettlement()).ready).toBe(false); expect(f.calls).not.toContain("wake");
  });

test("certified propagated refusal still revalidates original owner identity", async () => {
  const f = fixture(), registry = new HarnessDispatchRegistry(), refusal = new DispatchPreNativeRefusal(new Error("paused"));
  f.hooks.evidence = { beforeNative: () => { throw refusal; } };
  registry.register({ ...f.adapter, execute: async owner => {
    try { owner.dispatchEvidence!.beforeNative(); }
    catch (error) { owner.run.runId = "replacement"; throw error; }
  } });
  const lifecycle = registry.start(request(), f.hooks); await lifecycle.done;
  expect(f.state.failClosed).toBeGreaterThan(0); expect(f.installed()).toBe(lifecycle.owner);
  expect((await lifecycle.successfulSettlement()).ready).toBe(false);
});

function openCodeFixture(proofPhase: "command" | "native" = "command") {
  const f = fixture(), registry = new HarnessDispatchRegistry(), entered = pending<void>(), commands: string[] = [];
  const ocSource = { ...source, harnessId: "opencode" };
  f.hooks.wake = undefined;
  registry.register(createOpenCodeDispatchAdapter({ ...f.adapter,
    exactCommand: async (_owner, expected, commandId) => {
      expect(expected).toEqual(ocSource); commands.push(commandId);
      if (proofPhase === "command") { entered.resolve(); await f.proof.promise; }
      return { commandId, outcome: "succeeded" };
    },
    nativeReadiness: async expected => {
      f.calls.push("native");
      if (proofPhase === "native") { entered.resolve(); await f.proof.promise; }
      return { source: expected, readiness: { ready: true } };
    },
  }));
  return { ...f, registry, entered, commands, start: () => registry.start(request({ source: ocSource }), f.hooks) };
}

const identityChanges: readonly [string, Partial<RunOwner["run"]>][] = [
  ["run ID", { runId: "replacement-run" }], ["session", { sessionId: "replacement-session" }],
  ["checkout", { cwd: "/replacement" }], ["native command", { nativeCommandId: "replacement-command" }],
];

for (const [name, change] of identityChanges) test(`installed ${name} mutation before proof fails closed without observing a replacement command`, async () => {
  const f = openCodeFixture(), lifecycle = f.start();
  await lifecycle.admission; f.execution.resolve(); await lifecycle.done;
  const installed = { ...lifecycle.owner.run };
  Object.assign(lifecycle.owner.run, change);
  expect(await lifecycle.successfulSettlement()).toMatchObject({ ready: false, code: "reconciliation-required" });
  expect(f.state.failClosed).toBe(1); expect(f.state.storageFailed).toBe(true);
  expect(f.commands).toEqual([]); expect(f.calls).not.toContain("native");
  Object.assign(lifecycle.owner.run, installed);
  expect((await lifecycle.successfulSettlement()).ready).toBe(false);
  expect(f.state.failClosed).toBe(1); expect(f.commands).toEqual([]);
  expect(lifecycle.submissionEvidence()).toMatchObject({ runId: "run", nativeCommandId: "exact-command", source: { ...source, harnessId: "opencode" } });
});

for (const phase of ["command", "native"] as const) {
  for (const [name, change] of identityChanges) test(`installed ${name} mutation during async ${phase} proof poisons lifecycle`, async () => {
    const f = openCodeFixture(phase), lifecycle = f.start();
    await lifecycle.admission; f.execution.resolve(); await lifecycle.done;
    const evaluation = lifecycle.successfulSettlement(); await f.entered.promise;
    const installed = { ...lifecycle.owner.run };
    Object.assign(lifecycle.owner.run, change); f.proof.resolve();
    expect(await evaluation).toMatchObject({ ready: false, code: "reconciliation-required" });
    expect(f.state.failClosed).toBe(1); expect(f.commands).toEqual(["exact-command"]);
    if (phase === "command") expect(f.calls).not.toContain("native");
    Object.assign(lifecycle.owner.run, installed);
    expect((await lifecycle.successfulSettlement()).ready).toBe(false);
    expect(f.commands).toEqual(["exact-command"]); expect(f.state.failClosed).toBe(1);
  });
}

for (const timing of ["before", "during"] as const) {
  for (const [name, change] of identityChanges) test(`installed ${name} mutation ${timing} execution cannot produce success proof`, async () => {
    const f = openCodeFixture(), lifecycle = f.start();
    if (timing === "during") await lifecycle.admission;
    Object.assign(lifecycle.owner.run, change); f.execution.resolve(); await lifecycle.done;
    expect(await lifecycle.admission).toEqual({ state: timing === "before" ? "unconfirmed" : "admitted" });
    expect(f.calls.includes("execute")).toBe(timing === "during");
    expect(f.state.failClosed).toBe(1); expect(f.calls).toContain("terminate");
    expect((await lifecycle.successfulSettlement()).ready).toBe(false); expect(f.commands).toEqual([]);
  });
}

test("unchanged installed OpenCode identity proves its exact command with live completed status", async () => {
  const f = openCodeFixture(), lifecycle = f.start();
  await lifecycle.admission; f.execution.resolve(); await lifecycle.done; f.proof.resolve();
  expect(await lifecycle.successfulSettlement()).toEqual({ ready: true });
  expect(f.commands).toEqual(["exact-command"]); expect(f.state.failClosed).toBe(0);
});

test("production command identity is established at installation: OpenCode present, Claude absent", async () => {
  for (const harnessId of ["opencode", "claude-code"]) {
    const f = fixture(), registry = new HarnessDispatchRegistry(), install = f.hooks.install;
    registry.register({ ...f.adapter, id: harnessId });
    f.hooks.install = done => {
      const owner = install(done);
      owner.run.nativeCommandId = harnessId === "opencode" ? undefined : "unexpected-command";
      return owner;
    };
    expect(() => registry.start(request({ source: { ...source, harnessId } }), f.hooks)).toThrow("synchronously installed");
    await Promise.resolve(); expect(f.calls).not.toContain("execute"); expect(f.state.failClosed).toBe(1);
  }
  const f = fixture(), registry = new HarnessDispatchRegistry(), install = f.hooks.install;
  f.hooks.wake = undefined;
  f.hooks.install = done => { const owner = install(done); owner.run.nativeCommandId = undefined; return owner; };
  registry.register(createClaudeDispatchAdapter({ ...f.adapter, settlementEvidence: () => ({ childPresent: true, exitCode: 0, groupAlive: false, streamsDrained: true }) }));
  const lifecycle = registry.start(request({ source: { ...source, harnessId: "claude-code" } }), f.hooks);
  await lifecycle.admission; f.execution.resolve(); await lifecycle.done;
  expect(lifecycle.submissionEvidence().nativeCommandId).toBeNull();
  expect(await lifecycle.successfulSettlement()).toEqual({ ready: true });
  lifecycle.owner.run.nativeCommandId = "unexpected-command";
  expect(await lifecycle.successfulSettlement()).toMatchObject({ ready: false, code: "reconciliation-required" });
  expect(f.state.failClosed).toBe(1);
});

test("released predecessor retains historical proof while a different owner is installed", async () => {
  const f = fixture(), registry = new HarnessDispatchRegistry(), nextExecution = pending<void>(); let executions = 0;
  f.hooks.wake = undefined;
  registry.register({ ...f.adapter, execute: async (owner, prompt, resume, ready) => {
    if (++executions === 2) { ready(true); await nextExecution.promise; owner.run.status = "completed"; }
    else await f.adapter.execute(owner, prompt, resume, ready);
  } });
  const previous = registry.start(request(), f.hooks);
  await previous.admission; f.execution.resolve(); await previous.done; f.proof.resolve();
  const next = registry.start(request(), f.hooks); await next.admission;
  expect(f.installed()).toBe(next.owner);
  expect(await previous.successfulSettlement()).toEqual({ ready: true });
  expect(f.installed()).toBe(next.owner); expect((await next.successfulSettlement()).ready).toBe(false);
  expect(f.state.failClosed).toBe(0); nextExecution.resolve(); await next.done;
});

test("identity contradiction during an unavailable read still fails closed rather than allowing proof retry", async () => {
  const f = fixture(), registry = new HarnessDispatchRegistry(), entered = pending<void>(); f.hooks.wake = undefined;
  registry.register({ ...f.adapter, successfulSettlement: async () => { entered.resolve(); await f.proof.promise; throw new DispatchProofUnavailableError("offline"); } });
  const lifecycle = registry.start(request(), f.hooks);
  await lifecycle.admission; f.execution.resolve(); await lifecycle.done;
  const evaluation = lifecycle.successfulSettlement(); await entered.promise;
  lifecycle.owner.run.runId = "replacement"; f.proof.resolve();
  expect(await evaluation).toMatchObject({ ready: false, code: "reconciliation-required" }); expect(f.state.failClosed).toBe(1);
  lifecycle.owner.run.runId = "run";
  expect((await lifecycle.successfulSettlement()).ready).toBe(false); expect(f.state.failClosed).toBe(1);
});

for (const [name, change] of identityChanges) test(`lifecycle rejects ${name} mutation even when an adapter returns success without reading live guards`, async () => {
  const f = fixture(), registry = new HarnessDispatchRegistry(), entered = pending<void>(); f.hooks.wake = undefined;
  registry.register({ ...f.adapter, successfulSettlement: async () => { entered.resolve(); await f.proof.promise; return { ready: true }; } });
  const lifecycle = registry.start(request(), f.hooks);
  await lifecycle.admission; f.execution.resolve(); await lifecycle.done;
  const evaluation = lifecycle.successfulSettlement(); await entered.promise;
  Object.assign(lifecycle.owner.run, change); f.proof.resolve();
  expect(await evaluation).toMatchObject({ ready: false, code: "reconciliation-required" }); expect(f.state.failClosed).toBe(1);
});

for (const [name, change] of identityChanges) test(`restored ${name} after failed proof cannot enter deferred execution or native hooks`, async () => {
  const f = fixture(), registry = new HarnessDispatchRegistry(); f.hooks.wake = undefined;
  f.hooks.evidence = { beforeNative: () => { f.calls.push("native-intent"); } };
  registry.register({ ...f.adapter, execute: async (owner, _prompt, _resume, ready) => {
    f.calls.push("execute"); owner.dispatchEvidence!.beforeNative(); f.calls.push("submit"); ready(true);
  } });
  const lifecycle = registry.start(request({ requestId: "request" }), f.hooks), installed = { ...lifecycle.owner.run };
  Object.assign(lifecycle.owner.run, change);
  const evaluation = lifecycle.successfulSettlement();
  // Restore synchronously, before the deferred execute microtask gets a turn.
  Object.assign(lifecycle.owner.run, installed);
  expect(await evaluation).toMatchObject({ ready: false, code: "reconciliation-required" });
  await lifecycle.done;
  expect(await lifecycle.admission).toEqual({ state: "unconfirmed" });
  expect(f.calls).not.toContain("execute"); expect(f.calls).not.toContain("native-intent"); expect(f.calls).not.toContain("submit");
  expect(f.state.failClosed).toBe(1); expect(f.calls).toContain("terminate");
  expect((await lifecycle.successfulSettlement()).ready).toBe(false);
  expect(lifecycle.submissionEvidence()).toMatchObject({ requestId: "request", runId: "run", nativeCommandId: "exact-command", source });
});

test("caught native-boundary identity contradiction refuses fresh retries even after identity is restored", async () => {
  const f = fixture(), registry = new HarnessDispatchRegistry(); f.hooks.wake = undefined;
  f.hooks.evidence = { beforeNative: () => { f.calls.push("native-intent"); } };
  registry.register({ ...f.adapter, execute: async (owner, _prompt, _resume, ready) => {
    const submit = () => { owner.dispatchEvidence!.beforeNative(); f.calls.push("submit"); };
    ready(true); owner.run.nativeCommandId = "replacement-command";
    expect(submit).toThrow("Installed dispatch run identity changed");
    owner.run.nativeCommandId = "exact-command";
    expect(submit).toThrow("Dispatch native admission closed");
    expect(submit).toThrow("Dispatch native admission closed");
    owner.run.status = "completed";
  } });
  const lifecycle = registry.start(request({ requestId: "request" }), f.hooks); await lifecycle.admission; await lifecycle.done;
  expect(f.state.failClosed).toBe(1); expect(f.state.storageFailed).toBe(true);
  expect(f.calls).not.toContain("native-intent"); expect(f.calls).not.toContain("submit");
  expect((await lifecycle.successfulSettlement()).ready).toBe(false); expect(f.calls).not.toContain("proof");
  expect(lifecycle.submissionEvidence()).toMatchObject({ requestId: "request", runId: "run", nativeCommandId: "exact-command", source });
});

test("synchronous durable hook that fails closed then restores identity cannot authorize native effects", async () => {
  const f = fixture(), registry = new HarnessDispatchRegistry(); f.hooks.wake = undefined;
  let evaluation: ReturnType<ReturnType<typeof registry.start>["successfulSettlement"]> | undefined;
  f.hooks.evidence = { beforeNative: () => {
    f.calls.push("native-intent"); lifecycle.owner.run.nativeCommandId = "replacement-command";
    evaluation = lifecycle.successfulSettlement();
    lifecycle.owner.run.nativeCommandId = "exact-command";
  } };
  registry.register({ ...f.adapter, execute: async (owner, _prompt, _resume, ready) => {
    const submit = () => { owner.dispatchEvidence!.beforeNative(); f.calls.push("submit"); };
    ready(true);
    expect(submit).toThrow("Dispatch native admission closed");
    expect(submit).toThrow("Dispatch native admission closed");
    owner.run.status = "completed";
  } });
  const lifecycle = registry.start(request({ requestId: "request" }), f.hooks); await lifecycle.done;
  expect(await evaluation).toMatchObject({ ready: false, code: "reconciliation-required" });
  expect(f.calls.filter(call => call === "native-intent")).toHaveLength(1); expect(f.calls).not.toContain("submit");
  expect(f.state.failClosed).toBe(1); expect((await lifecycle.successfulSettlement()).ready).toBe(false);
  expect(lifecycle.submissionEvidence()).toMatchObject({ requestId: "request", runId: "run", nativeCommandId: "exact-command", source, submission: "unknown" });
});

test("evidence storage failure before deferred execution permanently closes native entry", async () => {
  const f = fixture(), registry = new HarnessDispatchRegistry(); f.hooks.wake = undefined;
  let outcomes = 0;
  f.hooks.evidence = {
    beforeNative: () => { f.calls.push("native-intent"); },
    outcome: () => { if (++outcomes === 1) throw new Error("evidence storage failed"); },
  };
  registry.register({ ...f.adapter, execute: async (owner, _prompt, _resume, ready) => {
    f.calls.push("execute"); owner.dispatchEvidence!.beforeNative(); f.calls.push("submit"); ready(true);
  } });
  const lifecycle = registry.start(request({ requestId: "request" }), f.hooks);
  expect(() => lifecycle.owner.dispatchEvidence!.outcome("not-submitted", "not-accepted")).toThrow("evidence storage failed");
  await lifecycle.done;
  expect(f.calls).not.toContain("execute"); expect(f.calls).not.toContain("native-intent"); expect(f.calls).not.toContain("submit");
  expect(f.state.failClosed).toBe(1); expect(await lifecycle.admission).toEqual({ state: "unconfirmed" });
  expect((await lifecycle.successfulSettlement()).ready).toBe(false);
  expect(lifecycle.submissionEvidence()).toMatchObject({ requestId: "request", runId: "run", nativeCommandId: "exact-command", source, submission: "not-submitted" });
});

test("failed-closed storage after possible submission still records later accepted evidence without replay", async () => {
  const f = fixture(), registry = new HarnessDispatchRegistry(); f.hooks.wake = undefined;
  let outcomes = 0;
  f.hooks.evidence = {
    beforeNative: () => { f.calls.push("native-intent"); },
    outcome: value => { f.calls.push(`outcome:${value.nativeAcceptance}`); if (++outcomes === 1) throw new Error("evidence storage failed"); },
  };
  registry.register({ ...f.adapter, execute: async (owner, _prompt, _resume, ready) => {
    ready(true); owner.dispatchEvidence!.beforeNative(); f.calls.push("submit");
    expect(() => owner.dispatchEvidence!.outcome("unknown", "unknown")).toThrow("evidence storage failed");
    expect(() => owner.dispatchEvidence!.beforeNative()).toThrow("Dispatch native admission closed");
    owner.dispatchEvidence!.outcome("submitted", "accepted"); owner.run.status = "completed";
  } });
  const lifecycle = registry.start(request({ requestId: "request" }), f.hooks); await lifecycle.done;
  expect(await lifecycle.admission).toEqual({ state: "admitted" }); expect(f.state.failClosed).toBe(1);
  expect(f.calls.filter(call => call === "native-intent")).toHaveLength(1); expect(f.calls.filter(call => call === "submit")).toHaveLength(1);
  expect(f.calls).toContain("outcome:accepted"); expect((await lifecycle.successfulSettlement()).ready).toBe(false);
  expect(lifecycle.submissionEvidence()).toMatchObject({ requestId: "request", runId: "run", nativeCommandId: "exact-command", source, submission: "submitted", nativeAcceptance: "accepted" });
});

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

function releaseFixture(status: "completed" | "failed" | "interrupted" = "completed") {
  const f = fixture(), registry = new HarnessDispatchRegistry(); f.hooks.wake = undefined;
  const current = { source: { ...source }, installation: "installed-config", ownerPresent: false, admissionPending: false, reconciliationPending: false, capacityAvailable: true };
  f.hooks.releasedGuards = () => ({ ...current, ownerPresent: current.ownerPresent || !!f.installed() });
  registry.register({ ...f.adapter, execute: async (owner, prompt, resume, ready) => {
    owner.dispatchEvidence!.beforeNative();
    await f.adapter.execute(owner, prompt, resume, ready);
    owner.dispatchEvidence!.outcome("submitted"); owner.run.status = status;
  } });
  const start = () => registry.start(request(), f.hooks);
  return { ...f, registry, current, start };
}

for (const status of ["completed", "failed", "interrupted"] as const) test(`healthy ${status} release is distinct from successful settlement and never observes native success/idle`, async () => {
  const f = releaseFixture(status), lifecycle = f.start();
  expect((await lifecycle.releasedSettlement()).ready).toBe(false);
  await lifecycle.admission; f.execution.resolve(); await lifecycle.done;
  if (status === "interrupted") lifecycle.owner.stopRequested = true;
  expect(await lifecycle.releasedSettlement()).toEqual({ ready: true });
  expect(f.calls).not.toContain("proof"); expect(f.calls).not.toContain("wake");
  if (status !== "completed") expect((await lifecycle.successfulSettlement()).ready).toBe(false);
  else { f.proof.resolve(); expect(await lifecycle.successfulSettlement()).toEqual({ ready: true }); }
});

test("certified boundary refusal can prove healthy release but never successful completion", async () => {
  const f = releaseFixture(), registry = new HarnessDispatchRegistry(), refusal = new DispatchPreNativeRefusal(new Error("paused"));
  f.hooks.evidence = { beforeNative: () => { throw refusal; } };
  registry.register({ ...f.adapter, execute: async owner => { owner.run.status = "failed"; owner.dispatchEvidence!.beforeNative(); } });
  const lifecycle = registry.start(request(), f.hooks); await lifecycle.done;
  expect(await lifecycle.admission).toEqual({ state: "unconfirmed" });
  expect(await lifecycle.releasedSettlement()).toEqual({ ready: true });
  expect(await lifecycle.successfulSettlement()).toMatchObject({ ready: false, code: "dispatch-native-withheld" });
  expect(f.state.failClosed).toBe(0); expect(f.calls).not.toContain("proof"); expect(f.calls).not.toContain("wake");
});

for (const accessor of ["successfulSettlement", "releasedSettlement"] as const)
  test(`queued pre-intent ${accessor} peek leaves original durable guard in control`, async () => {
    const f = releaseFixture(), registry = new HarnessDispatchRegistry(), install = f.hooks.install;
    const refusal = new DispatchPreNativeRefusal(new Error("durably paused launch drift"));
    let paused = false, observations = 0, proofReads = 0;
    f.hooks.wake = () => { f.calls.push("wake"); };
    f.hooks.install = done => {
      const owner = install(done);
      owner.beforeSend = () => {
        f.calls.push("original-queue-guard");
        if (owner.run.model !== undefined) { paused = true; throw refusal; }
      };
      return owner;
    };
    f.hooks.evidence = {
      beforeNative: () => { f.installed()!.beforeSend!(); },
      outcome: value => {
        expect(paused).toBe(true); expect(Object.isFrozen(value.source)).toBe(true);
        expect(value).toMatchObject({ submission: "not-submitted", nativeAcceptance: "not-accepted" });
        observations++;
      },
    };
    registry.register({ ...f.adapter, execute: async (owner, _prompt, _resume, ready) => {
      f.calls.push("execute"); owner.run.status = "failed";
      owner.dispatchEvidence!.beforeNative(); f.calls.push("native-effect"); ready(true);
    } });
    const lifecycle = registry.start(request({ origin: "queued-user", requestId: "queued-request" }), f.hooks);
    lifecycle.owner.run.model = "changed";
    const peek = accessor === "releasedSettlement"
      ? lifecycle.releasedSettlement(async () => { proofReads++; return { ready: true }; })
      : lifecycle.successfulSettlement();
    // No await: observe the read before the deferred execution microtask.
    expect(f.state.failClosed).toBe(0); expect(paused).toBe(false); expect(observations).toBe(0);
    expect(f.calls).toEqual(["install"]); expect(proofReads).toBe(0);
    expect(await peek).toMatchObject({ ready: false, code: "dispatch-unsettled" });
    await lifecycle.done;
    expect(f.calls.filter(call => call === "original-queue-guard")).toHaveLength(1);
    expect(f.calls.filter(call => call === "execute")).toHaveLength(1);
    expect(paused).toBe(true); expect(observations).toBe(1);
    expect(lifecycle.submissionEvidence()).toMatchObject({ source, requestId: "queued-request", submission: "not-submitted", nativeAcceptance: "not-accepted" });
    expect(await lifecycle.admission).toEqual({ state: "unconfirmed" });
    expect(await lifecycle.releasedSettlement()).toEqual({ ready: true });
    expect(await lifecycle.successfulSettlement()).toMatchObject({ ready: false, code: "dispatch-native-withheld" });
    expect(f.state.failClosed).toBe(0); expect(f.state.storageFailed).toBe(false); expect(f.installed()).toBeUndefined();
    for (const call of ["native-effect", "proof", "wake", "terminate"]) expect(f.calls).not.toContain(call);
    // Restoration cannot replace the actual durably observed withheld snapshot.
    lifecycle.owner.run.model = undefined;
    expect(await lifecycle.releasedSettlement()).toMatchObject({ ready: false, code: "reconciliation-required" });
    lifecycle.owner.run.model = "changed";
    expect((await lifecycle.releasedSettlement()).ready).toBe(false); expect(observations).toBe(1);
  });

for (const phase of ["published", "final-boundary"] as const) test(`queued launch drift at ${phase} requires durable withholding, releases locally and never proves success`, async () => {
  const f = releaseFixture(), registry = new HarnessDispatchRegistry(), install = f.hooks.install;
  const refusal = new DispatchPreNativeRefusal(new Error("durably paused launch drift"));
  let paused = false, observations = 0;
  f.hooks.install = done => { const owner = install(done); owner.beforeSend = () => {
    if (owner.run.model !== undefined) { paused = true; throw new Error("original queued configuration guard"); }
  }; return owner; };
  f.hooks.evidence = {
    beforeNative: () => { paused = true; throw refusal; },
    outcome: value => { expect(paused).toBe(true); expect(value.submission).toBe("not-submitted"); observations++; },
  };
  registry.register({ ...f.adapter, execute: async owner => {
    f.calls.push("execute"); owner.run.status = "failed";
    if (phase === "published") {
      expect(() => owner.beforeSend!()).toThrow("original queued configuration guard"); owner.dispatchEvidence!.withheld();
    } else {
      owner.beforeSend!(); owner.run.model = "changed";
      expect(() => owner.dispatchEvidence!.beforeNative()).toThrow(refusal);
    }
  } });
  const lifecycle = registry.start(request({ origin: "queued-user", requestId: "queued-request" }), f.hooks);
  if (phase === "published") lifecycle.owner.run.model = "changed";
  await lifecycle.done;
  expect(observations).toBe(1); expect(f.state.failClosed).toBe(0); expect(f.calls).toContain("execute");
  expect(lifecycle.submissionEvidence()).toMatchObject({ runId: "run", requestId: "queued-request", submission: "not-submitted", nativeAcceptance: "not-accepted" });
  expect(await lifecycle.releasedSettlement()).toEqual({ ready: true });
  expect(await lifecycle.successfulSettlement()).toMatchObject({ ready: false, code: "dispatch-native-withheld" });
  lifecycle.owner.run.status = "completed";
  expect((await lifecycle.releasedSettlement()).ready).toBe(false);
  expect((await lifecycle.successfulSettlement()).ready).toBe(false);
  expect(() => lifecycle.owner.dispatchEvidence!.beforeNative()).toThrow("replay forbidden");
  expect(f.calls).not.toContain("proof"); expect(f.calls).not.toContain("wake"); expect(f.calls).not.toContain("terminate");
  lifecycle.owner.run.model = "later-tamper";
  expect(await lifecycle.releasedSettlement()).toMatchObject({ ready: false, code: "reconciliation-required" });
});

for (const mode of ["successful-hook", "unknown", "accepted"] as const) test(`queued ${mode} launch tampering cannot borrow initial non-submission and original outcomes remain recordable`, async () => {
  const f = releaseFixture(), registry = new HarnessDispatchRegistry(), install = f.hooks.install;
  const outcomes: string[] = [];
  f.hooks.install = done => { const owner = install(done); owner.beforeSend = () => {}; return owner; };
  f.hooks.evidence = {
    beforeNative: () => { if (mode === "successful-hook") lifecycle.owner.run.model = "changed"; },
    outcome: value => { outcomes.push(value.nativeAcceptance); },
  };
  registry.register({ ...f.adapter, execute: async owner => {
    if (mode === "successful-hook") {
      expect(() => owner.dispatchEvidence!.beforeNative()).toThrow("Installed dispatch run identity changed");
    } else {
      owner.dispatchEvidence!.beforeNative(); owner.run.model = "changed";
      owner.dispatchEvidence!.outcome(mode === "accepted" ? "submitted" : "unknown", mode === "accepted" ? "accepted" : "unknown");
    }
    owner.run.status = "completed";
  } });
  const lifecycle = registry.start(request({ origin: "queued-user", requestId: "queued-request" }), f.hooks);
  await lifecycle.done;
  expect(outcomes).toContain(mode === "accepted" ? "accepted" : "unknown");
  expect(lifecycle.submissionEvidence()).toMatchObject({ runId: "run", submission: mode === "accepted" ? "submitted" : "unknown", nativeAcceptance: mode === "accepted" ? "accepted" : "unknown" });
  expect(f.state.failClosed).toBeGreaterThan(0); expect((await lifecycle.releasedSettlement()).ready).toBe(false);
  expect((await lifecycle.successfulSettlement()).ready).toBe(false); expect(f.calls).not.toContain("proof"); expect(f.calls).not.toContain("wake");
});

test("explicit stop in preparation can prove released non-submission without false success", async () => {
  const f = releaseFixture(), registry = new HarnessDispatchRegistry();
  registry.register({ ...f.adapter, execute: async (owner, _prompt, _resume, ready) => {
    owner.stopRequested = true; owner.run.status = "interrupted"; owner.dispatchEvidence!.withheld(); ready(false);
  } });
  const lifecycle = registry.start(request(), f.hooks); await lifecycle.done;
  expect(await lifecycle.releasedSettlement()).toEqual({ ready: true });
  expect((await lifecycle.successfulSettlement()).ready).toBe(false);
  expect(lifecycle.submissionEvidence()).toMatchObject({ submission: "not-submitted", nativeAcceptance: "not-accepted" });
});

for (const flag of ["ownerPresent", "admissionPending", "reconciliationPending", "capacityAvailable", "closing", "storageFailed", "reconciliationRequired", "cancelling", "unsettled"] as const)
  test(`release proof requires current ${flag} guard`, async () => {
    const f = releaseFixture("failed"), lifecycle = f.start(); await lifecycle.admission; f.execution.resolve(); await lifecycle.done;
    if (flag === "capacityAvailable") f.current.capacityAvailable = false;
    else if (flag === "ownerPresent" || flag === "admissionPending" || flag === "reconciliationPending") f.current[flag] = true;
    else if (flag === "cancelling") lifecycle.owner.cancelling = true;
    else if (flag === "unsettled") lifecycle.owner.settled = false;
    else f.state[flag] = true;
    expect((await lifecycle.releasedSettlement()).ready).toBe(false); expect(f.calls).not.toContain("proof"); expect(f.calls).not.toContain("wake");
  });

test("release proof checks actual retained ownership, not a forged released DTO", async () => {
  const f = releaseFixture("failed"); f.hooks.release = () => {};
  f.hooks.releasedGuards = () => ({ ...f.current, ownerPresent: false });
  const lifecycle = f.start(); await lifecycle.admission; f.execution.resolve(); await lifecycle.done;
  expect(f.installed()).toBe(lifecycle.owner);
  expect((await lifecycle.releasedSettlement()).ready).toBe(false);
});

test("release capability refuses unknown legacy submission and missing current guards", async () => {
  for (const missing of [false, true]) {
    const f = releaseFixture(); if (missing) f.hooks.releasedGuards = undefined;
    // The original legacy adapter deliberately never certifies its boundary.
    const registry = new HarnessDispatchRegistry(); registry.register(f.adapter);
    const lifecycle = registry.start(request(), f.hooks); await lifecycle.admission; f.execution.resolve(); await lifecycle.done;
    expect(lifecycle.submissionEvidence().submission).toBe("unknown");
    expect((await lifecycle.releasedSettlement()).ready).toBe(false);
  }
});

for (const order of ["before-release", "after-release"] as const) test(`release proof waits for ${order} reconciliation and retains fatal latches`, async () => {
  for (const fails of [false, true]) {
    const f = releaseFixture("failed"), entered = pending<void>();
    f.hooks.reconciliation = { order, begin: () => ({ end: () => {} }), run: async () => { entered.resolve(); await f.reconciliation.promise; if (fails) throw new Error("reconcile failed"); } };
    const lifecycle = f.start(); await lifecycle.admission; f.execution.resolve(); await entered.promise;
    expect((await lifecycle.releasedSettlement()).ready).toBe(false);
    f.reconciliation.resolve(); await lifecycle.done;
    expect((await lifecycle.releasedSettlement()).ready).toBe(!fails);
    if (fails) { f.state.storageFailed = f.state.reconciliationRequired = false; expect((await lifecycle.releasedSettlement()).ready).toBe(false); }
  }
});

for (const timing of ["before", "during"] as const) for (const field of ["nativeSessionId", "authorityId", "cwd", "installation", "ownerPresent", "admissionPending", "reconciliationPending", "capacityAvailable"] as const)
  test(`release checks CURRENT ${field} ${timing} optional awaited read-only proof`, async () => {
    const f = releaseFixture("failed"), lifecycle = f.start(), entered = pending<void>();
    await lifecycle.admission; f.execution.resolve(); await lifecycle.done;
    const change = () => {
      if (field === "nativeSessionId" || field === "authorityId" || field === "cwd") f.current.source[field] = "replacement";
      else if (field === "installation") f.current.installation = "replacement";
      else f.current[field] = field !== "capacityAvailable";
    };
    let reads = 0;
    if (timing === "before") change();
    const evaluation = lifecycle.releasedSettlement(async () => { reads++; entered.resolve(); await f.proof.promise; return { ready: true }; });
    if (timing === "during") { await entered.promise; change(); }
    f.proof.resolve(); expect((await evaluation).ready).toBe(false);
    expect(reads).toBe(timing === "before" ? 0 : 1); expect(f.state.failClosed).toBe(0);
  });

test("replacement run object/installation gate cannot forge a release or reopen a fatal identity latch", async () => {
  for (const replacement of ["run", "done", "beforeSend"] as const) {
    const f = releaseFixture(), lifecycle = f.start(); await lifecycle.admission; f.execution.resolve(); await lifecycle.done;
    const run = lifecycle.owner.run, done = lifecycle.owner.done, beforeSend = lifecycle.owner.beforeSend;
    if (replacement === "run") lifecycle.owner.run = { ...run };
    if (replacement === "done") lifecycle.owner.done = Promise.resolve();
    if (replacement === "beforeSend") lifecycle.owner.beforeSend = () => {};
    expect(await lifecycle.releasedSettlement()).toMatchObject({ ready: false, code: "reconciliation-required" });
    lifecycle.owner.run = run; lifecycle.owner.done = done; lifecycle.owner.beforeSend = beforeSend;
    expect((await lifecycle.releasedSettlement()).ready).toBe(false); expect(f.state.failClosed).toBe(1);
  }
});

test("optional unavailable release observation stays retryable but cannot hide concurrent identity drift", async () => {
  const f = releaseFixture("failed"), lifecycle = f.start(); await lifecycle.admission; f.execution.resolve(); await lifecycle.done;
  expect(await lifecycle.releasedSettlement(async () => { throw new DispatchProofUnavailableError("offline"); })).toMatchObject({ ready: false, code: "dispatch-proof-unavailable" });
  expect(await lifecycle.releasedSettlement()).toEqual({ ready: true }); expect(f.state.failClosed).toBe(0);
  expect(await lifecycle.releasedSettlement(async () => { lifecycle.owner.run.runId = "replacement"; throw new DispatchProofUnavailableError("offline"); })).toMatchObject({ ready: false, code: "reconciliation-required" });
  lifecycle.owner.run.runId = "run"; expect((await lifecycle.releasedSettlement()).ready).toBe(false);
});

for (const field of ["model", "effort", "agent", "profileId", "createdAt"] as const) test(`installed run ${field} is immutable even when current session release guards claim unchanged configuration`, async () => {
  const f = releaseFixture("failed"), lifecycle = f.start(); await lifecycle.admission; f.execution.resolve(); await lifecycle.done;
  const original = lifecycle.owner.run[field];
  Object.assign(lifecycle.owner.run, { [field]: "replacement" });
  expect(await lifecycle.releasedSettlement()).toMatchObject({ ready: false, code: "reconciliation-required" });
  Object.assign(lifecycle.owner.run, { [field]: original });
  expect((await lifecycle.releasedSettlement()).ready).toBe(false);
});

test("fatal optional release proof stays latched even when concurrent source drift is restored", async () => {
  const f = releaseFixture("failed"), lifecycle = f.start(); await lifecycle.admission; f.execution.resolve(); await lifecycle.done;
  expect(await lifecycle.releasedSettlement(async () => { f.current.installation = "replacement"; throw new Error("invariant"); })).toMatchObject({ ready: false, code: "reconciliation-required" });
  f.current.installation = "installed-config"; f.state.storageFailed = f.state.reconciliationRequired = false;
  expect((await lifecycle.releasedSettlement()).ready).toBe(false); expect(f.state.failClosed).toBe(1);
});

test("released predecessor cannot claim current conversation release while a different owner is installed", async () => {
  const f = releaseFixture("failed"), previous = f.start(); await previous.admission; f.execution.resolve(); await previous.done;
  expect(await previous.releasedSettlement()).toEqual({ ready: true });
  const next = f.start(); await next.admission;
  expect(f.installed()).toBe(next.owner);
  expect((await previous.releasedSettlement()).ready).toBe(false);
  await next.done; expect(await previous.releasedSettlement()).toEqual({ ready: true });
});

for (const phase of ["first", "final"] as const) for (const code of ["dispatch-proof-unavailable", "dispatch-source-mismatch"] as const)
  test(`typed ${code} from ${phase} release guard denies only that observation and fresh retry succeeds`, async () => {
    const f = releaseFixture("failed"), original = f.hooks.releasedGuards!;
    let checks = 0, failAt = 0, reads = 0;
    f.hooks.releasedGuards = owner => {
      if (++checks === failAt) throw code === "dispatch-proof-unavailable"
        ? new DispatchProofUnavailableError("offline") : new HarnessDispatchError(code, "source changed");
      return original(owner);
    };
    const lifecycle = f.start(); await lifecycle.admission; f.execution.resolve(); await lifecycle.done;
    checks = 0; failAt = phase === "first" ? 1 : 2;
    expect(await lifecycle.releasedSettlement(async () => { reads++; return { ready: true }; })).toMatchObject({ ready: false, code });
    expect(checks).toBe(failAt); expect(reads).toBe(phase === "first" ? 0 : 1);
    expect(f.state.failClosed).toBe(0); expect(f.state.storageFailed).toBe(false); expect(f.state.reconciliationRequired).toBe(false);
    failAt = 0; checks = 0;
    expect(await lifecycle.releasedSettlement()).toEqual({ ready: true }); expect(checks).toBe(2);
    expect(f.state.failClosed).toBe(0); expect(f.calls).not.toContain("wake");
  });

for (const refresh of ["unavailable", "source-mismatch", "unknown"] as const)
  test(`unavailable optional release proof refresh independently classifies ${refresh} guard failure`, async () => {
    const f = releaseFixture("failed"), original = f.hooks.releasedGuards!; let checks = 0, failAt = 0;
    f.hooks.releasedGuards = owner => {
      if (++checks === failAt) {
        if (refresh === "unavailable") throw new DispatchProofUnavailableError("guard offline");
        if (refresh === "source-mismatch") throw new HarnessDispatchError("dispatch-source-mismatch", "fresh source changed");
        throw new Error("guard invariant");
      }
      return original(owner);
    };
    const lifecycle = f.start(); await lifecycle.admission; f.execution.resolve(); await lifecycle.done;
    checks = 0; failAt = 2;
    expect(await lifecycle.releasedSettlement(async () => { throw new DispatchProofUnavailableError("proof offline"); })).toMatchObject({
      ready: false, code: refresh === "unavailable" ? "dispatch-proof-unavailable" : refresh === "source-mismatch" ? "dispatch-source-mismatch" : "reconciliation-required",
      ...(refresh === "unavailable" ? { reason: "guard offline" } : {}),
    });
    expect(checks).toBe(2); expect(f.state.failClosed).toBe(refresh === "unknown" ? 1 : 0);
    failAt = 0; f.state.storageFailed = f.state.reconciliationRequired = false;
    expect((await lifecycle.releasedSettlement()).ready).toBe(refresh !== "unknown");
    expect(f.state.failClosed).toBe(refresh === "unknown" ? 1 : 0);
  });

for (const field of ["nativeSessionId", "installation", "ownerPresent", "admissionPending", "reconciliationPending", "capacityAvailable"] as const)
  test(`unavailable optional release proof rechecks fresh ${field} without cached readiness`, async () => {
    const f = releaseFixture("failed"), lifecycle = f.start(), entered = pending<void>();
    await lifecycle.admission; f.execution.resolve(); await lifecycle.done;
    const evaluation = lifecycle.releasedSettlement(async () => { entered.resolve(); await f.proof.promise; throw new DispatchProofUnavailableError("offline"); });
    await entered.promise;
    if (field === "nativeSessionId") f.current.source.nativeSessionId = "replacement";
    else if (field === "installation") f.current.installation = "replacement";
    else f.current[field] = field !== "capacityAvailable";
    f.proof.resolve();
    expect(await evaluation).toMatchObject({ ready: false, code: field === "nativeSessionId" || field === "installation" ? "dispatch-source-mismatch" : field === "ownerPresent" ? "dispatch-unsettled" : "dispatch-unavailable" });
    expect(f.state.failClosed).toBe(0); expect(f.state.storageFailed).toBe(false);
  });

for (const [name, change] of [...identityChanges, ["configuration", { model: "replacement" }]] as readonly [string, Partial<RunOwner["run"]>][])
  test(`unavailable release proof cannot hide concurrent installed ${name} mutation`, async () => {
    const f = releaseFixture(), lifecycle = f.start(), entered = pending<void>();
    await lifecycle.admission; f.execution.resolve(); await lifecycle.done;
    const installed = { ...lifecycle.owner.run };
    const evaluation = lifecycle.releasedSettlement(async () => { entered.resolve(); await f.proof.promise; throw new DispatchProofUnavailableError("offline"); });
    await entered.promise; Object.assign(lifecycle.owner.run, change); f.proof.resolve();
    expect(await evaluation).toMatchObject({ ready: false, code: "reconciliation-required" }); expect(f.state.failClosed).toBe(1);
    Object.assign(lifecycle.owner.run, installed); f.state.storageFailed = f.state.reconciliationRequired = false;
    expect((await lifecycle.releasedSettlement()).ready).toBe(false); expect(f.state.failClosed).toBe(1);
  });

for (const code of ["dispatch-proof-unavailable", "dispatch-source-mismatch"] as const)
  test(`release guard ${code} cannot mask its own installed identity mutation`, async () => {
    const f = releaseFixture(), original = f.hooks.releasedGuards!; let mutate = false;
    f.hooks.releasedGuards = owner => {
      if (mutate) {
        owner.run.runId = "replacement";
        throw code === "dispatch-proof-unavailable" ? new DispatchProofUnavailableError("offline") : new HarnessDispatchError(code, "source changed");
      }
      return original(owner);
    };
    const lifecycle = f.start(); await lifecycle.admission; f.execution.resolve(); await lifecycle.done; mutate = true;
    expect(await lifecycle.releasedSettlement()).toMatchObject({ ready: false, code: "reconciliation-required" });
    expect(f.state.failClosed).toBe(1); mutate = false; lifecycle.owner.run.runId = "run";
    expect((await lifecycle.releasedSettlement()).ready).toBe(false); expect(f.state.failClosed).toBe(1);
  });

for (const mode of ["code-shaped", "message-shaped", "other-typed", "unknown-proof"] as const)
  test(`release denial classification remains nominal for ${mode}`, async () => {
    const f = releaseFixture(), original = f.hooks.releasedGuards!; let fail = false;
    f.hooks.releasedGuards = owner => {
      if (fail) {
        if (mode === "code-shaped") throw Object.assign(new Error("offline"), { code: "dispatch-source-mismatch" });
        if (mode === "message-shaped") throw new Error("DispatchProofUnavailableError: offline");
        if (mode === "other-typed") throw new HarnessDispatchError("invalid-dispatch-installation", "invalid");
        throw new DispatchProofUnavailableError("guard offline");
      }
      return original(owner);
    };
    const lifecycle = f.start(); await lifecycle.admission; f.execution.resolve(); await lifecycle.done;
    const evaluation = mode === "unknown-proof"
      ? lifecycle.releasedSettlement(async () => { fail = true; throw new Error("proof invariant"); })
      : (fail = true, lifecycle.releasedSettlement());
    expect(await evaluation).toMatchObject({ ready: false, code: "reconciliation-required" }); expect(f.state.failClosed).toBe(1);
    fail = false; f.state.storageFailed = f.state.reconciliationRequired = false;
    expect((await lifecycle.releasedSettlement()).ready).toBe(false); expect(f.state.failClosed).toBe(1);
  });

for (const phase of ["installation", "first", "final", "error-refresh"] as const) for (const kind of ["promise", "thenable"] as const)
  test(`${kind} returned by ${phase} release guard is fatal and consumes late rejection`, async () => {
    const f = releaseFixture(), original = f.hooks.releasedGuards!, late = pending<never>();
    let checks = 0, failAt = phase === "installation" ? 1 : 0, assimilated = false;
    f.hooks.releasedGuards = owner => {
      if (++checks !== failAt) return original(owner);
      const result = kind === "promise" ? late.promise : { ...original(owner), then: (resolve: (value: never) => void, reject: (error: unknown) => void) => {
        assimilated = true; return late.promise.then(resolve, reject);
      } };
      return result as unknown as ReturnType<typeof original>;
    };
    if (phase === "installation") expect(() => f.start()).toThrow("must complete synchronously");
    else {
      const lifecycle = f.start(); await lifecycle.admission; f.execution.resolve(); await lifecycle.done;
      checks = 0; failAt = phase === "first" ? 1 : 2;
      expect(await lifecycle.releasedSettlement(async () => {
        if (phase === "error-refresh") throw new DispatchProofUnavailableError("proof offline");
        return { ready: true };
      })).toMatchObject({ ready: false, code: "reconciliation-required" });
      expect(checks).toBe(failAt); failAt = 0; f.state.storageFailed = f.state.reconciliationRequired = false;
      expect((await lifecycle.releasedSettlement()).ready).toBe(false);
    }
    expect(f.state.failClosed).toBe(1); expect(f.calls).not.toContain("wake");
    await Promise.resolve(); if (kind === "thenable") expect(assimilated).toBe(true);
    late.reject(new Error("late guard rejection")); await Promise.resolve(); await Promise.resolve();
  });

for (const mode of ["stopped", "certified-refusal", "unknown-submission", "fatal"] as const)
  test(`released proof does not authorize successful settlement or wake for ${mode}`, async () => {
    const f = releaseFixture(), registry = new HarnessDispatchRegistry(); let reads = 0;
    f.hooks.wake = () => { f.calls.push("wake"); };
    if (mode === "certified-refusal") f.hooks.evidence = { beforeNative: () => { throw new DispatchPreNativeRefusal(new Error("paused")); } };
    registry.register({ ...f.adapter, execute: async (owner, _prompt, _resume, ready) => {
      owner.run.status = "failed";
      if (mode === "fatal") throw new Error("execution invariant");
      if (mode === "certified-refusal") { owner.dispatchEvidence!.beforeNative(); return; }
      if (mode === "stopped") {
        owner.run.status = "interrupted"; owner.stopRequested = true; owner.dispatchEvidence!.withheld(); ready(false); return;
      }
      ready(true); // Without boundary evidence admission alone cannot prove release.
    } });
    f.proof.resolve(); const lifecycle = registry.start(request(), f.hooks); await lifecycle.done;
    expect((await lifecycle.releasedSettlement(async () => { reads++; return { ready: true }; })).ready).toBe(mode === "stopped" || mode === "certified-refusal");
    expect(reads).toBe(mode === "stopped" || mode === "certified-refusal" ? 1 : 0);
    expect((await lifecycle.successfulSettlement()).ready).toBe(false);
    expect(f.calls).not.toContain("proof"); expect(f.calls).not.toContain("wake");
    expect(f.state.failClosed).toBe(mode === "fatal" ? 1 : 0);
  });
