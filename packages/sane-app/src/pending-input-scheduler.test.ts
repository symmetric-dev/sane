import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConversationCoordinator } from "./conversation-coordinator";
import { startDispatchLifecycle, DispatchProofUnavailableError, type DispatchLifecycle, type HarnessDispatchAdapter } from "./harness-dispatch";
import { dispatchSource } from "./pending-input-codec";
import { PendingInputDomainError, type PendingInputAuthorization, type PendingInputEnqueue, type PendingInputLiveValidation } from "./pending-input-contract";
import { PendingInputStore } from "./pending-input-store";
import { PendingInputScheduler, type PendingInputLiveProof, type PendingInputSchedulerDependencies, type PendingInputSelection } from "./pending-input-scheduler";
import { id, pendingFixture, sibling, at } from "./pending-input-fixtures";
import type { RunOwner } from "./run-owner";
import type { PreparedAdmissionContext } from "./prepared-input-admission";
import { atomicAppRecord } from "./app-store";

const TEMP = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
const dirs: string[] = [], schedulers: PendingInputScheduler[] = [];
afterEach(async () => {
  for (const scheduler of schedulers.splice(0)) await scheduler.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const deferred = <T = void>() => Promise.withResolvers<T>();
type Launch = {
  lifecycle: DispatchLifecycle; context: PreparedAdmissionContext; prompt: string;
  complete: ReturnType<typeof deferred>; discovery: ReturnType<typeof deferred> | null;
  reconcile: ReturnType<typeof deferred> | null; status: "completed" | "failed" | "interrupted";
  completeSeen?: boolean;
};
async function fixture(harness: "claude-code" | "opencode" = "claude-code", capacity = 2, limit = 32) {
  const input = await pendingFixture(harness), cid = input.request.conversationId;
  const dir = realpathSync(mkdtempSync(join(TEMP, "pending-scheduler-"))); dirs.push(dir);
  const predecessors = new Map<string, DispatchLifecycle>(), launches: Launch[] = [];
  const stages: PendingInputLiveValidation[] = [], purposes: string[] = [], errors: unknown[] = [], lifecycleErrors: unknown[] = [];
  const state = {
    preflightGate: null as ReturnType<typeof deferred> | null, entered: deferred(), preflights: 0,
    unavailable: false, drift: null as "source-changed" | "configuration-changed" | "context-changed" | null,
    rejectStage: null as PendingInputLiveValidation["stage"] | null, rejectObservation: false,
    discovery: null as ReturnType<typeof deferred> | null, reconciliation: null as ReturnType<typeof deferred> | null,
    admissionGate: null as ReturnType<typeof deferred> | null, admissionEntered: deferred(),
    mode: "submitted" as "submitted" | "unknown" | "withheld" | "missing-evidence",
    rejectReady: false, proveInstallRejection: false, boundaries: 0, settlementUnavailable: false,
    holdRelease: false, userResume: false, writeFail: false, asynchronousValidation: false,
  };
  let scheduler!: PendingInputScheduler;
  const coordinator = new ConversationCoordinator<RunOwner>({ maxConcurrentRuns: capacity });
  const store = new PendingInputStore(dir, id(), {
    validateLive: value => { stages.push(value); if (!["enqueue", "resume"].includes(value.stage)) scheduler.validateLive(value); },
    write: (root, name, value) => { if (state.writeFail) throw new Error("disk fsync failed"); atomicAppRecord(root, name, value); },
  });
  const live = (selection: PendingInputSelection, kind: PendingInputAuthorization["kind"], runId?: string): PendingInputLiveProof => ({
    authorization: { kind, authorizationId: id(), chainId: selection.item.chainId, source: dispatchSource(selection.item.snapshot), predecessorRunId: kind === "settlement" ? runId! : selection.predecessor?.owner.run.runId ?? null },
    validate: (value, purpose) => {
      purposes.push(`${value.stage}:${purpose}`);
      if (state.asynchronousValidation) return Promise.resolve() as unknown as void;
      if (state.rejectStage === value.stage || purpose === "observation" && state.rejectObservation) throw new PendingInputDomainError("domain-refusal", `refuse ${value.stage}`);
      if (purpose === "submission" && state.drift) throw new PendingInputDomainError(state.drift, "live pins changed");
    },
  });
  const adapter: HarnessDispatchAdapter = {
    id: harness, automation: { "queued-user": { supported: true }, "worker-report": { supported: true }, handoff: { supported: true } },
    readiness: async source => ({ source, readiness: { ready: true } }),
    execute: async (owner, _prompt, _resume, ready) => {
      const launch = launches.find(l => l.lifecycle.owner === owner)!;
      if (launch.discovery) await launch.discovery.promise;
      const { source, runId, nativeCommandId, requestId } = launch.lifecycle.submissionEvidence();
      launch.context.validate!({ source, runId, nativeCommandId, requestId });
      if (state.mode === "withheld") owner.dispatchEvidence!.withheld();
      else if (state.mode !== "missing-evidence") {
        owner.dispatchEvidence!.beforeNative(); state.boundaries++;
        if (state.mode === "submitted") owner.dispatchEvidence!.outcome("submitted", harness === "opencode" ? "accepted" : "unknown");
      }
      ready(state.mode === "submitted");
      await launch.complete.promise; owner.run.status = launch.status;
    },
    successfulSettlement: async () => {
      if (state.settlementUnavailable) throw new DispatchProofUnavailableError("source offline");
      return { ready: true };
    },
  };
  const deps: PendingInputSchedulerDependencies = {
    store, coordinator, maxConversationsPerPass: limit,
    predecessor: conversationId => predecessors.get(conversationId) ?? null,
    preflight: async selection => {
      state.preflights++; state.entered.resolve();
      if (state.preflightGate) await state.preflightGate.promise;
      if (state.unavailable) throw new DispatchProofUnavailableError("readiness transport offline");
      if (state.drift) return { kind: "pause", pause: { code: state.drift, reason: "preflight pins changed" } };
      return { kind: "ready", proof: { ...live(selection, "dispatch"), basis: state.userResume ? "user-resume" : selection.predecessor ? "successful-predecessor" : "new-idle-chain" } };
    },
    settlement: async (selection, lifecycle) => {
      if (state.settlementUnavailable) return { kind: "wait" };
      const status = lifecycle.owner.run.status;
      if (!lifecycle.owner.settled || coordinator.owns(lifecycle.owner) || coordinator.hasReconciliation(lifecycle.owner.run.sessionId)
        || !["completed", "failed", "interrupted"].includes(status)) return { kind: "wait" };
      // This fake's exact command/process proof is the adapter's controlled
      // completion gate, not status alone. It is deliberately read-only.
      const launch = launches.find(l => l.lifecycle === lifecycle);
      if (!launch || !launch.completeSeen || lifecycle.submissionEvidence().submission !== "submitted") return { kind: "wait" };
      return { kind: "ready", status: status as "completed" | "failed" | "interrupted", proof: live(selection, "settlement", lifecycle.owner.run.runId) };
    },
    allocate: harnessId => ({ attemptId: id(), runId: id(), nativeCommandId: harnessId === "opencode" ? `msg_${id().replaceAll("-", "")}` : null }),
    failClosed: error => { errors.push(error); },
    dispatch: async (prepared, lease, options) => {
      const context = options.context, identity = { source: dispatchSource({ ...input.snapshot, prepared }), runId: context.runId, nativeCommandId: context.nativeCommandId ?? null, requestId: context.intent.requestId! };
      state.admissionEntered.resolve();
      if (state.admissionGate) await state.admissionGate.promise;
      let lifecycle: DispatchLifecycle;
      try {
        context.validate!(identity);
        lifecycle = startDispatchLifecycle(adapter, { source: identity.source, origin: "queued-user", prompt: prepared.prompt, resume: true, requestId: identity.requestId }, {
          install: done => {
            context.validate!(identity); context.link!(identity);
            const owner: RunOwner = { run: { sessionId: prepared.binding.conversationId, runId: context.runId, cwd: prepared.binding.cwd, status: "running", createdAt: at, ...(context.nativeCommandId ? { nativeCommandId: context.nativeCommandId } : {}) }, done, settled: false };
            const installed = coordinator.installOwner(lease, owner); if (!installed.ready) throw new PendingInputDomainError(installed.code, installed.reason);
            return owner;
          },
          evidence: context.evidence, owns: owner => coordinator.owns(owner), settle: owner => { owner.settled = true; },
          release: owner => { if (!state.holdRelease) coordinator.releaseOwner(owner); }, failClosed: error => { lifecycleErrors.push(error); }, terminate: async () => {},
          guards: owner => ({ settled: owner.settled, released: !coordinator.owns(owner), status: owner.run.status, cancelling: !!owner.cancelling, stopRequested: !!owner.stopRequested, stopping: !!owner.stopping, closing: false, storageFailed: false, reconciliationRequired: false }),
          reconciliation: state.reconciliation ? {
            order: "after-release", begin: owner => { const token = coordinator.beginReconciliation(owner); return { end: () => { coordinator.endReconciliation(token); } }; },
            run: async () => { await state.reconciliation!.promise; },
          } : undefined,
        });
      } catch (error) {
        if (state.proveInstallRejection) context.evidence!.outcome!({ ...identity, submission: "not-submitted", nativeAcceptance: "not-accepted" });
        throw error;
      }
      const launch: Launch & { completeSeen?: boolean } = { lifecycle, context, prompt: prepared.prompt, complete: deferred(), discovery: state.discovery, reconcile: state.reconciliation, status: "completed" };
      void launch.complete.promise.then(() => { launch.completeSeen = true; });
      launches.push(launch); predecessors.set(prepared.binding.conversationId, lifecycle);
      options.publish(lifecycle);
      const admission = await lifecycle.admission;
      if (state.rejectReady && admission.state !== "admitted") throw new PendingInputDomainError("ready-lost", "native ready was lost");
      return { sessionId: prepared.binding.conversationId, runId: context.runId, harness, lifecycle };
    },
  };
  scheduler = new PendingInputScheduler(deps); schedulers.push(scheduler);
  async function flush() { for (let n = 0; n < 16; n++) await Promise.resolve(); await scheduler.drain(); for (let n = 0; n < 16; n++) await Promise.resolve(); await scheduler.drain(); }
  function enqueue(value = input) { const receipt = store.enqueue(value); scheduler.notifyEnqueue(); return receipt; }
  function remove(value: PendingInputEnqueue) {
    const item = store.lookup(value.request.conversationId, value.request.requestId)!;
    const result = store.remove({ version: 1, requestId: id(), conversationId: value.request.conversationId, inputRequestId: value.request.requestId, itemId: item.receipt.itemId }); scheduler.notifyRemove(); return result;
  }
  function resume() {
    const result = store.resume({ version: 1, requestId: id(), conversationId: cid, action: "resume", expectedRevision: store.get(cid).revision }); scheduler.notifyResume(); return result;
  }
  async function complete(n = launches.length - 1, status: Launch["status"] = "completed") { const launch = launches[n]!; launch.status = status; launch.complete.resolve(); await launch.lifecycle.done; await flush(); }
  return { input, cid, state, deps, scheduler, store, coordinator, predecessors, launches, stages, purposes, errors, lifecycleErrors, enqueue, remove, resume, flush, complete };
}

test("FIFO removes first and middle while busy; remaining head alone dispatches", async () => {
  const f = await fixture(), all = [f.input, sibling(f.input, "middle"), sibling(f.input, "last")];
  const busy = f.coordinator.reserveAdmission({ conversationIds: [f.cid], intent: { kind: "handoff" } }); expect(busy.ready).toBe(true);
  all.forEach(i => f.enqueue(i)); await f.flush(); expect(f.state.preflights).toBe(0);
  f.remove(all[1]!); f.remove(all[0]!); expect(f.store.get(f.cid).items.map(i => i.text)).toEqual(["last"]);
  if (busy.ready) f.coordinator.releaseAdmission(busy.lease); f.scheduler.notifyCapacity(); await f.flush();
  expect(f.launches.map(l => l.prompt)).toEqual(["last"]); expect(f.state.boundaries).toBe(1);
});
test("one irreversible claim frees one slot, three waiters refill and successors stay FIFO", async () => {
  const f = await fixture(); f.enqueue(); f.enqueue(sibling(f.input, "second")); f.enqueue(sibling(f.input, "third")); await f.flush();
  f.enqueue(sibling(f.input, "fourth")); expect(() => f.enqueue(sibling(f.input, "fifth"))).toThrow("three waiting"); await f.flush();
  expect(f.launches).toHaveLength(1); expect(f.store.reconciliationWork()).toHaveLength(1);
  expect(f.remove(f.input).outcome).toBe("claimed"); await f.complete(0);
  expect(f.launches.map(l => l.prompt)).toEqual([f.input.request.text, "second"]);
  expect(f.store.inspect(f.cid).history[0]?.history?.kind).toBe("settled");
});
test("same request lease has exact user-prompt intent and waiting preflight owns no lease", async () => {
  const f = await fixture(); f.state.preflightGate = deferred(); f.enqueue(); await f.state.entered.promise;
  expect(f.coordinator.hasAdmission(f.cid)).toBe(false); expect(f.coordinator.hasOwner(f.cid)).toBe(false);
  f.state.preflightGate.resolve(); await f.flush(); const launch = f.launches[0]!;
  expect(launch.context.intent).toEqual({ kind: "user-prompt", requestId: f.input.request.requestId });
  expect(f.stages.filter(s => s.stage === "claim")).toHaveLength(1);
  expect(f.store.enqueue(f.input)).toEqual(f.store.lookup(f.cid, f.input.request.requestId)!.receipt);
  expect(f.launches).toHaveLength(1);
});
test("async removal/head change invalidates initial proof before claim", async () => {
  const f = await fixture(); f.state.preflightGate = deferred(); f.enqueue(); f.enqueue(sibling(f.input, "new head")); await f.state.entered.promise;
  f.remove(f.input); f.state.preflightGate.resolve(); await f.flush();
  expect(f.launches.map(l => l.prompt)).toEqual(["new head"]); expect(f.stages.filter(s => s.stage === "claim")).toHaveLength(1);
});
for (const drift of ["source-changed", "configuration-changed", "context-changed"] as const) test(`async ${drift} pauses durably without claims`, async () => {
  const f = await fixture(); f.state.preflightGate = deferred(); f.enqueue(); await f.state.entered.promise; f.state.drift = drift; f.state.preflightGate.resolve(); await f.flush();
  expect(f.store.inspect(f.cid).pause?.code).toBe(drift); expect(f.store.get(f.cid).items[0]?.state).toBe("waiting"); expect(f.coordinator.hasAdmission(f.cid)).toBe(false);
});
test("transport proof unavailable waits; a later fresh readiness notification can claim", async () => {
  const f = await fixture(); f.state.unavailable = true; f.enqueue(); await f.flush();
  expect(f.store.get(f.cid).paused).toBe(false); expect(f.launches).toHaveLength(0); expect(f.errors).toHaveLength(0);
  f.state.unavailable = false; f.scheduler.poll(); await f.flush(); expect(f.launches).toHaveLength(1); expect(f.state.preflights).toBe(2);
});
for (const status of ["failed", "interrupted"] as const) test(`${status} submitted predecessor pauses successors, exact history is not success`, async () => {
  const f = await fixture(); f.enqueue(); f.enqueue(sibling(f.input)); await f.flush(); await f.complete(0, status);
  expect(f.launches).toHaveLength(1); expect(f.store.get(f.cid).paused).toBe(true);
  expect(f.store.inspect(f.cid).history[0]?.history).toMatchObject({ kind: "settled", status });
});
test("done with cancelling or retained release cannot settle or launch a successor", async () => {
  const f = await fixture(); f.enqueue(); f.enqueue(sibling(f.input)); await f.flush(); const owner = f.launches[0]!.lifecycle.owner;
  owner.cancelling = true; await f.complete(); expect(f.coordinator.owns(owner)).toBe(true); expect(f.store.reconciliationWork()).toHaveLength(1);
  expect(f.store.inspect(f.cid).pause?.code).toBe("stopped"); expect(() => f.resume()).toThrow("unresolved");
});
test("held after-release reconciliation blocks settlement and waiting successor", async () => {
  const f = await fixture(); f.state.reconciliation = deferred(); f.enqueue(); f.enqueue(sibling(f.input)); await f.flush();
  f.launches[0]!.complete.resolve(); for (let n = 0; n < 20; n++) await Promise.resolve();
  expect(f.coordinator.hasOwner(f.cid)).toBe(false); expect(f.coordinator.hasReconciliation(f.cid)).toBe(true);
  f.scheduler.notifyLifecycle(); await f.flush(); expect(f.launches).toHaveLength(1); expect(f.store.reconciliationWork()).toHaveLength(1);
  f.state.reconciliation.resolve(); await f.launches[0]!.lifecycle.done; await f.flush(); expect(f.launches).toHaveLength(2);
});
test("capacity race between conversations has one normal winner and later progress", async () => {
  const f = await fixture("claude-code", 1), other = await pendingFixture(); f.state.preflightGate = deferred(); f.enqueue(); f.enqueue(other);
  await f.state.entered.promise; for (let n = 0; n < 8; n++) await Promise.resolve(); expect(f.state.preflights).toBe(2);
  f.state.preflightGate.resolve(); await f.flush(); expect(f.launches).toHaveLength(1); expect(f.coordinator.occupiedConversationIds().size).toBe(1);
  await f.complete(0); f.scheduler.notifyCapacity(); await f.flush(); expect(f.launches).toHaveLength(2);
});
test("fresh settlement transport proof is required; persisted completed status is insufficient", async () => {
  const f = await fixture(); f.enqueue(); f.enqueue(sibling(f.input)); await f.flush(); f.state.settlementUnavailable = true; await f.complete();
  expect(f.store.reconciliationWork()).toHaveLength(1); expect(f.store.get(f.cid).paused).toBe(false); expect(f.launches).toHaveLength(1);
  f.state.settlementUnavailable = false; f.scheduler.poll(); await f.flush(); expect(f.launches).toHaveLength(2);
});
test("replacement predecessor invalidates awaited head proof, old successful handle cannot authorize replacement", async () => {
  const f = await fixture(); f.enqueue(); await f.flush(); await f.complete();
  f.state.preflightGate = deferred(); f.state.entered = deferred(); f.enqueue(sibling(f.input)); await f.state.entered.promise;
  const old = f.launches[0]!.lifecycle;
  const replacement = { ...old, owner: { ...old.owner, run: { ...old.owner.run, runId: id() } }, successfulSettlement: async () => ({ ready: false as const, code: "dispatch-unsuccessful", reason: "replacement failed" }) };
  f.predecessors.set(f.cid, replacement); f.state.preflightGate.resolve(); await f.flush(); expect(f.launches).toHaveLength(1);
  f.scheduler.notifyLifecycle(); await f.flush(); expect(f.store.inspect(f.cid).pause?.code).toBe("failed"); expect(f.launches).toHaveLength(1);
});
for (const mode of ["unknown", "missing-evidence"] as const) test(`${mode}: lost ready/ack keeps original claim, never replays`, async () => {
  const f = await fixture("opencode"); f.state.mode = mode; f.state.rejectReady = true; f.enqueue(); f.enqueue(sibling(f.input)); await f.flush(); await f.complete();
  const item = f.store.lookup(f.cid, f.input.request.requestId)!.item;
  expect(item.claim?.uncertain).toBe(true); expect(item.claim?.evidence?.submission).toBe("unknown");
  expect(() => f.resume()).toThrow("unresolved"); for (let n = 0; n < 3; n++) { f.scheduler.poll(); await f.flush(); }
  expect(f.launches).toHaveLength(1); expect(f.stages.filter(s => s.stage === "claim")).toHaveLength(1);
});
test("admission rejection without lifecycle/evidence retains claim AND lease, not an inferred withholding", async () => {
  const f = await fixture(); f.state.rejectStage = "active-claim"; f.enqueue(); await f.flush();
  expect(f.launches).toHaveLength(0); expect(f.store.lookup(f.cid, f.input.request.requestId)!.item.claim?.evidence?.submission).toBe("unknown");
  expect(f.coordinator.hasAdmission(f.cid)).toBe(true); f.state.rejectStage = null; f.scheduler.poll(); await f.flush(); expect(f.launches).toHaveLength(0);
});
test("claim refusal leaves removable waiting head, never invokes dispatch", async () => {
  const f = await fixture(); f.state.rejectStage = "claim"; f.enqueue(); await f.flush();
  expect(f.store.get(f.cid).items[0]?.state).toBe("waiting"); expect(f.coordinator.hasAdmission(f.cid)).toBe(false); expect(f.remove(f.input).outcome).toBe("removed"); expect(f.launches).toHaveLength(0);
});
for (const prove of [false, true]) test(`link refusal durable classification requires explicit non-submission (proof=${prove})`, async () => {
  const f = await fixture(); f.state.rejectStage = "link"; f.state.proveInstallRejection = prove; f.enqueue(); f.enqueue(sibling(f.input)); await f.flush();
  expect(f.launches).toHaveLength(0); expect(f.state.boundaries).toBe(0);
  const item = f.store.lookup(f.cid, f.input.request.requestId)!.item;
  expect(prove ? item.history?.kind : item.claim?.evidence?.submission).toBe(prove ? "not-submitted" : "unknown");
  expect(f.coordinator.hasAdmission(f.cid)).toBe(!prove); expect(f.store.get(f.cid).paused).toBe(true);
});
test("native-boundary refusal journals definite non-submission, archives once and pauses waiters", async () => {
  const f = await fixture(); f.state.rejectStage = "before-native"; f.enqueue(); f.enqueue(sibling(f.input)); await f.flush(); await f.launches[0]!.lifecycle.done; await f.flush();
  expect(f.state.boundaries).toBe(0); expect(f.store.lookup(f.cid, f.input.request.requestId)!.item.history?.kind).toBe("not-submitted");
  expect(f.store.get(f.cid).paused).toBe(true); f.scheduler.poll(); await f.flush(); expect(f.launches).toHaveLength(1);
});
test("withheld item is never resubmitted; only bridge live user-resume authorizes remaining waiters", async () => {
  const f = await fixture(); f.state.mode = "withheld"; f.enqueue(); f.enqueue(sibling(f.input, "remaining")); await f.flush(); await f.complete();
  expect(f.store.lookup(f.cid, f.input.request.requestId)!.item.history?.kind).toBe("not-submitted");
  f.state.mode = "submitted"; f.state.userResume = true; f.resume(); await f.flush(); expect(f.launches.map(l => l.prompt)).toEqual([f.input.request.text, "remaining"]);
});
test("ephemeral validateLive rejects serialized authorization outside synchronous mutation", async () => {
  const f = await fixture(); f.enqueue(); await f.flush(); const stage = f.stages.find(s => s.stage === "claim")!;
  expect(() => f.scheduler.validateLive(stage)).toThrow("No synchronous scheduler authority"); expect(f.state.boundaries).toBe(1);
});
test("asynchronous boundary validation and durable storage failure fail closed and retain exact lease", async () => {
  for (const failure of ["async", "disk"] as const) {
    const f = await fixture(); f.enqueue(); if (failure === "async") f.state.asynchronousValidation = true; else f.state.writeFail = true;
    await f.flush(); expect(f.errors).toHaveLength(1); expect(f.coordinator.hasAdmission(f.cid)).toBe(true); expect(f.launches).toHaveLength(0);
  }
});
test("shutdown during uncooperative async preflight closes synchronously, no late claim or deadlock", async () => {
  const f = await fixture(); f.state.preflightGate = deferred(); f.enqueue(); await f.state.entered.promise; await f.scheduler.close();
  expect(f.store.get(f.cid).items[0]?.state).toBe("waiting"); expect(f.coordinator.hasAdmission(f.cid)).toBe(false);
  f.state.preflightGate.resolve(); await f.flush(); expect(f.launches).toHaveLength(0);
});
test("shutdown during admission preflight retains claim; late validation forbids launch", async () => {
  const f = await fixture(); f.state.admissionGate = deferred(); f.enqueue(); await f.state.admissionEntered.promise; await f.scheduler.close();
  expect(f.store.get(f.cid).items[0]?.state).toBe("claimed"); f.state.admissionGate.resolve(); await f.flush();
  expect(f.launches).toHaveLength(0); expect(f.store.lookup(f.cid, f.input.request.requestId)!.item.claim?.uncertain).toBe(true);
});
test("shutdown does not await active native execution; paused/closed outcome is still recordable", async () => {
  const f = await fixture(); f.enqueue(); f.enqueue(sibling(f.input)); await f.flush(); const launch = f.launches[0]!;
  f.store.pause(f.cid, { code: "hidden", reason: "hidden while executing" }); await f.scheduler.close();
  launch.lifecycle.owner.dispatchEvidence!.outcome("submitted", "unknown");
  launch.complete.resolve(); await launch.lifecycle.done; await f.flush();
  expect(f.purposes).toContain("outcome:observation"); expect(f.store.reconciliationWork()).toHaveLength(1); expect(f.launches).toHaveLength(1);
});
test("installed owner can cross native boundary after admission lease release, exact installation is required", async () => {
  const f = await fixture(); f.state.discovery = deferred();
  const original = f.deps.dispatch;
  f.deps.dispatch = async (...args) => { void original(...args).catch(() => {}); for (let n = 0; n < 12; n++) await Promise.resolve();
    f.coordinator.releaseAdmission(args[1]);
    const launch = f.launches[0]!; return { sessionId: f.cid, runId: launch.lifecycle.owner.run.runId, harness: "claude-code", lifecycle: launch.lifecycle }; };
  f.enqueue(); await f.flush(); expect(f.coordinator.hasAdmission(f.cid)).toBe(false); expect(f.state.boundaries).toBe(0);
  f.state.discovery.resolve(); await f.flush(); expect(f.state.boundaries).toBe(1); expect(f.errors).toHaveLength(0);
});
for (const flag of ["stopRequested", "cancelling", "stopping", "settled", "completed", "failed", "interrupted"] as const) test(`installed owner ${flag} during held discovery refuses submission before live proof/native intent`, async () => {
  const f = await fixture("claude-code", 1); f.state.discovery = deferred(); f.state.holdRelease = flag !== "cancelling";
  f.enqueue(); f.enqueue(sibling(f.input)); await f.flush(); const launch = f.launches[0]!, owner = launch.lifecycle.owner;
  expect(f.coordinator.getOwner(f.cid)).toBe(owner); expect(f.state.boundaries).toBe(0);
  if (flag === "completed" || flag === "failed" || flag === "interrupted") owner.run.status = flag;
  else if (flag === "stopping") owner.stopping = deferred<boolean>().promise;
  else owner[flag] = true;
  const { source, runId, nativeCommandId, requestId } = launch.lifecycle.submissionEvidence(), identity = { source, runId, nativeCommandId, requestId };
  const validated = f.purposes.length;
  expect(() => launch.context.validate!(identity)).toThrow("Installed owner is stopped, cancelling or no longer running");
  expect(() => launch.context.evidence!.beforeNative!({ ...identity, submission: "attempted", nativeAcceptance: "unknown" })).toThrow("Installed owner is stopped, cancelling or no longer running");
  expect(f.purposes).toHaveLength(validated);
  expect(f.store.lookup(f.cid, f.input.request.requestId)!.item.claim?.possibleNative).toBe(false);
  expect(f.store.lookup(f.cid, f.input.request.requestId)!.item.claim?.evidence).toBeNull();
  f.state.discovery.resolve(); await launch.lifecycle.done; await f.flush();
  const item = f.store.lookup(f.cid, f.input.request.requestId)!.item;
  expect(f.state.boundaries).toBe(0); expect(item.claim?.evidence?.submission).toBe("unknown"); expect(item.history).toBeNull();
  expect(f.purposes).toContain("outcome:observation"); expect(f.store.get(f.cid).paused).toBe(true);
  expect(f.coordinator.owns(owner)).toBe(true); expect(f.coordinator.hasAdmission(f.cid)).toBe(true);
  expect(f.coordinator.reserveAdmission({ conversationIds: [f.cid], intent: { kind: "user-prompt", requestId: id() } }).ready).toBe(false);
  expect(f.coordinator.reserveAdmission({ conversationIds: [id()], intent: { kind: "user-prompt", requestId: id() } }).ready).toBe(false);
  expect(() => f.resume()).toThrow("unresolved"); f.scheduler.poll(); await f.flush();
  expect(f.launches).toHaveLength(1); expect(f.stages.filter(s => s.stage === "claim")).toHaveLength(1); expect(f.errors).toHaveLength(0);
});
test("cancelled paused owner can record later exact accepted outcome without reopening submission", async () => {
  const f = await fixture("opencode", 1); f.state.mode = "unknown"; f.enqueue(); f.enqueue(sibling(f.input)); await f.flush();
  const launch = f.launches[0]!, owner = launch.lifecycle.owner;
  owner.cancelling = true; owner.stopRequested = true; f.store.pause(f.cid, { code: "stopped", reason: "cancellation in progress" });
  await f.complete(0, "interrupted"); expect(f.coordinator.owns(owner)).toBe(true);
  const { source, runId, nativeCommandId, requestId } = launch.lifecycle.submissionEvidence(), identity = { source, runId, nativeCommandId, requestId };
  expect(() => launch.context.evidence!.outcome!({ ...identity, source: { ...source, nativeSessionId: id() }, submission: "submitted", nativeAcceptance: "accepted" })).toThrow("Admission identity differs from durable claim");
  owner.dispatchEvidence!.outcome("submitted", "accepted");
  expect(f.store.lookup(f.cid, f.input.request.requestId)!.item.claim?.evidence).toEqual({ ...identity, submission: "submitted", nativeAcceptance: "accepted" });
  expect(f.purposes).toContain("outcome:observation");
  const validated = f.purposes.length;
  expect(() => launch.context.validate!(identity)).toThrow();
  expect(f.purposes).toHaveLength(validated); expect(() => owner.dispatchEvidence!.beforeNative()).toThrow();
  f.scheduler.poll(); await f.flush(); expect(f.state.boundaries).toBe(1); expect(f.launches).toHaveLength(1);
  expect(f.store.get(f.cid).paused).toBe(true); expect(f.store.lookup(f.cid, f.input.request.requestId)!.item.history).toBeNull();
  expect(f.coordinator.hasAdmission(f.cid)).toBe(true);
  expect(f.coordinator.reserveAdmission({ conversationIds: [f.cid], intent: { kind: "user-prompt", requestId: id() } }).ready).toBe(false);
  owner.cancelling = false; expect(f.coordinator.releaseOwner(owner)).toBe(true); f.scheduler.notifyLifecycle(); await f.flush();
  expect(f.purposes).toContain("settlement:observation");
  expect(f.store.lookup(f.cid, f.input.request.requestId)!.item.history).toMatchObject({ kind: "settled", status: "interrupted", authorization: { source, predecessorRunId: runId } });
  expect(f.store.get(f.cid).paused).toBe(true); expect(f.state.boundaries).toBe(1); expect(f.launches).toHaveLength(1);
  expect(f.errors).toHaveLength(0); expect(f.lifecycleErrors).toHaveLength(0);
});
test("busy permanent head has no self-spin; bounded round-robin progresses another conversation", async () => {
  const f = await fixture("claude-code", 2, 1), other = await pendingFixture();
  f.coordinator.reserveAdmission({ conversationIds: [f.cid], intent: { kind: "handoff" } }); f.enqueue(); f.enqueue(other); await f.flush();
  expect(f.state.preflights).toBe(0); expect(f.launches).toHaveLength(0);
  f.scheduler.poll(); await f.flush(); expect(f.launches).toHaveLength(1); expect(f.launches[0]!.lifecycle.owner.run.sessionId).toBe(other.request.conversationId);
  const count = f.state.preflights; await f.flush(); expect(f.state.preflights).toBe(count);
});
test("OC dispatch uses explicit native-queued-handoff; other text remains App-only", async () => {
  const f = await fixture("opencode"); f.enqueue(); f.enqueue(sibling(f.input)); f.enqueue(sibling(f.input)); await f.flush();
  expect(f.launches[0]!.context.delivery).toBe("native-queued-handoff"); expect(f.launches[0]!.context.nativeCommandId).toMatch(/^msg_/);
  expect(f.store.get(f.cid).items.filter(i => i.state === "waiting")).toHaveLength(2); expect(f.launches).toHaveLength(1);
});
test("outcome refusal after possible-native retains the original run and pauses, never archives withholding", async () => {
  const f = await fixture("opencode"); f.state.rejectStage = "outcome"; f.enqueue(); f.enqueue(sibling(f.input)); await f.flush(); await f.launches[0]!.lifecycle.done; await f.flush();
  const item = f.store.lookup(f.cid, f.input.request.requestId)!.item;
  expect(item.claim?.possibleNative).toBe(true); expect(item.claim?.evidence?.submission).toBe("attempted"); expect(item.history).toBeNull();
  expect(f.store.get(f.cid).paused).toBe(true); f.state.rejectStage = null; f.scheduler.poll(); await f.flush();
  expect(f.store.lookup(f.cid, f.input.request.requestId)!.item.claim?.uncertain).toBe(true); expect(f.launches).toHaveLength(1);
});
test("paused submitted run can record fresh exact history without granting its waiter submission", async () => {
  const f = await fixture(); f.enqueue(); f.enqueue(sibling(f.input)); await f.flush(); f.store.pause(f.cid, { code: "hidden", reason: "domain pause" });
  await f.complete(); expect(f.store.inspect(f.cid).history[0]?.history).toMatchObject({ kind: "settled", status: "completed" });
  expect(f.store.get(f.cid).paused).toBe(true); expect(f.purposes).toContain("settlement:observation"); expect(f.launches).toHaveLength(1);
});
test("settlement authorization refusal retains submitted claim, no successor submission", async () => {
  const f = await fixture(); f.enqueue(); f.enqueue(sibling(f.input)); await f.flush(); f.state.rejectStage = "settlement"; await f.complete();
  expect(f.store.reconciliationWork()).toHaveLength(1); expect(f.launches).toHaveLength(1); expect(f.coordinator.hasAdmission(f.cid)).toBe(true);
  f.state.rejectStage = null; f.scheduler.poll(); await f.flush(); expect(f.launches).toHaveLength(2);
});
test("native boundary rejects replacement installation even when source/run IDs were copied", async () => {
  const f = await fixture(); f.state.discovery = deferred(); const dispatch = f.deps.dispatch;
  let originalLease!: Parameters<typeof dispatch>[1];
  f.deps.dispatch = (...args) => { originalLease = args[1]; return dispatch(...args); };
  f.enqueue(); await f.flush(); const original = f.launches[0]!.lifecycle.owner;
  original.settled = true; expect(f.coordinator.releaseOwner(original)).toBe(true);
  const lease = f.coordinator.reserveAdmission({ conversationIds: [f.cid], intent: { kind: "user-prompt", requestId: f.input.request.requestId } });
  // The scheduler reservation is still held: even exact request intent cannot
  // reserve a second lease. Explicitly releasing it still cannot forge install.
  expect(lease.ready).toBe(false);
  f.coordinator.releaseAdmission(originalLease);
  const newLease = f.coordinator.reserveAdmission({ conversationIds: [f.cid], intent: { kind: "user-prompt", requestId: f.input.request.requestId } }); expect(newLease.ready).toBe(true);
  const replacement: RunOwner = { ...original, run: { ...original.run }, settled: false, done: deferred().promise };
  if (newLease.ready) expect(f.coordinator.installOwner(newLease.lease, replacement).ready).toBe(true);
  f.state.discovery.resolve(); await f.launches[0]!.lifecycle.done; await f.flush();
  expect(f.state.boundaries).toBe(0); expect(f.coordinator.getOwner(f.cid)).toBe(replacement); expect(f.store.lookup(f.cid, f.input.request.requestId)!.item.history).toBeNull();
  expect(f.store.lookup(f.cid, f.input.request.requestId)!.item.claim?.uncertain).toBe(true);
});
test("shutdown after owner publication but before discovery forbids a late native boundary", async () => {
  const f = await fixture(); f.state.discovery = deferred(); f.enqueue(); await f.flush(); await f.scheduler.close();
  f.state.discovery.resolve(); await f.launches[0]!.lifecycle.done; await f.flush();
  expect(f.state.boundaries).toBe(0); expect(f.store.lookup(f.cid, f.input.request.requestId)!.item.claim?.evidence?.submission).toBe("unknown");
  expect(f.store.reconciliationWork()).toHaveLength(1);
});
test("proof current predecessor cannot be replaced while shared asynchronous success is pending", async () => {
  const f = await fixture(); f.enqueue(); await f.flush(); await f.complete(); const previous = f.launches[0]!.lifecycle;
  const proofEntered = deferred(), proofGate = deferred();
  const retained = { ...previous, successfulSettlement: async () => { proofEntered.resolve(); await proofGate.promise; return { ready: true as const }; } };
  f.predecessors.set(f.cid, retained); f.enqueue(sibling(f.input)); await proofEntered.promise;
  f.predecessors.delete(f.cid); proofGate.resolve(); await f.flush();
  expect(f.launches).toHaveLength(1); expect(f.store.get(f.cid).items[0]?.state).toBe("waiting");
});
test("healthy done still waits for actual coordinator owner release and fresh readiness", async () => {
  const f = await fixture(); f.state.holdRelease = true; f.enqueue(); f.enqueue(sibling(f.input)); await f.flush(); await f.complete();
  const owner = f.launches[0]!.lifecycle.owner;
  expect(owner.settled).toBe(true); expect(f.coordinator.owns(owner)).toBe(true); expect(f.store.reconciliationWork()).toHaveLength(1); expect(f.launches).toHaveLength(1);
  f.state.holdRelease = false; expect(f.coordinator.releaseOwner(owner)).toBe(true); f.scheduler.notifyCapacity(); await f.flush(); expect(f.launches).toHaveLength(2);
});
test("synchronous configuration drift after preflight refuses claim before durable/native effects", async () => {
  const f = await fixture(), allocate = f.deps.allocate;
  f.deps.allocate = harness => { f.state.drift = "configuration-changed"; return allocate(harness); };
  f.enqueue(); await f.flush(); expect(f.store.inspect(f.cid).pause?.code).toBe("configuration-changed");
  expect(f.store.get(f.cid).items[0]?.state).toBe("waiting"); expect(f.coordinator.hasAdmission(f.cid)).toBe(false); expect(f.state.boundaries).toBe(0);
});
test("serialized last success is never an authorization fallback when live predecessor disappears", async () => {
  const f = await fixture(); f.enqueue(); f.enqueue(sibling(f.input)); await f.flush();
  f.state.preflightGate = deferred(); f.launches[0]!.complete.resolve(); await f.launches[0]!.lifecycle.done;
  for (let n = 0; n < 24; n++) await Promise.resolve();
  // History may be settled, but the next head's outstanding live selection is
  // invalidated. Removing a lifecycle handle does not turn disk DTOs into proof.
  f.predecessors.delete(f.cid); f.state.preflightGate.resolve(); await f.flush(); f.scheduler.poll(); await f.flush();
  expect(f.launches).toHaveLength(1); expect(f.store.get(f.cid).items.some(i => i.state === "waiting")).toBe(true);
});
