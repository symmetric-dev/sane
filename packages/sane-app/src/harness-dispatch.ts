import type {
  AutomationDispatchOrigin, DispatchAdmission, DispatchOrigin, DispatchReadiness,
  DispatchSource, DispatchSupport, DispatchTerminalGuards, HarnessDispatchRequest, PinnedDispatchReadiness, DispatchEvidenceHooks, DispatchSubmissionEvidence,
} from "../shared/conversation/dispatch-contract";
import type { RunOwner } from "./run-owner";
import { createDispatchEvidence, synchronousDispatchHook } from "./dispatch-evidence";

/** Explicit read-only transport failure. Other exceptions remain invariant or
 * storage failures; source drift is a coded denial, not transport unavailability. */
export class DispatchProofUnavailableError extends Error {}

/** Registration selects behavior, never owner storage. The bridge continues to
 * own its one RunOwner registry and all admission/journal/domain mutations. */
export type HarnessDispatchAdapter<O extends RunOwner = RunOwner> = {
  readonly id: string;
  readonly automation: Readonly<Record<AutomationDispatchOrigin, DispatchSupport>>;
  readonly readiness: (source: DispatchSource, origin: DispatchOrigin) => Promise<PinnedDispatchReadiness>;
  readonly execute: (owner: O, prompt: string, resume: boolean, ready: (admitted: boolean) => void) => Promise<void>;
  readonly successfulSettlement: (owner: O, source: DispatchSource, guards: () => DispatchTerminalGuards) => Promise<DispatchReadiness>;
};

export class HarnessDispatchError extends Error {
  constructor(readonly code: "unknown-dispatch-harness" | "duplicate-dispatch-harness" | "unsupported-automation" | "dispatch-source-mismatch" | "invalid-dispatch-installation", message: string) { super(message); }
}

const denied = (reason: string, code = "dispatch-proof-unproven"): DispatchReadiness => ({ ready: false, reason, code });
const pin = (source: DispatchSource): DispatchSource => Object.freeze({ ...source });

export function sameDispatchSource(a: DispatchSource, b: DispatchSource): boolean {
  return a.harnessId === b.harnessId && a.sessionId === b.sessionId && a.authorityId === b.authorityId
    && a.nativeSessionId === b.nativeSessionId && a.cwd === b.cwd;
}

function assertSupport<O extends RunOwner>(adapter: HarnessDispatchAdapter<O>, request: Pick<HarnessDispatchRequest, "source" | "origin">) {
  if (request.source.harnessId !== adapter.id) throw new HarnessDispatchError("dispatch-source-mismatch", "Dispatch source differs from registered harness");
  if (request.origin !== "user" && adapter.automation?.[request.origin]?.supported !== true) {
    const support = adapter.automation?.[request.origin];
    throw new HarnessDispatchError("unsupported-automation", support?.supported === false ? support.reason : "Automatic dispatch support was not explicitly declared");
  }
}

export class HarnessDispatchRegistry<O extends RunOwner = RunOwner> {
  private readonly adapters = new Map<string, HarnessDispatchAdapter<O>>();

  register(adapter: HarnessDispatchAdapter<O>): void {
    if (!adapter.id) throw new HarnessDispatchError("unknown-dispatch-harness", "Dispatch harness ID must be explicit");
    if (this.adapters.has(adapter.id)) throw new HarnessDispatchError("duplicate-dispatch-harness", `Dispatch harness already registered: ${adapter.id}`);
    this.adapters.set(adapter.id, Object.freeze({ ...adapter, automation: Object.freeze({
      "queued-user": adapter.automation?.["queued-user"] && Object.freeze({ ...adapter.automation["queued-user"] }),
      "worker-report": adapter.automation?.["worker-report"] && Object.freeze({ ...adapter.automation["worker-report"] }),
      handoff: adapter.automation?.handoff && Object.freeze({ ...adapter.automation.handoff }),
    }) }) as HarnessDispatchAdapter<O>);
  }

  get(id: unknown): HarnessDispatchAdapter<O> | undefined { return typeof id === "string" ? this.adapters.get(id) : undefined; }
  require(id: unknown): HarnessDispatchAdapter<O> {
    const adapter = this.get(id);
    if (!adapter) throw new HarnessDispatchError("unknown-dispatch-harness", `Unknown dispatch harness: ${String(id)}`);
    return adapter;
  }
  assertSupport(source: DispatchSource, origin: DispatchOrigin): void { assertSupport(this.require(source.harnessId), { source, origin }); }

