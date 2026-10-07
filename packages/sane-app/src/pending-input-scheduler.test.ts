import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConversationCoordinator } from "./conversation-coordinator";
import { startDispatchLifecycle, DispatchProofUnavailableError, type DispatchLifecycle, type HarnessDispatchAdapter } from "./harness-dispatch";
import { dispatchSource } from "./pending-input-codec";
import { PendingInputDomainError, type PendingInputAuthorization, type PendingInputEnqueue, type PendingInputLiveValidation } from "./pending-input-contract";
import { PendingInputStore } from "./pending-input-store";
import { PendingInputScheduler, type PendingInputDispatchProof, type PendingInputLiveProof, type PendingInputSchedulerDependencies, type PendingInputSelection } from "./pending-input-scheduler";
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
    holdRelease: false, userResume: false, currentIdle: true, writeFail: false, asynchronousValidation: false,
  };
  let scheduler!: PendingInputScheduler;
  let coordinator = new ConversationCoordinator<RunOwner>({ maxConcurrentRuns: capacity });
  const storeId = id();
  const storeDependencies = {
    validateLive: (value: PendingInputLiveValidation) => { stages.push(value); if (!["enqueue", "resume"].includes(value.stage)) scheduler.validateLive(value); },
    write: (...args: Parameters<typeof atomicAppRecord>) => { if (state.writeFail) throw new Error("disk fsync failed"); atomicAppRecord(...args); },
  };
  let store = new PendingInputStore(dir, storeId, storeDependencies);
  const live = (selection: PendingInputSelection, kind: PendingInputAuthorization["kind"], runId?: string, resume = false): PendingInputLiveProof => ({
    authorization: { kind, authorizationId: id(), chainId: selection.item.chainId, source: dispatchSource(selection.item.snapshot), predecessorRunId: kind === "settlement" ? runId! : selection.predecessorRunId !== undefined ? selection.predecessorRunId : selection.predecessor?.owner.run.runId ?? null },
    validate: (value, purpose) => {
      purposes.push(`${value.stage}:${purpose}`);
      if (state.asynchronousValidation) return Promise.resolve() as unknown as void;
      if (state.rejectStage === value.stage || purpose === "observation" && state.rejectObservation) throw new PendingInputDomainError("domain-refusal", `refuse ${value.stage}`);
      if (purpose === "submission" && state.drift) throw new PendingInputDomainError(state.drift, "live pins changed");
      if (purpose === "submission" && resume) {
        if (!state.userResume || !state.currentIdle) throw new PendingInputDomainError("resume-revoked", "Fresh user consent/current idle proof revoked");
        const predecessor = selection.predecessor?.owner, owner = coordinator.getOwner(cid);
        if (predecessor && (!predecessor.settled || predecessor.cancelling || coordinator.owns(predecessor)) || coordinator.hasReconciliation(cid))
          throw new PendingInputDomainError("conversation-busy", "Live resume release/idle/reconciliation proof revoked");
        if (owner && predecessors.get(cid)?.owner !== owner)
          throw new PendingInputDomainError("scheduler-owner", "Live resume installed source pin changed");
      }
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
      return { kind: "ready", proof: { ...live(selection, "dispatch", undefined, state.userResume), basis: state.userResume ? "user-resume" : selection.predecessor ? "successful-predecessor" : "new-idle-chain" } };
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
  async function restart() {
    await scheduler.close(); predecessors.clear();
    coordinator = new ConversationCoordinator<RunOwner>({ maxConcurrentRuns: capacity });
    store = new PendingInputStore(dir, storeId, storeDependencies);
    deps.store = store; deps.coordinator = coordinator;
    scheduler = new PendingInputScheduler(deps); schedulers.push(scheduler);
    return { scheduler, store, coordinator };
  }
  return { input, cid, state, deps, scheduler, store, coordinator, predecessors, launches, stages, purposes, errors, lifecycleErrors, enqueue, remove, resume, flush, complete, restart };
}

// Real claim, submitted lifecycle, exact failure settlement and retained chain:
// resume must follow this archived run, never a fabricated empty predecessor.
async function stoppedFixture(harness: "claude-code" | "opencode" = "claude-code", status: Launch["status"] = "interrupted") {
  const f = await fixture(harness);
  f.enqueue(); f.enqueue(sibling(f.input, "remaining")); await f.flush();
  const previous = f.launches[0]!.lifecycle;
  previous.owner.stopRequested = true; previous.owner.stopping = Promise.resolve(true);
  await f.complete(0, status);
  expect(f.store.lookup(f.cid, f.input.request.requestId)!.item.history).toMatchObject({ kind: "settled", status, authorization: { predecessorRunId: previous.owner.run.runId } });
  expect(f.store.readRecords().conversations[0]?.lastPredecessorRunId).toBe(previous.owner.run.runId);
  expect(f.coordinator.owns(previous.owner)).toBe(false);
  return { ...f, previous };
}

async function restartedWaitingFixture(harness: "claude-code" | "opencode" = "claude-code", status: Launch["status"] = "interrupted") {
  const f = await fixture(harness);
  f.enqueue(); f.enqueue(sibling(f.input, "remaining")); await f.flush();
  f.store.pause(f.cid, { code: "hidden", reason: "hold waiting successor through prior settlement" });
  await f.complete(0, status);
  const previous = f.launches[0]!.lifecycle, chainId = f.store.inspect(f.cid).chain!.chainId;
  const fresh = await f.restart();
  expect(fresh.store.inspect(f.cid).recoveryRequired).toBe(true);
  expect(fresh.store.recover()).toEqual([]);
  expect(f.deps.predecessor(f.cid)).toBeNull();
  return { ...f, ...fresh, previous, chainId };
}

for (const harness of ["claude-code", "opencode"] as const) for (const status of ["completed", "failed", "interrupted"] as const)
  test(`${harness}: fresh live resume binds ${status} predecessor identity after restart without its lifecycle`, async () => {
    const f = await restartedWaitingFixture(harness, status), oldRunId = f.previous.owner.run.runId;
    const oldSuccess = spyOn(f.previous, "successfulSettlement"), oldAuthorization = f.store.inspect(f.cid).lastAuthorization;
    let selected: PendingInputSelection | undefined;
    const preflight = f.deps.preflight;
    f.deps.preflight = (...args) => { selected = args[0]; return preflight(...args); };
    f.state.userResume = true; f.resume(); await f.flush();
    expect(selected).toMatchObject({ predecessor: null, predecessorRunId: oldRunId }); expect(Object.isFrozen(selected)).toBe(true);
    const launch = f.launches[1]!, claim = f.store.lookup(f.cid, launch.context.intent.requestId!)!.item.claim!;
    expect(claim.authorization).toMatchObject({ kind: "dispatch", chainId: f.chainId, predecessorRunId: oldRunId });
    expect(claim.authorization.authorizationId).not.toBe(oldAuthorization!.authorizationId);
    expect(f.store.inspect(f.cid).lastAuthorization).toEqual(oldAuthorization);
    expect(f.store.inspect(f.cid).lastPredecessorRunId).toBe(oldRunId);
    expect(f.state.boundaries).toBe(2); expect(oldSuccess).not.toHaveBeenCalled();
    expect(f.purposes).toContain("before-native:submission");
    expect(f.store.lookup(f.cid, f.input.request.requestId)!.item.history).toMatchObject({ status });
    // The resumed run settles by its own exact lifecycle/ID, and the next
    // ordinary successor must use THAT live handle's fresh successful proof.
    f.state.userResume = false; f.enqueue(sibling(f.input, "next ordinary successor")); await f.complete(1);
    const next = f.launches[2]!;
    expect(f.store.lookup(f.cid, launch.context.intent.requestId!)!.item.history).toMatchObject({ status: "completed", authorization: { predecessorRunId: launch.lifecycle.owner.run.runId } });
    expect(f.store.lookup(f.cid, next.context.intent.requestId!)!.item.claim?.authorization.predecessorRunId).toBe(launch.lifecycle.owner.run.runId);
    expect(oldSuccess).not.toHaveBeenCalled(); oldSuccess.mockRestore();
    expect(f.errors).toHaveLength(0); expect(f.lifecycleErrors).toHaveLength(0);
  });

for (const basis of ["new-idle-chain", "successful-predecessor"] as const)
  test(`missing historical lifecycle cannot authorize ${basis}, even with a correctly bound fresh DTO`, async () => {
    for (const status of ["completed", "failed", "interrupted"] as const) {
      const f = await restartedWaitingFixture("claude-code", status), preflight = f.deps.preflight;
      f.deps.preflight = async (...args) => {
        const result = await preflight(...args);
        return result.kind === "ready" ? { ...result, proof: { ...result.proof, basis } } : result;
      };
      f.resume(); await f.flush(); f.scheduler.poll(); await f.flush();
      expect(f.launches).toHaveLength(1); expect(f.state.boundaries).toBe(1);
      expect(f.store.get(f.cid).items[0]?.state).toBe("waiting"); expect(f.coordinator.hasAdmission(f.cid)).toBe(false);
      expect(f.errors).toHaveLength(0);
    }
  });

for (const mismatch of ["wrong-id", "null-id", "foreign-chain"] as const)
  test(`restart live resume refuses ${mismatch} authorization instead of the original binding`, async () => {
    const f = await restartedWaitingFixture(), preflight = f.deps.preflight;
    f.deps.preflight = async (...args) => {
      const result = await preflight(...args); if (result.kind !== "ready") return result;
      return { ...result, proof: { ...result.proof, authorization: { ...result.proof.authorization,
        ...(mismatch === "foreign-chain" ? { chainId: id() } : { predecessorRunId: mismatch === "null-id" ? null : id() }),
      } } };
    };
    f.state.userResume = true; f.resume(); await f.flush();
    expect(f.launches).toHaveLength(1); expect(f.state.boundaries).toBe(1);
    expect(f.store.get(f.cid).items[0]?.state).toBe("waiting"); expect(f.coordinator.hasAdmission(f.cid)).toBe(false);
    expect(f.errors).toHaveLength(0);
  });

test("restart retains the old binding but neither store resume nor serialized history mints live consent/idle authority", async () => {
  for (const revoked of ["consent", "idle"] as const) for (const stage of ["claim", "before-native"] as const) {
    const f = await restartedWaitingFixture(); f.state.userResume = true;
    if (stage === "before-native") f.state.discovery = deferred();
    else {
      const allocate = f.deps.allocate;
      f.deps.allocate = harness => { if (revoked === "consent") f.state.userResume = false; else f.state.currentIdle = false; return allocate(harness); };
    }
    f.resume(); await f.flush();
    if (stage === "before-native") {
      if (revoked === "consent") f.state.userResume = false; else f.state.currentIdle = false;
      f.state.discovery!.resolve(); await f.launches[1]!.lifecycle.done; await f.flush();
    }
    expect(f.state.boundaries).toBe(1);
    expect(f.launches).toHaveLength(stage === "claim" ? 1 : 2);
    expect(f.store.inspect(f.cid).lastPredecessorRunId).toBe(f.previous.owner.run.runId);
    expect(f.store.lookup(f.cid, f.input.request.requestId)!.item.history).toMatchObject({ status: "interrupted" });
  }
});

test("overwriting historical authorization metadata does not replace mandatory live resume validation", async () => {
  const f = await restartedWaitingFixture(); f.state.userResume = true; f.state.currentIdle = false;
  const inspect = f.store.inspect.bind(f.store), authorizationId = id();
  f.store.inspect = cid => {
    const view = inspect(cid);
    return { ...view, lastAuthorization: view.lastAuthorization && { ...view.lastAuthorization, authorizationId } };
  };
  f.resume(); await f.flush();
  expect(f.purposes).toContain("claim:submission");
  expect(f.launches).toHaveLength(1); expect(f.state.boundaries).toBe(1);
  expect(f.store.get(f.cid).items[0]?.state).toBe("waiting"); expect(f.coordinator.hasAdmission(f.cid)).toBe(false);
  expect(f.store.readRecords().conversations[0]?.lastAuthorization?.authorizationId).not.toBe(authorizationId);
  expect(f.errors).toHaveLength(0);
});

for (const boundary of ["preflight", "admission", "callback"] as const)
  test(`original durable predecessor identity changed at ${boundary} invalidates restart resume`, async () => {
    const f = await restartedWaitingFixture(); f.state.userResume = true;
    const inspect = f.store.inspect.bind(f.store), replacementId = id(); let changed = false;
    f.store.inspect = cid => {
      const view = inspect(cid);
      return changed ? { ...view, lastPredecessorRunId: replacementId, lastAuthorization: view.lastAuthorization && { ...view.lastAuthorization, predecessorRunId: replacementId } } : view;
    };
    if (boundary === "preflight") { f.state.preflightGate = deferred(); f.state.entered = deferred(); }
    if (boundary === "admission") { f.state.admissionGate = deferred(); f.state.admissionEntered = deferred(); }
    if (boundary === "callback") {
      const preflight = f.deps.preflight;
      f.deps.preflight = async (...args) => {
        const result = await preflight(...args); if (result.kind !== "ready") return result;
        const validate = result.proof.validate;
        return { ...result, proof: { ...result.proof, validate: (input, purpose) => { validate(input, purpose); if (input.stage === "claim") changed = true; } } };
      };
    }
    f.resume();
    if (boundary !== "callback") {
      await (boundary === "preflight" ? f.state.entered : f.state.admissionEntered).promise; changed = true;
      (boundary === "preflight" ? f.state.preflightGate : f.state.admissionGate)!.resolve();
    }
    await f.flush();
    expect(f.state.boundaries).toBe(1); expect(f.launches).toHaveLength(1);
    expect(f.store.get(f.cid).items[0]?.state).toBe(boundary === "admission" ? "claimed" : "waiting");
    expect(f.errors).toHaveLength(0);
  });

test("published resumed lifecycle does not replace the original identity pin at discovery/native callback", async () => {
  for (const boundary of ["discovery", "native-callback"] as const) {
    const f = await restartedWaitingFixture(); f.state.userResume = true; f.state.discovery = deferred();
    const inspect = f.store.inspect.bind(f.store), replacementId = id(); let changed = false;
    f.store.inspect = cid => {
      const view = inspect(cid);
      return changed ? { ...view, lastPredecessorRunId: replacementId, lastAuthorization: view.lastAuthorization && { ...view.lastAuthorization, predecessorRunId: replacementId } } : view;
    };
    if (boundary === "native-callback") {
      const preflight = f.deps.preflight;
      f.deps.preflight = async (...args) => {
        const result = await preflight(...args); if (result.kind !== "ready") return result;
        const validate = result.proof.validate;
        return { ...result, proof: { ...result.proof, validate: (input, purpose) => { validate(input, purpose); if (input.stage === "before-native") changed = true; } } };
      };
    }
    f.resume(); await f.flush(); const launch = f.launches[1]!;
    expect(f.deps.predecessor(f.cid)).toBe(launch.lifecycle);
    expect(f.store.lookup(f.cid, launch.context.intent.requestId!)!.item.claim?.authorization.predecessorRunId).toBe(f.previous.owner.run.runId);
    if (boundary === "discovery") changed = true;
    f.state.discovery.resolve(); await launch.lifecycle.done; await f.flush();
    expect(f.state.boundaries).toBe(1); expect(f.launches).toHaveLength(2);
    const item = f.store.lookup(f.cid, launch.context.intent.requestId!)!.item;
    expect(item.claim?.possibleNative).toBe(false);
    expect(item.history?.kind).toBe(boundary === "native-callback" ? "not-submitted" : undefined);
    expect(f.store.readRecords().conversations[0]?.lastPredecessorRunId).toBe(f.previous.owner.run.runId);
    expect(f.errors).toHaveLength(0);
  }
});

test("restart preflight queue head/revision/chain changes invalidate a captured missing-lifecycle selection", async () => {
  for (const change of ["head", "revision", "chain"] as const) {
    const f = await restartedWaitingFixture(); f.state.userResume = true;
    f.state.preflightGate = deferred(); f.state.entered = deferred(); f.resume(); await f.state.entered.promise;
    const remaining = f.store.get(f.cid).items[0]!;
    if (change === "revision") f.enqueue(sibling(f.input, "new tail"));
    else {
      f.remove({ request: { ...f.input.request, requestId: remaining.requestId, text: remaining.text }, snapshot: f.input.snapshot });
      if (change === "chain") f.enqueue(sibling(f.input, "new chain"));
    }
    // Keep later coalesced passes waiting to isolate the original selection.
    f.deps.preflight = async () => ({ kind: "wait" });
    f.state.preflightGate.resolve(); await f.flush();
    expect(f.stages.filter(s => s.stage === "claim")).toHaveLength(1);
    expect(f.state.boundaries).toBe(1);
  }
});

test("live resume claim callback cannot change selected chain/head/revision and authorize the original boundary", async () => {
  for (const change of ["chain", "head", "revision"] as const) {
    const f = await restartedWaitingFixture(); f.state.userResume = true;
    const inspect = f.store.inspect.bind(f.store), replacementId = id(); let changed = false;
    f.store.inspect = cid => {
      const view = inspect(cid); if (!changed) return view;
      if (change === "chain") return { ...view, chain: view.chain && { ...view.chain, chainId: replacementId } };
      return { ...view, snapshot: { ...view.snapshot,
        ...(change === "revision" ? { revision: view.snapshot.revision + 1 }
          : { items: view.snapshot.items.map(item => ({ ...item, itemId: replacementId })) }),
      } };
    };
    const preflight = f.deps.preflight;
    f.deps.preflight = async (...args) => {
      const result = await preflight(...args); if (result.kind !== "ready") return result;
      const validate = result.proof.validate;
      return { ...result, proof: { ...result.proof, validate: (input, purpose) => { validate(input, purpose); if (input.stage === "claim") changed = true; } } };
    };
    f.resume(); await f.flush();
    expect(f.launches).toHaveLength(1); expect(f.state.boundaries).toBe(1);
    expect(f.store.get(f.cid).items[0]?.state).toBe("waiting"); expect(f.coordinator.hasAdmission(f.cid)).toBe(false);
    expect(f.errors).toHaveLength(0);
  }
});

test("current-chain live handle identity must agree with durable binding; removing it is not a release proof", async () => {
  const f = await stoppedFixture(); f.state.userResume = true;
  const originalRunId = f.previous.owner.run.runId; f.previous.owner.run.runId = id();
  f.resume(); await f.flush();
  expect(f.launches).toHaveLength(1); expect(f.coordinator.hasAdmission(f.cid)).toBe(false);
  f.previous.owner.run.runId = originalRunId; f.previous.owner.cancelling = true;
  f.scheduler.poll(); await f.flush();
  expect(f.launches).toHaveLength(1); expect(f.state.boundaries).toBe(1);
  expect(f.errors).toHaveLength(0);
});

test("foreign-chain historical predecessor is not a fallback for a genuinely new idle chain", async () => {
  const f = await fixture(); f.enqueue(); await f.flush(); await f.complete();
  const oldRunId = f.launches[0]!.lifecycle.owner.run.runId, oldChainId = f.store.inspect(f.cid).lastAuthorization!.chainId;
  const fresh = await f.restart(); expect(fresh.store.inspect(f.cid).recoveryRequired).toBe(false);
  let selected: PendingInputSelection | undefined; const preflight = f.deps.preflight;
  f.deps.preflight = (...args) => { selected = args[0]; return preflight(...args); };
  f.enqueue(sibling(f.input)); await f.flush();
  expect(selected).toMatchObject({ predecessor: null, predecessorRunId: null });
  expect(selected!.item.chainId).not.toBe(oldChainId);
  expect(fresh.store.inspect(f.cid).lastPredecessorRunId).toBe(oldRunId);
  expect(f.launches).toHaveLength(2); expect(f.state.boundaries).toBe(2);
  expect(f.errors).toHaveLength(0);
});

test("a fresh idle chain cannot borrow a foreign chain's historical predecessor even with user-resume basis", async () => {
  const f = await fixture(); f.enqueue(); await f.flush(); await f.complete();
  const oldRunId = f.launches[0]!.lifecycle.owner.run.runId, fresh = await f.restart(), preflight = f.deps.preflight;
  f.state.userResume = true;
  f.deps.preflight = async (...args) => {
    expect(args[0].predecessorRunId).toBeNull();
    const result = await preflight(...args); if (result.kind !== "ready") return result;
    return { ...result, proof: { ...result.proof, authorization: { ...result.proof.authorization, predecessorRunId: oldRunId } } };
  };
  f.enqueue(sibling(f.input)); await f.flush();
  expect(f.launches).toHaveLength(1); expect(f.state.boundaries).toBe(1);
  expect(fresh.store.get(f.cid).items[0]?.state).toBe("waiting"); expect(fresh.coordinator.hasAdmission(f.cid)).toBe(false);
  expect(f.errors).toHaveLength(0);
});

test("unresolved recovered unknown claims never become eligible with a new user-resume proof", async () => {
  const f = await fixture("opencode"); f.state.mode = "unknown"; f.enqueue(); f.enqueue(sibling(f.input)); await f.flush(); await f.complete();
  const original = f.store.lookup(f.cid, f.input.request.requestId)!.item.claim!, fresh = await f.restart();
  expect(fresh.store.recover()).toHaveLength(1); f.state.userResume = true;
  expect(() => f.resume()).toThrow("unresolved"); const preflights = f.state.preflights;
  fresh.scheduler.notifyResume(); fresh.scheduler.poll(); await f.flush();
  expect(f.state.preflights).toBe(preflights); expect(f.launches).toHaveLength(1); expect(f.state.boundaries).toBe(1);
  expect(fresh.store.lookup(f.cid, f.input.request.requestId)!.item.claim?.identity).toEqual(original.identity);
  expect(fresh.store.lookup(f.cid, f.input.request.requestId)!.item.claim?.uncertain).toBe(true);
});

test("fresh resume identity binding grants no exemption from normal coordinator capacity", async () => {
  const f = await restartedWaitingFixture(); f.state.userResume = true;
  const one = f.coordinator.reserveAdmission({ conversationIds: [id()], intent: { kind: "handoff" } });
  const two = f.coordinator.reserveAdmission({ conversationIds: [id()], intent: { kind: "handoff" } });
  expect(one.ready).toBe(true); expect(two.ready).toBe(true);
  const preflights = f.state.preflights; f.resume(); await f.flush();
  expect(f.state.preflights).toBe(preflights); expect(f.launches).toHaveLength(1);
  expect(f.store.get(f.cid).items[0]?.state).toBe("waiting"); expect(f.coordinator.hasAdmission(f.cid)).toBe(false);
  if (one.ready) f.coordinator.releaseAdmission(one.lease);
  f.scheduler.notifyCapacity(); await f.flush();
  expect(f.launches).toHaveLength(2); expect(f.state.boundaries).toBe(2);
  expect(f.errors).toHaveLength(0);
});

for (const harness of ["claude-code", "opencode"] as const) test(`${harness}: live resume follows the exact failed/stopped archived predecessor without success`, async () => {
  for (const status of ["failed", "interrupted"] as const) {
    const f = await stoppedFixture(harness, status), owner = f.previous.owner;
    expect((await f.previous.successfulSettlement()).ready).toBe(false);
    f.state.userResume = true; f.resume(); await f.flush();
    expect(f.launches.map(l => l.prompt)).toEqual([f.input.request.text, "remaining"]);
    expect(f.state.boundaries).toBe(2);
    const claim = f.store.lookup(f.cid, f.launches[1]!.context.intent.requestId!)!.item.claim!;
    expect(claim.authorization.predecessorRunId).toBe(owner.run.runId);
    const stages = f.stages.filter(s => s.identity?.runId === claim.identity.runId && ["claim", "active-claim", "link", "before-native"].includes(s.stage));
    expect(stages.map(s => s.stage)).toEqual(["claim", "active-claim", "active-claim", "link", "active-claim", "before-native"]);
    expect(stages.filter(s => s.authorization).every(s => s.authorization!.predecessorRunId === owner.run.runId)).toBe(true);
    expect(f.purposes).toContain("before-native:submission");
    expect(owner.stopRequested).toBe(true); expect(owner.stopping).toBeDefined();
    expect(owner.run.status).toBe(status); expect((await f.previous.successfulSettlement()).ready).toBe(false);
    expect(f.errors).toHaveLength(0); expect(f.lifecycleErrors).toHaveLength(0);
  }
});
test("ordinary continuation cannot treat historical stop markers or failed status as live resume", async () => {
  const f = await stoppedFixture(); f.resume(); await f.flush();
  expect(f.launches).toHaveLength(1); expect(f.state.boundaries).toBe(1);
  expect(f.store.get(f.cid).items[0]?.state).toBe("waiting"); expect(f.coordinator.hasAdmission(f.cid)).toBe(false);
});
test("resume refuses revived unsettled/cancelling/owned or reconciliation-held work during preflight", async () => {
  for (const flag of ["settled", "cancelling", "owned", "reconciliation"] as const) {
    const f = await stoppedFixture(); f.state.userResume = true;
    f.state.preflightGate = deferred(); f.state.entered = deferred(); f.resume(); await f.state.entered.promise;
    if (flag === "settled" || flag === "cancelling") f.previous.owner[flag] = flag === "cancelling";
    else {
      const lease = f.coordinator.reserveAdmission({ conversationIds: [f.cid], intent: { kind: "user-prompt", requestId: id() } });
      expect(lease.ready).toBe(true); if (!lease.ready) throw new Error("fixture lease unavailable");
      f.previous.owner.settled = false;
      expect(f.coordinator.installOwner(lease.lease, f.previous.owner).ready).toBe(true);
      f.coordinator.releaseAdmission(lease.lease);
      if (flag === "reconciliation") {
        f.coordinator.beginReconciliation(f.previous.owner); f.previous.owner.settled = true;
        expect(f.coordinator.releaseOwner(f.previous.owner)).toBe(true);
      }
    }
    f.state.preflightGate.resolve(); await f.flush();
    expect(f.launches).toHaveLength(1); expect(f.state.boundaries).toBe(1);
    expect(f.store.get(f.cid).items[0]?.state).toBe("waiting"); expect(f.coordinator.hasAdmission(f.cid)).toBe(false);
  }
});
test("resume never clears an owned/done/cancelling/reconciliation-held unresolved claim", async () => {
  for (const held of ["owner", "cancel", "reconciliation"] as const) {
    const f = await fixture(); f.state.userResume = true;
    f.state.holdRelease = held === "owner";
    if (held === "reconciliation") f.state.reconciliation = deferred();
    f.enqueue(); f.enqueue(sibling(f.input)); await f.flush();
    if (held === "cancel") f.launches[0]!.lifecycle.owner.cancelling = true;
    f.launches[0]!.complete.resolve();
    if (held !== "reconciliation") await f.launches[0]!.lifecycle.done;
    await f.flush();
    expect(() => f.resume()).toThrow("unresolved"); f.scheduler.notifyResume(); await f.flush();
    expect(f.launches).toHaveLength(1); expect(f.stages.filter(s => s.stage === "claim")).toHaveLength(1);
    expect(f.store.reconciliationWork()).toHaveLength(1);
    if (held === "reconciliation") { f.state.reconciliation!.resolve(); await f.launches[0]!.lifecycle.done; }
  }
});
test("resume predecessor replacement during preflight or admission invalidates the original authority", async () => {
  for (const boundary of ["preflight", "admission"] as const) {
    const f = await stoppedFixture(); f.state.userResume = true;
    if (boundary === "preflight") { f.state.preflightGate = deferred(); f.state.entered = deferred(); }
    else { f.state.admissionGate = deferred(); f.state.admissionEntered = deferred(); }
    f.resume(); await (boundary === "preflight" ? f.state.entered : f.state.admissionEntered).promise;
    f.predecessors.delete(f.cid);
    (boundary === "preflight" ? f.state.preflightGate : f.state.admissionGate)!.resolve(); await f.flush();
    expect(f.launches).toHaveLength(1); expect(f.state.boundaries).toBe(1);
    expect(f.stages.filter(s => s.stage === "claim")).toHaveLength(boundary === "preflight" ? 1 : 2);
    if (boundary === "admission") {
      expect(f.store.get(f.cid).items[0]?.state).toBe("claimed"); expect(() => f.resume()).toThrow("unresolved");
    }
  }
});
for (const harness of ["claude-code", "opencode"] as const) for (const recovered of [false, true]) for (const replacement of ["stale-original", "same-identity-clone"] as const)
  test(`${harness}: ${recovered ? "recovered" : "live"} resume rejects ${replacement} handle after native proof validation`, async () => {
    const f = recovered ? await restartedWaitingFixture(harness) : await stoppedFixture(harness);
    f.state.userResume = true;
    const preflight = f.deps.preflight, validateLive = f.scheduler.validateLive.bind(f.scheduler);
    let refusal: unknown;
    f.scheduler.validateLive = input => {
      try { validateLive(input); }
      catch (error) { if (input.stage === "before-native") refusal = error; throw error; }
    };
    f.deps.preflight = async (...args) => {
      const result = await preflight(...args); if (result.kind !== "ready") return result;
      const validate = result.proof.validate;
      return { ...result, proof: { ...result.proof, validate: (input, purpose) => {
        validate(input, purpose);
        if (input.stage === "before-native") {
          const published = f.launches[1]!.lifecycle;
          expect(f.deps.predecessor(f.cid)).toBe(published);
          // Even the SAME owner and evidence cannot make a different handle live.
          f.predecessors.set(f.cid, replacement === "stale-original" ? f.previous : { ...published });
        }
      } } };
    };
    f.resume(); await f.flush();
    expect(f.state.boundaries).toBe(1); expect(f.launches).toHaveLength(2);
    expect(refusal).toBeInstanceOf(PendingInputDomainError);
    expect(refusal).toMatchObject({ code: "pending-input-stale" });
    const launch = f.launches[1]!;
    await launch.lifecycle.done; await f.flush();
    const item = f.store.lookup(f.cid, launch.context.intent.requestId!)!.item;
    expect(item.claim?.identity.runId).toBe(launch.lifecycle.owner.run.runId);
    expect(item.claim?.possibleNative).toBe(false);
    expect(item.claim?.evidence?.submission).toBe("not-submitted");
    expect(item.state).toBe("settled"); expect(item.history?.kind).toBe("not-submitted");
    f.scheduler.poll(); await f.flush();
    expect(f.state.boundaries).toBe(1); expect(f.launches).toHaveLength(2);
    expect(f.errors).toHaveLength(0);
    // This direct store fixture does not certify bridge-native refusals: its
    // lifecycle reports the same expected domain error, never an invariant.
    expect(f.lifecycleErrors.length).toBeGreaterThan(0);
    expect(f.lifecycleErrors.every(error => error === refusal)).toBe(true);
  });
test("resume live callback cannot replace/revive the predecessor or stop the installed owner after initial guards", async () => {
  for (const change of ["replacement", "revival", "installed-stop"] as const) {
    const f = await stoppedFixture(); f.state.userResume = true;
    const preflight = f.deps.preflight;
    f.deps.preflight = async (...args) => {
      const result = await preflight(...args); if (result.kind !== "ready") return result;
      const validate = result.proof.validate;
      return { ...result, proof: { ...result.proof, validate: (input, purpose) => {
        validate(input, purpose);
        if (input.stage === "claim" && change === "replacement") f.predecessors.delete(f.cid);
        if (input.stage === "claim" && change === "revival") f.previous.owner.settled = false;
        if (input.stage === "before-native" && change === "installed-stop") f.coordinator.getOwner(f.cid)!.stopRequested = true;
      } } };
    };
    f.resume(); await f.flush();
    expect(f.state.boundaries).toBe(1);
    if (change === "installed-stop") {
      expect(f.launches).toHaveLength(2); expect(f.launches[1]!.lifecycle.owner.stopRequested).toBe(true);
    } else {
      expect(f.launches).toHaveLength(1); expect(f.store.get(f.cid).items[0]?.state).toBe("waiting");
      expect(f.coordinator.hasAdmission(f.cid)).toBe(false);
    }
  }
});
test("resume discovery revalidates historical release and keeps current-owner stop checks strict", async () => {
  for (const change of ["predecessor-active", "predecessor-cancelling", "installed-stop", "installed-cancelling", "installed-stopping", "replacement"] as const) {
    const f = await stoppedFixture(); f.state.userResume = true; f.state.discovery = deferred(); f.resume(); await f.flush();
    const launch = f.launches[1]!, identity = launch.lifecycle.submissionEvidence();
    if (change === "predecessor-active") f.previous.owner.settled = false;
    else if (change === "predecessor-cancelling") f.previous.owner.cancelling = true;
    else if (change === "installed-stop") launch.lifecycle.owner.stopRequested = true;
    else if (change === "installed-cancelling") launch.lifecycle.owner.cancelling = true;
    else if (change === "installed-stopping") launch.lifecycle.owner.stopping = deferred<boolean>().promise;
    else f.predecessors.set(f.cid, f.previous);
    expect(() => launch.context.evidence!.beforeNative!({ ...identity, submission: "attempted", nativeAcceptance: "unknown" })).toThrow();
    f.state.discovery.resolve(); await launch.lifecycle.done; await f.flush();
    expect(f.state.boundaries).toBe(1); expect(f.launches).toHaveLength(2);
    expect(f.store.lookup(f.cid, launch.context.intent.requestId!)!.item.history).toBeNull();
  }
});
test("resume source/configuration proof revocation after preflight or discovery blocks claim/native", async () => {
  for (const drift of ["source-changed", "configuration-changed"] as const) for (const boundary of ["claim", "discovery"] as const) {
    const f = await stoppedFixture(); f.state.userResume = true;
    if (boundary === "claim") {
      const allocate = f.deps.allocate; f.deps.allocate = harness => { f.state.drift = drift; return allocate(harness); };
    } else f.state.discovery = deferred();
    f.resume(); await f.flush();
    if (boundary === "discovery") {
      f.state.drift = drift;
      const launch = f.launches[1]!, evidence = launch.lifecycle.submissionEvidence();
      expect(() => launch.context.evidence!.beforeNative!({ ...evidence, submission: "attempted", nativeAcceptance: "unknown" })).toThrow("live pins changed");
      expect(f.store.lookup(f.cid, launch.context.intent.requestId!)!.item.claim?.possibleNative).toBe(false);
      f.state.discovery!.resolve(); await launch.lifecycle.done; await f.flush();
      // A separate admission validation refusal is not certified non-submission.
      expect(f.store.lookup(f.cid, launch.context.intent.requestId!)!.item.claim?.evidence?.submission).toBe("unknown");
    }
    expect(f.state.boundaries).toBe(1); expect(f.store.inspect(f.cid).pause?.code).toBe(boundary === "claim" ? drift : "acceptance-unknown");
    if (boundary === "claim") { expect(f.launches).toHaveLength(1); expect(f.coordinator.hasAdmission(f.cid)).toBe(false); }
  }
});
test("preflight proof basis and authorization are pinned, never promoted through a mutable alias", async () => {
  for (const resume of [false, true]) {
    // A healthy predecessor is needed to pass the ordinary success gate. This
    // case uses a separate real completed/archived fixture, not a fake success.
    const g = resume ? await stoppedFixture() : await fixture(); g.state.userResume = resume;
    if (!resume) { g.enqueue(); g.enqueue(sibling(g.input)); await g.flush(); g.store.pause(g.cid, { code: "hidden", reason: "hold successor" }); await g.complete(); }
    g.state.admissionGate = deferred(); g.state.admissionEntered = deferred();
    let alias!: { -readonly [K in keyof PendingInputDispatchProof]: PendingInputDispatchProof[K] };
    const preflight = g.deps.preflight;
    g.deps.preflight = async (...args) => { const result = await preflight(...args); if (result.kind === "ready") alias = result.proof; return result; };
    g.resume(); await g.state.admissionEntered.promise;
    const previous = g.launches[0]!.lifecycle;
    alias.basis = resume ? "successful-predecessor" : "user-resume";
    alias.authorization = { ...alias.authorization, predecessorRunId: null };
    if (!resume) previous.owner.stopRequested = true;
    g.state.admissionGate.resolve(); await g.flush();
    expect(g.launches).toHaveLength(resume ? 2 : 1); expect(g.state.boundaries).toBe(resume ? 2 : 1);
    if (resume) expect(g.store.lookup(g.cid, g.launches[1]!.context.intent.requestId!)!.item.claim?.authorization.predecessorRunId).toBe(previous.owner.run.runId);
  }
});
test("bogus runtime proof basis and null predecessor cannot bypass exact archived chain authorization", async () => {
  for (const forgery of ["basis", "null-predecessor"] as const) {
    const f = await stoppedFixture(); f.state.userResume = true;
    const preflight = f.deps.preflight;
    f.deps.preflight = async (...args) => {
      const result = await preflight(...args); if (result.kind !== "ready") return result;
      if (forgery === "null-predecessor") return { ...result, proof: { ...result.proof, authorization: { ...result.proof.authorization, predecessorRunId: null } } };
      Reflect.set(result.proof, "basis", "serialized-resume"); return result;
    };
    f.resume(); await f.flush(); f.scheduler.poll(); await f.flush();
    expect(f.launches).toHaveLength(1); expect(f.state.boundaries).toBe(1);
    expect(f.store.get(f.cid).items[0]?.state).toBe("waiting"); expect(f.errors).toHaveLength(0);
  }
});

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
test("persistent source-changed settlement refusal keeps failed-run pause revision stable across polls", async () => {
  const f = await fixture(), waiter = sibling(f.input, "original waiting text");
  f.enqueue(); f.enqueue(waiter); await f.flush();
  const original = f.store.lookup(f.cid, f.input.request.requestId)!.item;
  const waiting = f.store.lookup(f.cid, waiter.request.requestId)!.item;
  const revision = f.store.get(f.cid).revision, settlement = f.deps.settlement;
  let observations = 0;
  f.deps.settlement = async () => {
    // The initial safety block must be durable BEFORE async proof refusal.
    if (observations++ === 0) expect(f.store.inspect(f.cid).pause?.code).toBe("failed");
    throw new PendingInputDomainError("source-changed", "Original source pins still differ");
  };
  await f.complete(0, "failed");
  const stableRevision = f.store.get(f.cid).revision;
  expect(stableRevision).toBe(revision + 2); // One safety block, one typed refusal.
  for (let n = 0; n < 3; n++) {
    const observed = observations;
    f.scheduler.poll(); await f.flush();
    expect(observations).toBe(observed + 1); // Paused does not skip independent proof.
    expect(f.store.get(f.cid).revision).toBe(stableRevision);
    expect(f.store.inspect(f.cid).pause).toEqual({ code: "source-changed", reason: "Original source pins still differ" });
    expect(f.store.lookup(f.cid, f.input.request.requestId)!.item).toEqual(original);
    expect(f.store.lookup(f.cid, waiter.request.requestId)!.item).toEqual(waiting);
  }
  expect(f.launches).toHaveLength(1); expect(f.state.boundaries).toBe(1);
  expect(f.stages.filter(s => s.stage === "claim")).toHaveLength(1);
  expect(f.errors).toHaveLength(0); expect(f.lifecycleErrors).toHaveLength(0);
  // Fresh exact-run proof can still archive while paused: a real durable write
  // demonstrates that expected domain refusals did not poison global storage.
  f.deps.settlement = settlement; f.scheduler.poll(); await f.flush();
  const archived = f.store.lookup(f.cid, f.input.request.requestId)!.item;
  expect(archived.history).toMatchObject({ kind: "settled", status: "failed", authorization: { predecessorRunId: original.claim!.identity.runId, source: original.claim!.identity.source } });
  expect(archived.claim?.identity).toEqual(original.claim!.identity);
  expect(f.store.lookup(f.cid, waiter.request.requestId)!.item).toEqual(waiting);
  expect(f.store.inspect(f.cid).pause?.code).toBe("source-changed");
  expect(f.launches).toHaveLength(1); expect(f.state.boundaries).toBe(1);
  expect(f.errors).toHaveLength(0); expect(f.lifecycleErrors).toHaveLength(0);
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
