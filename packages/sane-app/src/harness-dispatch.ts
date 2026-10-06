import type {
  AutomationDispatchOrigin, DispatchAdmission, DispatchOrigin, DispatchReadiness,
  DispatchSource, DispatchSupport, DispatchTerminalGuards, HarnessDispatchRequest, PinnedDispatchReadiness, DispatchEvidenceHooks, DispatchSubmissionEvidence,
} from "../shared/conversation/dispatch-contract";
import type { RunOwner } from "./run-owner";
import { createDispatchEvidence } from "./dispatch-evidence";

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
  /** Must synchronously schedule, not execute/replay a native prompt. */
  wake?: (owner: O) => void;
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
  let healthy = true, reconciled = false;
  const identity = Object.freeze({ source, runId: owner.run.runId, nativeCommandId: owner.run.nativeCommandId ?? null, ...(request.requestId !== undefined ? { requestId: request.requestId } : {}) });
  const identityFailure = new Error("Installed dispatch run identity changed; reconciliation required");
  const nativeAdmissionFailure = new Error("Dispatch native admission closed; reconciliation required");
  const failClosed = (error: unknown) => {
    if (!healthy && (error === identityFailure || error === nativeAdmissionFailure)) return;
    healthy = false; hooks.failClosed(error);
  };
  const assertIdentity = () => {
    if (owner.run.runId !== identity.runId || owner.run.sessionId !== source.sessionId || owner.run.cwd !== source.cwd
      || (owner.run.nativeCommandId ?? null) !== identity.nativeCommandId) { failClosed(identityFailure); throw identityFailure; }
  };
  // Restoring mutable run identity cannot reopen a failed-closed lifecycle.
  // Apply this latch only to effects, not later outcome observations.
  const assertNativeAdmission = () => {
    if (!healthy) throw nativeAdmissionFailure;
    assertIdentity();
  };
  const evidence = createDispatchEvidence(identity, hooks.evidence ?? {}, failClosed);
  owner.dispatchEvidence = {
    beforeNative: () => { assertNativeAdmission(); evidence.beforeNative(); assertNativeAdmission(); },
    outcome: (submission, acceptance) => { assertIdentity(); evidence.outcome(submission, acceptance); },
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
    return { ...hooks.guards(owner), settled: owner.settled, released: !hooks.owns(owner),
      status: owner.run.status, cancelling: !!owner.cancelling, stopRequested: !!owner.stopRequested, stopping: !!owner.stopping };
  };
  const successfulSettlement = async (): Promise<DispatchReadiness> => {
    if (!healthy) return denied("Dispatch admission or reconciled lifecycle success is not proven");
    try {
      assertIdentity();
      if (!reconciled || admitted !== true) return denied("Dispatch admission or reconciled lifecycle success is not proven");
      const gate = terminalDispatchReadiness(guards()); if (!gate.ready) return gate;
      let proof: DispatchReadiness;
      try { proof = await adapter.successfulSettlement(owner, source, guards); }
      finally { assertIdentity(); }
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
  // Defer invocation so even synchronous execute/ready callbacks cannot run
  // before installation and return of the fully observable lifecycle handle.
  void Promise.resolve().then(async () => {
    try { assertNativeAdmission(); await adapter.execute(owner, prompt, resume, ready); assertIdentity(); }
    catch (error) {
      failClosed(error);
      try { await hooks.terminate(owner); } catch (failure) { failClosed(failure); }
    } finally {
      ready(false);
      try { evidence.finish(); } catch (error) { failClosed(error); }
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
      try {
        if (hooks.wake) {
          const proof = await successfulSettlement();
          if (proof.ready && terminalDispatchReadiness(guards()).ready) hooks.wake(owner);
        }
      } catch (error) { failClosed(error); }
      finally { finished.resolve(); }
    }
  }).catch(error => { failClosed(error); admission.resolve({ state: "unconfirmed" }); finished.resolve(); });
  return { owner, admission: admission.promise, done: finished.promise, successfulSettlement, submissionEvidence: evidence.snapshot };
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