  async readiness(source: DispatchSource, origin: DispatchOrigin): Promise<DispatchReadiness> {
    const adapter = this.require(source.harnessId), expected = pin(source);
    assertSupport(adapter, { source: expected, origin });
    try {
      const result = await adapter.readiness(expected, origin);
      return sameDispatchSource(expected, result.source) ? result.readiness : denied("Conversation native source changed during readiness evaluation", "dispatch-source-mismatch");
    } catch (error) {
      if (error instanceof DispatchProofUnavailableError) return denied(error.message, "dispatch-proof-unavailable");
      if (error instanceof HarnessDispatchError && error.code === "dispatch-source-mismatch") return denied(error.message, error.code);
      throw error;
    }
  }

  start(request: HarnessDispatchRequest, hooks: DispatchLifecycleHooks<O>): DispatchLifecycle<O> {
    return startDispatchLifecycle(this.require(request.source.harnessId), request, hooks);
  }
}

export function terminalDispatchReadiness(state: DispatchTerminalGuards): DispatchReadiness {
  if (!state.settled || !state.released) return denied("Dispatch lifecycle or ownership has not settled", "dispatch-unsettled");
  if (state.cancelling || state.stopRequested || state.stopping) return denied("Dispatch was stopped or cancellation is in progress", "dispatch-stopped");
  if (state.closing || state.storageFailed || state.reconciliationRequired) return denied("Bridge shutdown, storage failure or reconciliation prevents automatic dispatch", "dispatch-unavailable");
  return state.status === "completed" ? { ready: true } : denied("Dispatch did not complete successfully", "dispatch-unsuccessful");
}

export type DispatchLifecycleHooks<O extends RunOwner = RunOwner> = {
  evidence?: DispatchEvidenceHooks;
  /** Final live validation/claim, owner acquisition, session/run/event publication
   * in ONE synchronous callback. No awaits or native execution here. On failure
   * failClosed retains any partially installed owner; there is no rollback. */
  install: (done: Promise<void>) => O;
  owns: (owner: O) => boolean;
  settle: (owner: O) => void;
  release: (owner: O) => void;
  failClosed: (error: unknown) => void;
  terminate: (owner: O) => Promise<unknown>;
  /** Handoff: before-release. Worker report: after-release. begin MUST acquire an
   * admission/readiness barrier synchronously while ownership is still held.
   * Its identity-bound end is called only after healthy source reconciliation
   * AND settlement/release processing; errors retain it until App recovery. */
  reconciliation?: {
    readonly order: "before-release" | "after-release";
    readonly begin: (owner: O) => { readonly end: () => void };
    readonly run: (owner: O) => Promise<void>;
  };
  guards: (owner: O) => DispatchTerminalGuards;
  /** Read-only CURRENT configuration and arbitration, not imported history or
   * this owner's absence alone. Missing capability cannot certify release. */
  releasedGuards?: (owner: O) => DispatchReleasedGuards;
  /** Must synchronously schedule, not execute/replay a native prompt. */
  wake?: (owner: O) => void;
};
export type DispatchReleasedGuards = {
  readonly source: DispatchSource;
  /** Opaque stable snapshot of the installed session configuration. */
  readonly installation: string;
  readonly ownerPresent: boolean;
  readonly admissionPending: boolean;
  readonly reconciliationPending: boolean;
  readonly capacityAvailable: boolean;
};
export type DispatchLifecycle<O extends RunOwner = RunOwner> = {
  readonly owner: O;
  readonly admission: Promise<DispatchAdmission>;
  /** Execution processing and source reconciliation have finished (or failed
   * closed), NOT proof of ownership release. In-flight cancellation can retain
   * the owner beyond done. Continuation needs fresh ownership/readiness checks
   * and successfulSettlement; never await retained ownership indefinitely. */
  readonly done: Promise<void>;
  /** Fresh proof independent of optional wake. Denied until source-specific
   * reconciliation and release finish; never submits or replays a prompt. */
  readonly successfulSettlement: () => Promise<DispatchReadiness>;
  /** Healthy original lifecycle RELEASE only; failed, interrupted or definitely
   * withheld turns may qualify. Never task success or native idle. An optional
   * read-only proof is surrounded by fresh source/config/arbitration checks. */
  readonly releasedSettlement: (proof?: () => Promise<DispatchReadiness>) => Promise<DispatchReadiness>;
  readonly submissionEvidence: () => DispatchSubmissionEvidence;
};

export function startDispatchLifecycle<O extends RunOwner>(adapter: HarnessDispatchAdapter<O>, request: HarnessDispatchRequest, hooks: DispatchLifecycleHooks<O>): DispatchLifecycle<O> {
  const source = pin(request.source), { origin, prompt, resume } = request;
  assertSupport(adapter, { source, origin });
  const finished = Promise.withResolvers<void>(), admission = Promise.withResolvers<DispatchAdmission>();
  let owner: O;
  try {
    owner = hooks.install(finished.promise);
    if (!owner || owner.done !== finished.promise || owner.settled || !owner.run.runId || owner.run.sessionId !== source.sessionId || owner.run.cwd !== source.cwd
      || source.harnessId === "opencode" && !owner.run.nativeCommandId
      || source.harnessId === "claude-code" && owner.run.nativeCommandId != null || !hooks.owns(owner)) {
      throw new HarnessDispatchError("invalid-dispatch-installation", "Complete run and owner lifecycle must be synchronously installed before execution");
    }
  } catch (error) { hooks.failClosed(error); finished.resolve(); throw error; }
  let healthy = true, reconciled = false, processingFinished = false;
  const installedRun = owner.run, installedDone = owner.done, installedBeforeSend = owner.beforeSend;
  const coreConfiguration = () => JSON.stringify([owner.run.createdAt, owner.run.operation, owner.run.nativeDelivery,
    owner.run.queuedFollowupId, owner.workerDeliveryId, owner.native, owner.nativeDeliveryPolicy, owner.nativeQueuedHandoff]);
  const configuration = () => JSON.stringify([owner.run.profileId, owner.run.model, owner.run.effort,
    owner.run.agent, owner.run.agentKind, owner.run.nativeAgentSelected, owner.run.saneContextVersion]);
  const installedCoreConfiguration = coreConfiguration(), installedConfiguration = configuration(), releasedGuards = hooks.releasedGuards;
  // Only an installed queued claim with its original validation and durable
  // evidence hooks may defer launch drift to that guard. Legacy/generic guards
  // remain strict. Neither origin nor the default evidence snapshot is proof.
  const queuedBoundary = origin === "queued-user" && !!request.requestId && !!installedBeforeSend
    && !!hooks.evidence?.beforeNative && !!hooks.evidence?.outcome;
  let withheldConfiguration: string | undefined;
  const currentReleasedGuards = () => {
    let current!: DispatchReleasedGuards;
    synchronousDispatchHook(() => current = releasedGuards!(owner));
    return current;
  };
  let installedRelease: Readonly<{ source: DispatchSource; installation: string }> | undefined;
  try {
    if (releasedGuards) {
      const current = currentReleasedGuards();
      if (!sameDispatchSource(source, current.source) || typeof current.installation !== "string") throw new HarnessDispatchError("invalid-dispatch-installation", "Release configuration must match the installed dispatch source");
      installedRelease = Object.freeze({ source: pin(current.source), installation: current.installation });
    }
  } catch (error) { hooks.failClosed(error); finished.resolve(); throw error; }
  const identity = Object.freeze({ source, runId: owner.run.runId, nativeCommandId: owner.run.nativeCommandId ?? null, ...(request.requestId !== undefined ? { requestId: request.requestId } : {}) });
  const identityFailure = new Error("Installed dispatch run identity changed; reconciliation required");
  const nativeAdmissionFailure = new Error("Dispatch native admission closed; reconciliation required");
  const failClosed = (error: unknown) => {
    if (!healthy && (error === identityFailure || error === nativeAdmissionFailure)) return;
    healthy = false; hooks.failClosed(error);
  };
  const assertIdentity = () => {
    if (owner.run !== installedRun || owner.done !== installedDone || owner.beforeSend !== installedBeforeSend || coreConfiguration() !== installedCoreConfiguration
      || owner.run.runId !== identity.runId || owner.run.sessionId !== source.sessionId || owner.run.cwd !== source.cwd
      || (owner.run.nativeCommandId ?? null) !== identity.nativeCommandId) { failClosed(identityFailure); throw identityFailure; }
  };
  const assertConfiguration = (allowObservedWithholding = false) => {
    const current = configuration();
    const expected = allowObservedWithholding && queuedBoundary && withheldConfiguration !== undefined ? withheldConfiguration : installedConfiguration;
    if (current !== expected) {
      failClosed(identityFailure); throw identityFailure;
    }
  };
  // Restoring mutable run identity cannot reopen a failed-closed lifecycle.
  // Apply this latch only to effects, not later outcome observations.
  const assertNativeAdmission = (allowQueuedGuard = false) => {
    if (!healthy) throw nativeAdmissionFailure;
    assertIdentity();
    if (!(allowQueuedGuard && queuedBoundary && evidence.boundaryState().phase !== "possible-native")) assertConfiguration();
  };
  const evidence = createDispatchEvidence(identity, hooks.evidence ?? {}, failClosed);
  const settlementConfigurationGate = (): DispatchReadiness | undefined => {
    assertIdentity();
    // A read cannot preempt the original queued guard's durable pause, or turn
    // the initial evidence snapshot into proof. Refresh this boundary each time.
    if (healthy && queuedBoundary && !processingFinished && withheldConfiguration === undefined
      && evidence.boundaryState().phase !== "possible-native" && configuration() !== installedConfiguration) {
      const submission = evidence.snapshot();
      if (submission.submission === "not-submitted" && submission.nativeAcceptance === "not-accepted") {
        return denied("Original queued launch validation has not finished", "dispatch-unsettled");
      }
    }
    assertConfiguration(true);
  };
  owner.dispatchEvidence = {
    beforeNative: () => { assertNativeAdmission(true); evidence.beforeNative(); assertNativeAdmission(); },
    // Current launch pins cannot suppress original accepted/unknown observations.
    // They still close terminal proof after those observations are journaled.
    outcome: (submission, acceptance) => { assertIdentity(); if (!queuedBoundary) assertConfiguration(); evidence.outcome(submission, acceptance); assertIdentity(); },
    withheld: evidence.withheld,
  };
  let admitted: boolean | undefined;
  const ready = (value: boolean) => {
    if (admitted !== undefined) return;
    admitted = value;
    admission.resolve(value ? { state: "admitted" } : { state: "unconfirmed" });
  };
  // Identity belongs to this installed run, not whichever owner now occupies the
  // conversation. Status/cancellation and this owner's release remain live.
  const guards = (): DispatchTerminalGuards => {
    assertIdentity();
    assertConfiguration(true);
    return { ...hooks.guards(owner), settled: owner.settled, released: !hooks.owns(owner),
      status: owner.run.status, cancelling: !!owner.cancelling, stopRequested: !!owner.stopRequested, stopping: !!owner.stopping };
  };
  const successfulSettlement = async (): Promise<DispatchReadiness> => {
    if (!healthy) return denied("Dispatch admission or reconciled lifecycle success is not proven");
    try {
      const configurationGate = settlementConfigurationGate(); if (configurationGate) return configurationGate;
      if (evidence.refused() || evidence.boundaryState().withholdingObserved) return denied("Dispatch was withheld before native submission", "dispatch-native-withheld");
      if (!reconciled || admitted !== true) return denied("Dispatch admission or reconciled lifecycle success is not proven");
      const gate = terminalDispatchReadiness(guards()); if (!gate.ready) return gate;
      let proof: DispatchReadiness;
      try { proof = await adapter.successfulSettlement(owner, source, guards); }
      finally { assertIdentity(); assertConfiguration(); }
      // Native I/O can overlap cancellation/shutdown. Recheck live.
      if (!healthy) return denied("Dispatch settlement invariant failed; reconciliation required", "reconciliation-required");
      const current = terminalDispatchReadiness(guards());
      return current.ready ? proof : current;
    } catch (error) {
      if (error instanceof DispatchProofUnavailableError) return denied(error.message, "dispatch-proof-unavailable");
      if (error instanceof HarnessDispatchError && error.code === "dispatch-source-mismatch") return denied(error.message, error.code);
      failClosed(error);
      return denied("Dispatch settlement invariant failed; reconciliation required", "reconciliation-required");
    }
  };
  const releasedGate = (): DispatchReadiness => {
    const configurationGate = settlementConfigurationGate(); if (configurationGate) return configurationGate;
    if (!healthy) return denied("Dispatch lifecycle invariant failed; reconciliation required", "reconciliation-required");
    if (!installedRelease || !releasedGuards) return denied("Current release configuration and arbitration capability unavailable");
    const current = currentReleasedGuards();
    if (!sameDispatchSource(installedRelease.source, current.source) || current.installation !== installedRelease.installation) return denied("Conversation source or installation changed since dispatch", "dispatch-source-mismatch");
    if (!processingFinished || !reconciled) return denied("Dispatch processing or reconciliation has not finished", "dispatch-unsettled");
    const state = guards();
    if (!state.settled || !state.released || current.ownerPresent) return denied("Conversation ownership has not been released", "dispatch-unsettled");
    if (state.closing || state.storageFailed || state.reconciliationRequired) return denied("Bridge health prevents release proof", "dispatch-unavailable");
    if (state.cancelling || current.admissionPending || current.reconciliationPending || !current.capacityAvailable) return denied("Conversation admission or reconciliation is not available", "dispatch-unavailable");
    const submission = evidence.snapshot();
    const boundary = evidence.boundaryState();
    const withheld = (queuedBoundary ? boundary.withholdingObserved : boundary.phase === "withheld")
      && submission.submission === "not-submitted" && submission.nativeAcceptance === "not-accepted";
    if (withheldConfiguration !== undefined && withheldConfiguration !== installedConfiguration && state.status === "completed") return denied("Changed launch settings cannot prove completed processing", "dispatch-unsuccessful");
    if (!withheld && (admitted !== true || submission.submission !== "submitted")) return denied("Dispatch admission or submission remains unknown");
    if (!withheld && state.status !== "completed" && state.status !== "failed" && state.status !== "interrupted") return denied("Dispatch terminal processing remains unknown", "dispatch-unsettled");
    return { ready: true };
  };
  const releaseInvariantDenial = () => denied("Dispatch release invariant failed; reconciliation required", "reconciliation-required");
  const releaseProofDenial = (error: unknown): DispatchReadiness | undefined => {
    if (error instanceof DispatchProofUnavailableError) return denied(error.message, "dispatch-proof-unavailable");
    if (error instanceof HarnessDispatchError && error.code === "dispatch-source-mismatch") return denied(error.message, error.code);
  };
  const checkedReleasedGate = (): DispatchReadiness => {
    try {
      let gate: DispatchReadiness, configurationGate: DispatchReadiness | undefined;
      try { gate = releasedGate(); }
      finally { configurationGate = settlementConfigurationGate(); }
      return configurationGate ?? gate;
    } catch (error) {
      const denial = releaseProofDenial(error); if (denial) return denial;
      failClosed(error);
      return releaseInvariantDenial();
    }
  };
  const releasedSettlement = async (proof?: () => Promise<DispatchReadiness>): Promise<DispatchReadiness> => {
    if (!healthy) return releaseInvariantDenial();
    const gate = checkedReleasedGate(); if (!gate.ready) return gate;
    let observed: DispatchReadiness = { ready: true }, failed = false, failure: unknown;
    try { if (proof) observed = await proof(); }
    catch (error) { failed = true; failure = error; }
    // Refresh even after unavailable proof, never retry a failed guard or use
    // the cached first gate. Identity and unknown hook failures remain fatal.
    const current = checkedReleasedGate();
    if (failed) {
      const denial = releaseProofDenial(failure);
      if (!denial) {
        if (healthy) failClosed(failure);
        return releaseInvariantDenial();
      }
      return current.ready ? denial : current;
    }
    return current.ready ? observed : current;
  };
  // Defer invocation so even synchronous execute/ready callbacks cannot run
  // before installation and return of the fully observable lifecycle handle.
  void Promise.resolve().then(async () => {
    try { assertNativeAdmission(true); await adapter.execute(owner, prompt, resume, ready); assertIdentity(); }
    catch (error) {
      if (healthy && evidence.recognizesRefusal(error)) {
        // Only this evidence object's certified synchronous refusal is local.
        // Revalidate the original owner even when execute propagated it directly.
        try { assertIdentity(); } catch (failure) { failClosed(failure); }
      } else {
        failClosed(error);
        try { await hooks.terminate(owner); } catch (failure) { failClosed(failure); }
      }
    } finally {
      ready(false);
      try {
        assertIdentity(); evidence.finish(); assertIdentity();
        // Capture only after the original durable outcome/pause hooks returned.
        // Later launch tampering cannot borrow this historical withholding proof.
        if (healthy && queuedBoundary && evidence.boundaryState().withholdingObserved) withheldConfiguration = configuration();
        assertConfiguration(true);
      } catch (error) { failClosed(error); }
      let barrier: { readonly end: () => void } | undefined;
      let barrierReady = !hooks.reconciliation, sourceReconciled = !hooks.reconciliation;
      if (hooks.reconciliation) {
        try {
          barrier = hooks.reconciliation.begin(owner);
          if (!barrier || typeof barrier.end !== "function") throw new Error("Source reconciliation did not acquire a completion barrier");
          barrierReady = true;
        } catch (error) { failClosed(error); }
      }
      const reconcile = async () => {
        if (!barrierReady) return;
        try { await hooks.reconciliation?.run(owner); sourceReconciled = true; }
        catch (error) { failClosed(error); }
      };
      if (hooks.reconciliation?.order === "before-release") await reconcile();
      try { hooks.settle(owner); if (barrierReady) hooks.release(owner); } catch (error) { failClosed(error); }
      if (hooks.reconciliation?.order === "after-release") await reconcile();
      if (healthy && sourceReconciled) {
        try { barrier?.end(); reconciled = true; }
        catch (error) { failClosed(error); }
      }
      processingFinished = true;
      try {
        if (hooks.wake) {
          const proof = await successfulSettlement();
          if (proof.ready && terminalDispatchReadiness(guards()).ready) hooks.wake(owner);
        }
      } catch (error) { failClosed(error); }
      finally { finished.resolve(); }
    }
  }).catch(error => { failClosed(error); admission.resolve({ state: "unconfirmed" }); finished.resolve(); });
  return { owner, admission: admission.promise, done: finished.promise, successfulSettlement, releasedSettlement, submissionEvidence: evidence.snapshot };
}

type AdapterCallbacks<O extends RunOwner> = Pick<HarnessDispatchAdapter<O>, "automation" | "readiness" | "execute">;
export type ClaudeSettlementEvidence = { readonly childPresent: boolean; readonly exitCode: number | null; readonly groupAlive: boolean; readonly streamsDrained: boolean };

/** Stream drain proof must come from the completed service lifecycle, not a Stop
 * hook/result record or child exit alone. Unknown drain/group evidence blocks. */
export function createClaudeDispatchAdapter<O extends RunOwner = RunOwner>(callbacks: AdapterCallbacks<O> & {
  settlementEvidence: (owner: O, source: DispatchSource) => ClaudeSettlementEvidence;
}): HarnessDispatchAdapter<O> {
  return { id: "claude-code", automation: callbacks.automation, readiness: callbacks.readiness, execute: callbacks.execute,
    successfulSettlement: async (owner, source, guards) => {
      const gate = terminalDispatchReadiness(guards()); if (!gate.ready) return gate;
      const evidence = callbacks.settlementEvidence(owner, source);
      if (!evidence.childPresent || evidence.exitCode !== 0 || evidence.groupAlive !== false || evidence.streamsDrained !== true) return denied("Claude process exit, process-group exit and stream drain success are not all proven");
      return terminalDispatchReadiness(guards());
    },
  };
}

export type OpenCodeSettlementEvidence = { readonly commandId: string; readonly outcome: "succeeded" | "failed" | "interrupted" | "unknown" };

export function createOpenCodeDispatchAdapter<O extends RunOwner = RunOwner>(callbacks: AdapterCallbacks<O> & {
  /** Observe only this command; idle/latest-message evidence is not success. */
  exactCommand: (owner: O, source: DispatchSource, commandId: string) => Promise<OpenCodeSettlementEvidence>;
  /** Live source-pinned readiness includes ALL native activity/pending inputs. */
  nativeReadiness: (source: DispatchSource) => Promise<PinnedDispatchReadiness>;
}): HarnessDispatchAdapter<O> {
  return { id: "opencode", automation: callbacks.automation, readiness: callbacks.readiness, execute: callbacks.execute,
    successfulSettlement: async (owner, source, guards) => {
      let gate = terminalDispatchReadiness(guards()); if (!gate.ready) return gate;
      const commandId = owner.run.nativeCommandId;
      if (!commandId || !source.nativeSessionId || !source.authorityId) return denied("OpenCode exact command and native source identity are required");
      const evidence = await callbacks.exactCommand(owner, source, commandId);
      gate = terminalDispatchReadiness(guards()); if (!gate.ready) return gate;
      if (owner.run.nativeCommandId !== commandId || evidence.commandId !== commandId || evidence.outcome !== "succeeded") return denied("OpenCode exact command success is not proven");
      const native = await callbacks.nativeReadiness(source);
      gate = terminalDispatchReadiness(guards()); if (!gate.ready) return gate;
      if (owner.run.nativeCommandId !== commandId) return denied("OpenCode command identity changed during settlement");
      if (!sameDispatchSource(source, native.source)) return denied("OpenCode native source changed during settlement", "dispatch-source-mismatch");
      return native.readiness;
    },
  };
}
