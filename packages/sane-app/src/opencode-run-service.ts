import type { Event, Run, Session, Status } from "./history";
import { OpenCodeCommandProtocolError, OpenCodeError, OpenCodeSourceMismatchError, OpenCodeQueuedHandoffProtocolError, OpenCodeUnavailableError, isQueuedHandoffAdmission, normalizeMessage, prepareOpenCodePrompt, type NativeCommandObservation, type NativeCommandSnapshot, type OpenCodeAdapter, type OpenCodePreparedPrompt, type OpenCodePromptPacket } from "./opencode";
import type { RunOwner } from "./run-owner";
import type { ExecutionContext } from "./workstreams";
import { snapshotIdentity } from "./agent-launch";
import { nativeAgentId } from "sane-core/agent-catalog";
import type { DispatchIdentity } from "../shared/conversation/dispatch-contract";
import { verifyOpenCodeCompletion, type OperatorCompletionEvidence } from "./opencode-completion-recovery";
import { openCodeExecutionConfiguration } from "./canonical-agent-operations";
import type { CanonicalExecutionProvider } from "./canonical-execution-store";
import type { WorkerProtocolPin } from "./worker-contract";
import { synchronousDispatchHook } from "./dispatch-evidence";
import { coordinateRunSubmission, type RunSubmissionPreparationSteps } from "./run-submission-preparation";
import { createRunSubmissionTiming, type RunSubmissionTimingSnapshot } from "./run-submission-timing";
import type { ActualContextSubmission } from "./context-message-transport";

/** Private App recovery capability; no Run synthesis or submission hooks. */
export type OpenCodeRecoveryObservation = Readonly<{
  identity: DispatchIdentity;
  validate: () => void;
  accepted: () => boolean;
  outcome: () => void;
  protocolUnsafe: () => boolean;
  protocolMismatch: (reason: string) => Promise<void>;
  beforeNative: () => never;
  execute: () => never;
}>;

/** Native transport only; owner arbitration and durable writes remain in the bridge. */
export type OpenCodeRunAdapter = Pick<OpenCodeAdapter, "assertIdle" | "select" | "prompt" | "snapshot" | "interactions" | "compact" | "compactionSnapshot" | "activity" | "cancel"> & Partial<Pick<OpenCodeAdapter, "history" | "observeCommand" | "promptQueuedHandoff" | "preparePromptSubmission" | "preflightNativeSession" | "configureCanonicalExecution" | "cancelInput">>;
export type OpenCodeRunDependencies = {
  oc: OpenCodeRunAdapter;
  closing: () => boolean;
  storageFailed: () => boolean;
  /** Existing bridge storage/reconciliation latch; never a second owner registry. */
  failClosed: (error: unknown) => void;
  currentOwner: (sessionId: string) => RunOwner | undefined;
  session: (sessionId: string) => Session;
  events: (runId: string) => readonly Event[];
  emit: (run: Run, kind: Event["kind"], data: unknown) => Promise<void>;
  persist: () => Promise<void>;
  execution: (sessionId: string) => Promise<string>;
  /** Workstream membership and roots recorded in launch evidence. */
  executionContext: (sessionId: string) => Promise<ExecutionContext>;
  compactExecution: (session: Session) => Promise<string>;
  refreshCompactHistory: (owner: RunOwner) => Promise<void>;
  assertWorkerDeliverySubmission: (owner: RunOwner) => void;
  workerHasRun: (runId: string) => boolean;
  /** Operator verification requires literal inbox emptiness, including startup synthetics. */
  completionInboxEmpty?: (nativeSessionId: string) => Promise<boolean>;
  canonicalExecution?: CanonicalExecutionProvider;
  /** Recorded worker pin only. Absent must not upgrade an unpinned resume. */
  explicitProtocol?: (sessionId: string) => WorkerProtocolPin | undefined;
  sleep: (ms: number) => Promise<unknown>;
};

export type VerifyCompletionRequest = { requestId: string; nativeSessionId: string; nativeCommandId: string; confirm: true; reason: string };
export type CompletionReconciliationEvidence = VerifyCompletionRequest & {
  type: "completion-reconciliation"; proofKind: "operator-verified"; sessionId: string; runId: string;
  authorityId: string | null; cwd: string; native: OperatorCompletionEvidence;
};
const compactCommand = (text: string) => /^\s*\/compact(?:\s|$)/i.test(text);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
const configuration = (value: Session) => JSON.stringify([value.sessionId, value.harness, value.authorityId, value.nativeSessionId, value.cwd,
  value.profileId, value.model, value.effort, value.agent, value.agentKind, value.nativeAgentSelected, value.saneContext, value.saneExecution, value.attachment]);
const runConfiguration = (run: Run) => JSON.stringify([run.model, run.effort, run.profileId, run.agent, run.agentKind, run.nativeAgentSelected, run.operation, run.saneContextVersion, run.saneExecution]);
type HandoffPins = Readonly<{ run: Run; runId: string; sessionId: string; commandId: string; nativeSessionId: string; cwd: string; claim: string; configuration: string; runConfiguration: string }>;
export type OpenCodePendingCancellation = Readonly<{ ready: false }> | Readonly<{
  ready: true;
  kind: "pending-removed";
  evidence: Readonly<DispatchIdentity & { requestId: string; nativeCommandId: string; pendingCreatedAt: number; canceledAt: number }>;
}>;

/** OpenCode command lifecycle. Reads live bridge state after awaited work; never
 * owns a second registry, replays a mutation, or cancels native work on detach. */
export class OpenCodeRunService {
  // Observation pins only, not an admission/token or ownership registry. The
  // bridge's real claim gate and durable dispatch evidence remain mandatory.
  private readonly handoffPins = new WeakMap<RunOwner, HandoffPins>();
  private readonly completionChecks = new Set<string>();
  private readonly executionAgents = new WeakMap<RunOwner, string>();
  /** Diagnostics only: one bounded snapshot per owner, never an evidence write. */
  private readonly submissionTimings = new WeakMap<RunOwner, Readonly<{ initial?: RunSubmissionTimingSnapshot }>>();
  constructor(private readonly deps: OpenCodeRunDependencies) {}
  readSubmissionTiming(owner: RunOwner): Readonly<{ initial?: RunSubmissionTimingSnapshot }> | undefined {
    return this.submissionTimings.get(owner);
  }
  private retainSubmissionTiming(owner: RunOwner, timing: ReturnType<typeof createRunSubmissionTiming>): void {
    try { this.submissionTimings.set(owner, Object.freeze({ initial: timing.snapshot() })); }
    catch { /* Optional diagnostics cannot gate response, observation or settlement. */ }
  }
  private async configureExecution(owner: RunOwner, guard: () => void, steps?: RunSubmissionPreparationSteps) {
    const run = owner.run, session = this.deps.session(run.sessionId);
    const step = <T>(work: () => Promise<T>) => steps ? steps.step("execution.configure", work) : work();
    guard();
    const snapshot = await step(async () => this.deps.canonicalExecution?.(run.sessionId));
    guard();
    if (!snapshot) return;
    if (!this.deps.oc.configureCanonicalExecution) throw new Error("Canonical execution integration is unavailable");
    if (snapshot.policy.spec.name !== `sane/${session.agentKind}/${session.agent}`) throw new Error("Canonical execution role mismatch");
    const configuration = openCodeExecutionConfiguration({ policy: snapshot.policy, children: snapshot.children, sessionID: session.nativeSessionId!, directory: session.cwd, model: run.model, effort: run.effort, protocol: this.deps.explicitProtocol?.(run.sessionId) });
    await step(() => this.deps.emit(run, "context", { type: "canonical-execution", stage: "prepared", revision: snapshot.revision, configuration }));
    guard();
    const readOnly = run.nativeDelivery === "queue";
    await step(() => this.deps.oc.configureCanonicalExecution!(configuration, guard, readOnly));
    this.executionAgents.set(owner, configuration.agent);
    await step(() => this.deps.emit(run, "context", { type: "canonical-execution", stage: readOnly ? "verified" : "configured", revision: snapshot.revision, sessionId: session.sessionId, nativeSessionId: session.nativeSessionId }));
    guard();
  }
  /** Explicit operator repair only. This evidence never certifies automatic continuation. */
  async verifyCompletion(run: Run, request: VerifyCompletionRequest, assertScope: () => void = () => {}): Promise<{ status: Status; evidence: CompletionReconciliationEvidence }> {
    if (!record(request) || request.confirm !== true || typeof request.requestId !== "string"
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(request.requestId)
      || typeof request.reason !== "string" || !request.reason.trim() || request.reason.length > 4000
      || typeof request.nativeSessionId !== "string" || typeof request.nativeCommandId !== "string") throw new OpenCodeError("Explicit confirmation, UUID requestId, pinned native IDs and reason are required", 400);
    if (this.completionChecks.has(run.runId)) throw new OpenCodeError("Completion verification is already in progress", 409);
    this.completionChecks.add(run.runId);
    try {
      const session = this.deps.session(run.sessionId), owner = this.deps.currentOwner(run.sessionId);
      const source = configuration(session), runSource = runConfiguration(run), cwd = run.cwd, commandId = run.nativeCommandId, runId = run.runId, sessionId = run.sessionId;
      const validate = (live = true) => {
        assertScope();
        if (this.deps.closing() || this.deps.storageFailed()) throw new OpenCodeError("Completion verification storage unavailable", 503);
        if (run.runId !== runId || run.sessionId !== sessionId || this.deps.session(run.sessionId) !== session || configuration(session) !== source || runConfiguration(run) !== runSource
          || run.cwd !== cwd || run.nativeCommandId !== commandId || session.harness !== "opencode" || session.cwd !== cwd
          || session.nativeSessionId !== request.nativeSessionId || commandId !== request.nativeCommandId
          || run.operation === "compact" || session.agentKind === "worker" || run.agentKind === "worker"
          || this.deps.workerHasRun(run.runId) || run.nativeDelivery === "queue") throw new OpenCodeError("Completion verification source or run is ineligible", 409);
        if (live && (!owner || this.deps.currentOwner(run.sessionId) !== owner || owner.run !== run || !owner.native || owner.settled
          || owner.cancelling || owner.stopping || owner.workerDeliveryId || owner.nativeQueuedHandoff || owner.nativeDeliveryPolicy === "native-queued-handoff"
          || run.status !== "running" || session.lastRunId !== run.runId)) throw new OpenCodeError("Completion verification requires the original live prompt owner", 409);
      };
      validate(false);
      const audits = this.deps.events(run.runId).filter(event => event.kind === "context" && record(event.data) && event.data.type === "completion-reconciliation");
      const prior = audits.at(-1)?.data as CompletionReconciliationEvidence | undefined;
      if (prior && (prior.requestId !== request.requestId || prior.reason !== request.reason || prior.nativeSessionId !== request.nativeSessionId
        || prior.nativeCommandId !== request.nativeCommandId || prior.authorityId !== (session.authorityId ?? null) || prior.cwd !== cwd
        || prior.sessionId !== run.sessionId || prior.runId !== run.runId || prior.proofKind !== "operator-verified")) throw new OpenCodeError("Conflicting completion reconciliation request", 409);
      if (run.status !== "running") {
        if (!prior) throw new OpenCodeError("Terminal run has no matching operator reconciliation", 409);
        if (run.status !== (prior.native.outcome === "succeeded" ? "completed" : prior.native.outcome)) throw new OpenCodeError("Terminal status conflicts with the audited reconciliation", 409);
        if (owner?.run === run) {
          await owner.completionTerminalization?.done;
          await owner.done;
          validate(false);
          if (this.deps.currentOwner(run.sessionId) === owner) throw new OpenCodeError("Completion ownership release remains unconfirmed", 409);
        }
        return { status: run.status, evidence: prior };
      }
      validate();
      if (!this.deps.events(run.runId).some(event => event.kind === "status" && record(event.data) && event.data.completionBoundary)) throw new OpenCodeError("Run has no unresolved completion boundary", 409);
      const history = this.deps.oc.history;
      if (!history || !this.deps.completionInboxEmpty) throw new OpenCodeError("Full native history or raw inbox verification unavailable", 503);
      const native = await verifyOpenCodeCompletion({
        activity: async (id, directory) => {
          validate(); const empty = await this.deps.completionInboxEmpty!(id); validate();
          if (!empty) throw new OpenCodeError("Native inbox is not empty", 409);
          const result = await this.deps.oc.activity(id, directory); validate(); return result;
        },
        history: async (id, directory) => { validate(); const result = await history.call(this.deps.oc, id, directory); validate(); return result; },
      }, { nativeSessionId: request.nativeSessionId, commandId: request.nativeCommandId, cwd });
      validate();
      const evidence: CompletionReconciliationEvidence = prior ?? { ...request, type: "completion-reconciliation", proofKind: "operator-verified",
        sessionId: run.sessionId, runId: run.runId, authorityId: session.authorityId ?? null, cwd, native };
      if (prior && JSON.stringify([prior.native.activityDigest, prior.native.terminalMessageId, prior.native.outcome]) !== JSON.stringify([native.activityDigest, native.terminalMessageId, native.outcome])) throw new OpenCodeError("Native evidence changed since the audited reconciliation", 409);
      if (!prior) await this.deps.emit(run, "context", evidence);
      validate();
      await this.deps.persist();
      validate();
      const status = native.outcome === "succeeded" ? "completed" : native.outcome;
      const committed = Promise.withResolvers<void>();
      const terminalization: NonNullable<RunOwner["completionTerminalization"]> = { done: committed.promise, state: "pending" };
      // Install before finishNative synchronously changes the visible status.
      owner!.completionTerminalization = terminalization;
      // Both the operator and monitor observe failure; handle it even if the
      // monitor is still blocked in transport when persistence rejects.
      void committed.promise.catch(() => {});
      try {
        await this.finishNative(owner!, status, `Operator-verified completion: ${request.reason}`);
        if (this.deps.storageFailed()) throw new OpenCodeError("Completion terminal persistence failed", 503);
        terminalization.state = "committed"; committed.resolve();
      } catch (error) {
        terminalization.state = "failed"; committed.reject(error); throw error;
      }
      // The monitor joins only committed.promise, never this verification task.
      // Its existing finalizer releases the original owner and resolves done.
      await owner!.done;
      validate(false);
      if (this.deps.currentOwner(run.sessionId) === owner) throw new OpenCodeError("Completion ownership release remains unconfirmed", 409);
      return { status, evidence };
    } finally { this.completionChecks.delete(run.runId); }
  }
  private async readCommand(id: string, commandId: string, cwd: string, handoff: boolean): Promise<NativeCommandSnapshot & { observation: NativeCommandObservation }> {
    const policy = handoff ? "native-queued-handoff" as const : undefined;
    if (this.deps.oc.observeCommand) return this.deps.oc.observeCommand(id, commandId, cwd, policy);
    const snapshot = await this.deps.oc.snapshot(id, commandId, cwd, policy);
    const observation: NativeCommandObservation = snapshot.observation ?? (snapshot.pending
      ? handoff && !isQueuedHandoffAdmission(snapshot.pendingInput, id, commandId)
        ? { kind: "protocol-contradiction", reason: "Original pending input contradicts the strict native queue receipt protocol; operator reconciliation required; do not resend" }
        : { kind: "pending", input: snapshot.pendingInput }
      : snapshot.boundary ? { kind: "foreign-boundary", boundary: snapshot.boundary }
      : snapshot.outcome === "succeeded" || snapshot.outcome === "failed" || snapshot.outcome === "interrupted"
        ? { kind: "exact-terminal", outcome: snapshot.outcome } : { kind: "termination-uncertain" });
    return { ...snapshot, observation };
  }
  /** Native has no authoritative command-scoped cancellation receipt yet.
   * Neither DELETE acknowledgement nor absent history can release the owner. */
  readPendingCancellation(_owner: RunOwner): OpenCodePendingCancellation {
    // Native DELETE has no command-scoped removal receipt. Even a successful
    // DELETE followed by exact-message 404 and inbox absence is not proof.
    return { ready: false };
  }
  /** Bounded original-ID read / explicit Stop only. In particular, DTO Run phase
   * and committed user history cannot reconstruct a lost native queue receipt. */
  async observeRecoveredInput(scope: OpenCodeRecoveryObservation, stop = false): Promise<{ interrupted: boolean; terminal?: { identity: DispatchIdentity; status: "completed" | "failed" | "interrupted" } }> {
    const identity = scope.identity, { source, nativeCommandId: commandId } = identity;
    const validate = (mutation = false) => {
      if (mutation && this.deps.closing() || this.deps.storageFailed() || source.harnessId !== "opencode" || !source.nativeSessionId || !commandId)
        throw new OpenCodeError("Original native recovery observation unavailable", 503);
      scope.validate();
      if (mutation && scope.protocolUnsafe()) throw new OpenCodeError("Original queue protocol is unsafe; operator reconciliation required", 409);
    };
    validate();
    const read = async () => {
      if (this.deps.closing()) throw new OpenCodeError("Recovery read closed", 503);
      validate();
      const snapshot = await this.readCommand(source.nativeSessionId!, commandId!, source.cwd, true);
      validate();
      if (snapshot.observation.kind === "unavailable") return snapshot;
      if (snapshot.observation.kind === "protocol-contradiction") {
        await scope.protocolMismatch(snapshot.observation.reason);
        validate(); return snapshot;
      }
      const pending = snapshot.pendingInput;
      if (pending !== undefined && pending !== null && !isQueuedHandoffAdmission(pending, source.nativeSessionId!, commandId!)) {
        await scope.protocolMismatch("Original pending input contradicts the strict native queue receipt protocol; operator reconciliation required; do not resend");
        validate();
      }
      if (!scope.protocolUnsafe() && !scope.accepted() && snapshot.pending && isQueuedHandoffAdmission(pending, source.nativeSessionId!, commandId!)) scope.outcome();
      validate(); return snapshot;
    };
    let snapshot = await read();
    const terminal = () => {
      validate();
      if (this.deps.closing() || scope.protocolUnsafe() || !scope.accepted() || snapshot.pending || snapshot.boundary
        || snapshot.observation.kind !== "exact-terminal"
        || !snapshot.messages.some(message => message.id === commandId && message.type === "user")) return;
      return { identity, status: snapshot.observation.outcome === "succeeded" ? "completed" as const : snapshot.observation.outcome };
    };
    // Conservatively refuse even exact pending DELETE under the unsafe overlay.
    // Historical acceptance is retained, but cannot authorize any native effect.
    if (!stop || this.deps.closing() || snapshot.observation.kind === "exact-terminal" || snapshot.observation.kind === "unavailable" || snapshot.observation.kind === "protocol-contradiction" || scope.protocolUnsafe()) {
      const proof = terminal();
      return { interrupted: false, ...(proof ? { terminal: proof } : {}) };
    }
    if (snapshot.pending) {
      if (!isQueuedHandoffAdmission(snapshot.pendingInput, source.nativeSessionId!, commandId!) || !this.deps.oc.cancelInput) return { interrupted: false };
      try { await this.deps.oc.cancelInput(source.nativeSessionId!, commandId!, () => validate(true), "native-queued-handoff"); }
      catch (error) {
        if (!(error instanceof OpenCodeCommandProtocolError)) throw error;
        await scope.protocolMismatch(error.message); validate(); return { interrupted: false };
      }
      validate(true);
      // A transport boolean is not a native cancellation receipt.
      snapshot = await read();
    }
    const proof = terminal();
    return { interrupted: false, ...(proof ? { terminal: proof } : {}) };
  }
  private currentNative(owner: RunOwner) {
    return !this.deps.closing() && !this.deps.storageFailed() && owner.run.status === "running" && this.deps.currentOwner(owner.run.sessionId) === owner;
  }
  private assertHandoff(owner: RunOwner) {
    const pins = this.handoffPins.get(owner), policy = owner.nativeDeliveryPolicy;
    if (policy !== undefined && policy !== "idle-only" && policy !== "native-queued-handoff"
      || (owner.nativeQueuedHandoff !== undefined || pins) && policy !== "native-queued-handoff") {
      throw new Error("Native delivery withheld: explicit native-queued-handoff policy is required for a handoff; unknown policies are not legacy delivery");
    }
    if (policy !== "native-queued-handoff") return;
    const run = owner.run, session = this.deps.session(run.sessionId), claim = owner.nativeQueuedHandoff;
    if (pins && (run !== pins.run || run.runId !== pins.runId || run.sessionId !== pins.sessionId || run.nativeCommandId !== pins.commandId
      || run.cwd !== pins.cwd || session.lastRunId !== pins.runId || JSON.stringify(claim) !== pins.claim || configuration(session) !== pins.configuration || runConfiguration(run) !== pins.runConfiguration)) {
      throw new OpenCodeSourceMismatchError("Claimed native command/source or conversation configuration changed; retain original handoff ownership without resending");
    }
    if (run.nativeDelivery !== "queue" || !["preparing", "sending", "accepted"].includes(run.nativePhase ?? "") || session.harness !== "opencode" || session.sessionId !== run.sessionId || session.lastRunId !== run.runId || run.operation === "compact" || owner.workerDeliveryId
      || !claim || claim.origin !== "queued-user" || typeof claim.requestId !== "string" || !claim.requestId.trim()
      || !session.nativeSessionId || !run.nativeCommandId || claim.runId !== run.runId || claim.nativeCommandId !== run.nativeCommandId
      || claim.source.harnessId !== "opencode" || claim.source.sessionId !== run.sessionId || claim.source.nativeSessionId !== session.nativeSessionId
      || claim.source.cwd !== session.cwd || claim.source.cwd !== run.cwd || claim.source.authorityId !== (session.authorityId ?? null)
      || JSON.stringify([run.model, run.effort, run.profileId, run.agent, run.agentKind, run.nativeAgentSelected]) !== JSON.stringify([session.model, session.effort, session.profileId, session.agent, session.agentKind, session.nativeAgentSelected])
      || !owner.dispatchEvidence || !owner.beforeSend || !this.deps.oc.promptQueuedHandoff || !this.deps.oc.preflightNativeSession) {
      throw new Error("Native queued handoff withheld: ordinary queued-user claim, queue delivery, source pins, and admission hooks are required");
    }
    if (pins) return pins;
    const captured: HandoffPins = Object.freeze({ run, runId: run.runId, sessionId: run.sessionId, commandId: run.nativeCommandId,
      nativeSessionId: session.nativeSessionId, cwd: claim.source.cwd, claim: JSON.stringify(claim), configuration: configuration(session), runConfiguration: runConfiguration(run) });
    this.handoffPins.set(owner, captured);
    return captured;
  }
  private handoffUnsafe(owner: RunOwner) {
    return owner.nativeHandoffProtocolUnsafe || this.deps.events(owner.run.runId).some(event => event.runId === owner.run.runId && event.kind === "status" && record(event.data) && event.data.nativeQueuedHandoffProtocolMismatch === true);
  }
  private async reportHandoffMismatch(owner: RunOwner, reason: string, assertAssociation: () => void = () => {}) {
    assertAssociation();
    if (this.handoffUnsafe(owner)) return;
    owner.nativeHandoffProtocolUnsafe = true;
    // Retain the contradiction in memory even if storage has already failed.
    // Cancellation/shutdown do not turn an observed protocol error into absence.
    if (this.deps.storageFailed()) return;
    await this.deps.emit(owner.run, "status", { status: "running", connection: "unconfirmed", nativeQueuedHandoffProtocolMismatch: true, reason });
    assertAssociation();
    if (this.deps.storageFailed()) return;
    await this.deps.persist();
    assertAssociation();
  }
  async finishNative(owner: RunOwner, status: Status, reason?: string) {
    if (owner.run.nativeDelivery === "queue" && (owner.run.status !== "running" || this.deps.currentOwner(owner.run.sessionId) !== owner)) return;
    owner.run.status = status; owner.run.endedAt = new Date().toISOString();
    if (this.deps.currentOwner(owner.run.sessionId) === owner) this.deps.session(owner.run.sessionId).lastStatus = status;
    await this.deps.emit(owner.run, "status", { status, ...(reason ? { reason } : {}) });
    await this.deps.persist();
  }
  /** Launch inputs as journal evidence, after selection, before native submission. */
  private async launchEvidence(owner: RunOwner, resume: boolean, setupContext?: ExecutionContext) {
    this.assertHandoff(owner);
    const run = owner.run, session = this.deps.session(run.sessionId), compact = run.operation === "compact";
    const context = setupContext ?? await this.deps.executionContext(session.sessionId), identity = snapshotIdentity(run);
    this.assertHandoff(owner);
    if (run.nativeDelivery === "queue" && (!this.currentNative(owner) || owner.stopRequested)) throw new Error("Queued prompt withheld before launch evidence");
    await this.deps.emit(run, "launch", {
      harness: "opencode", resume, operation: run.operation ?? "prompt", workstreamId: context.workstreamId, workstreamRoot: context.artifactsRoot, implementationRoot: run.cwd,
      agent: run.agent ?? null, saneContextVersion: run.saneContextVersion ?? null,
      nativeAgent: this.executionAgents.get(owner) ?? (run.nativeAgentSelected && identity ? nativeAgentId(identity, "opencode") : null), model: compact ? null : run.model ?? null, variant: compact ? null : run.effort ?? null,
      ...(session.saneExecution ? { executionPolicy: { revision: session.saneExecution.revision, nativeRoleRegistration: false } } : {}),
    });
  }
  async monitorNative(owner: RunOwner) {
    const run = owner.run;
    const originalRunId = run.runId, originalSessionId = run.sessionId, originalCommandId = run.nativeCommandId;
    const assertObservationAssociation = () => {
      if (owner.run !== run || run.runId !== originalRunId || run.sessionId !== originalSessionId || run.nativeCommandId !== originalCommandId)
        throw new OpenCodeSourceMismatchError("Original native observation association changed");
    };
    const session = this.deps.session(run.sessionId);
    const handoff = owner.nativeDeliveryPolicy === "native-queued-handoff" || owner.nativeQueuedHandoff !== undefined || this.handoffPins.has(owner);
    const current = () => {
      if (!this.currentNative(owner) || handoff && owner.settled) return false;
      const pins = this.assertHandoff(owner);
      if (!handoff && pins) throw new Error("Native delivery policy changed during legacy observation");
      return true;
    };
    const snapshots = new Map<string, string>();
    for (const event of this.deps.events(run.runId)) if (event.kind === "message") {
      const data = event.data; if (record(data) && typeof data.messageId === "string") snapshots.set(data.messageId, JSON.stringify(data));
    }
    let lastError = "", lastBoundary = "", workerWaiting: boolean | undefined, queueWaiting: boolean | undefined;
    let acceptanceReported = run.nativePhase === "accepted";
    for (const event of this.deps.events(run.runId)) if (event.kind === "status" && record(event.data) && "completionBoundary" in event.data) {
      lastBoundary = event.data.completionBoundary ? JSON.stringify(event.data.completionBoundary) : "";
    }
    try {
    while (!this.deps.closing() && !this.deps.storageFailed() && run.status === "running") {
      try {
        if (!current()) break;
        const pins = this.handoffPins.get(owner);
        const nativeSessionId = pins?.nativeSessionId ?? session.nativeSessionId!, commandId = pins?.commandId ?? run.nativeCommandId!;
        const snapshot = await this.readCommand(nativeSessionId, commandId, pins?.cwd ?? session.cwd, handoff);
        // A returned contradiction is an original-command fact, even while Stop
        // defers settlement. Latch it before cancellation or follow-on gates can
        // discard this snapshot and let a later terminal erase the unsafe proof.
        if (handoff && snapshot.observation.kind === "protocol-contradiction") await this.reportHandoffMismatch(owner, snapshot.observation.reason, assertObservationAssociation);
        if (!current()) break;
        if (snapshot.observation.kind === "unavailable") throw new OpenCodeUnavailableError(snapshot.observation.reason);
        if (run.nativeDelivery === "queue" && (owner.cancelling || handoff && owner.stopping)) { await this.deps.sleep(1000); continue; }
        const exactUser = snapshot.messages.some(m => m.id === commandId && m.type === "user");
        const pending = snapshot.pendingInput;
        if (!current()) break;
        const accepted = handoff ? !this.handoffUnsafe(owner) && snapshot.observation.kind === "pending" && isQueuedHandoffAdmission(pending, nativeSessionId, commandId) : exactUser;
        if (!acceptanceReported && accepted) {
          owner.dispatchEvidence?.outcome("submitted", "accepted");
          if (!current()) break;
          acceptanceReported = true;
        }
        if (run.nativePhase !== "accepted" && (handoff ? accepted : snapshot.pending || snapshot.messages.some(m => m.id === run.nativeCommandId))) {
          run.nativePhase = "accepted";
          if (handoff && isQueuedHandoffAdmission(pending, nativeSessionId!, commandId!)) run.nativeAcceptedAt = pending.time.created;
          await this.deps.persist();
        }
        if (!current()) break;
        if (run.nativeDelivery === "queue") {
          const waiting = !snapshot.messages.some(m => m.id === commandId && m.type === "user");
          if (queueWaiting !== waiting) { queueWaiting = waiting; await this.deps.emit(run, "status", { status: "running", connection: "connected", reason: waiting ? "Queued prompt waiting for native continuation to consume the exact input" : "Queued prompt consumed by native continuation" }); }
        }
        for (const message of snapshot.messages) {
          if (!current()) break;
          const normalized = normalizeMessage(message); if (!normalized) continue;
          const encoded = JSON.stringify(normalized);
          if (snapshots.get(normalized.messageId) !== encoded) { await this.deps.emit(run, "message", normalized); snapshots.set(normalized.messageId, encoded); }
        }
        if (!current()) break;
        if (lastError && (snapshot.messages.length || snapshot.pending)) { await this.deps.emit(run, "status", { status: "running", connection: "connected", reason: "Native state reconnected" }); lastError = ""; }
        if (!current()) break;
        if (handoff && (owner.cancelling || owner.stopping)) { await this.deps.sleep(1000); continue; }
        if (snapshot.observation.kind === "exact-terminal" && (!handoff || acceptanceReported && !this.handoffUnsafe(owner) && exactUser)) {
          if (snapshot.settlement) {
            await this.deps.emit(run, "context", { type: "automatic-completion-reconciliation", nativeSessionId, ...snapshot.settlement });
            if (!current()) break;
          }
          if (lastBoundary) {
            await this.deps.emit(run, "status", { status: "running", completionBoundary: null, reason: "Native completion verified automatically" });
            if (!current()) break;
          }
          await this.finishNative(owner, snapshot.observation.outcome === "succeeded" ? "completed" : snapshot.observation.outcome); break;
        }
        const observedBoundary = snapshot.observation.kind === "foreign-boundary" ? snapshot.observation.boundary : undefined;
        const boundary = observedBoundary ? JSON.stringify(observedBoundary) : "";
        if (lastBoundary !== boundary) {
          await this.deps.emit(run, "status", { status: "running", completionBoundary: observedBoundary ?? null,
            ...(observedBoundary ? { reason: `A later ${observedBoundary.type} message prevents attributing completion to this command; retaining ownership without resending` } : {}) });
          lastBoundary = boundary;
        }
        if (!current()) break;
        if (this.deps.workerHasRun(run.runId)) {
          const waiting = (await this.deps.oc.interactions(handoff ? nativeSessionId : session.nativeSessionId!)).length > 0;
          if (!current()) break;
          if (workerWaiting !== waiting) { workerWaiting = waiting; await this.deps.emit(run, "status", { status: "running", workerWaiting: waiting }); }
        }
        if (!current()) break;
        if (!snapshot.messages.length && !snapshot.pending && run.nativePhase === "sending" && !lastError) {
          lastError = "Prompt acceptance remains unconfirmed; reconnecting to native history without resending";
          await this.deps.emit(run, "status", { status: "running", connection: "unconfirmed", reason: lastError });
        }
      } catch (error) {
        if (!this.currentNative(owner)) break;
        const reason = error instanceof Error ? error.message : "Native reconciliation unavailable";
        if (handoff && error instanceof OpenCodeCommandProtocolError) await this.reportHandoffMismatch(owner, reason);
        if (lastError !== reason) { await this.deps.emit(run, "status", { status: "running", connection: error instanceof OpenCodeError && !(error instanceof OpenCodeUnavailableError) ? "unconfirmed" : "unavailable", reason }); lastError = reason; }
      }
      await this.deps.sleep(1000);
    }
    } finally {
      // A concurrent operator may have made status terminal before its journal
      // and metadata writes complete. Lifecycle finalizers must join durability.
      await owner.completionTerminalization?.done;
    }
  }
  async monitorNativeCompact(owner: RunOwner) {
    const run = owner.run, session = this.deps.session(run.sessionId);
    const snapshots = new Map<string, string>();
    for (const event of this.deps.events(run.runId)) if (event.kind === "message") {
      const data = event.data; if (record(data) && typeof data.messageId === "string") snapshots.set(data.messageId, JSON.stringify(data));
    }
    let lastDiagnostic = "", historyRefreshAttempted = false;
    while (!this.deps.closing() && !this.deps.storageFailed() && run.status === "running") {
      try {
        await this.deps.compactExecution(session);
        // Lost acknowledgement can hide a coalesced ID. An absent requested ID
        // never proves rejection; never substitute the latest session message.
        const id = run.compact!.nativeAdmittedId ?? run.compact!.nativeRequestId ?? run.nativeCommandId!;
        const snapshot = await this.deps.oc.compactionSnapshot(session.nativeSessionId!, id, session.cwd);
        if (this.deps.closing() || this.deps.storageFailed()) break;
        if (snapshot.observed && run.nativePhase !== "accepted") { run.nativePhase = "accepted"; await this.deps.persist(); }
        for (const message of snapshot.messages) {
          const normalized = normalizeMessage(message); if (!normalized) continue;
          const encoded = JSON.stringify(normalized);
          if (snapshots.get(normalized.messageId) !== encoded) { await this.deps.emit(run, "message", normalized); snapshots.set(normalized.messageId, encoded); }
        }
        if (snapshot.outcome && !snapshot.pending && !snapshot.active) {
          // Exact input outcome is independent of idle/activity. Check ALL
          // pending inputs before freeing the App slot, not only our compact ID.
          const activity = await this.deps.oc.activity(session.nativeSessionId!, session.cwd);
          if (!activity.active && !activity.pending) {
            if (!historyRefreshAttempted) { historyRefreshAttempted = true; await this.deps.refreshCompactHistory(owner); }
            if (this.deps.closing() || this.deps.storageFailed()) break;
            const settled = await this.deps.oc.activity(session.nativeSessionId!, session.cwd);
            if (!settled.active && !settled.pending) {
              await this.finishNative(owner, owner.stopRequested ? "interrupted" : "completed", "Native compaction settled and conversation is idle; compaction outcome is reported separately");
              break;
            }
          }
        }
        const diagnostic = snapshot.outcome ? "Native compaction outcome recorded; waiting for native activity and pending input to settle" : !snapshot.observed ? "Compaction admission or outcome remains unconfirmed; retaining ownership and observing the exact request without resending" : "Native compaction observed; waiting for exact native outcome";
        if (lastDiagnostic !== diagnostic) { await this.deps.emit(run, "status", { status: "running", operation: "compact", connection: snapshot.observed ? "connected" : "unconfirmed", reason: diagnostic }); lastDiagnostic = diagnostic; }
      } catch (error) {
        if (this.deps.closing() || this.deps.storageFailed()) break;
        const reason = error instanceof Error ? error.message : "Native compaction observation unavailable";
        if (lastDiagnostic !== reason) { await this.deps.emit(run, "status", { status: "running", operation: "compact", connection: "unconfirmed", reason }); lastDiagnostic = reason; }
      }
      await this.deps.sleep(1000);
    }
  }
  async executeNativeCompact(owner: RunOwner) {
    const run = owner.run, session = this.deps.session(run.sessionId);
    const expected = configuration(session);
    const guard = () => {
      if (this.deps.closing() || this.deps.storageFailed() || owner.stopRequested || owner.cancelling || owner.settled || this.deps.currentOwner(session.sessionId) !== owner
        || configuration(this.deps.session(run.sessionId)) !== expected) throw new Error("Compaction context preparation cancelled or changed");
    };
    let attempted = false;
    try {
      if (this.deps.closing() || owner.stopRequested) throw new Error("Stopped before native compaction submission");
      await this.deps.compactExecution(session);
      await this.deps.oc.assertIdle(session.nativeSessionId!, session.cwd);
      await this.configureExecution(owner, guard);
      await this.launchEvidence(owner, true);
      if (this.deps.closing() || this.deps.storageFailed() || owner.stopRequested) throw new Error("Bridge unavailable before native compaction submission");
      run.nativePhase = "sending"; await this.deps.persist();
      await this.deps.compactExecution(session);
      // Recheck idle immediately before dispatch. No agent/model selection,
      // synthetic user message or ordinary prompt endpoint participates.
      await this.deps.oc.assertIdle(session.nativeSessionId!, session.cwd);
      const submission = this.deps.oc.compact(session.nativeSessionId!, run.compact!.nativeRequestId!, () => {
        guard();
        if (this.deps.closing() || this.deps.storageFailed() || owner.stopRequested || this.deps.currentOwner(session.sessionId) !== owner) throw new Error("Compaction withheld before native dispatch");
        attempted = true; owner.nativeDispatched = true;
      });
      owner.submission = submission;
      try {
        const admitted = await submission;
        // Native may coalesce our request into a DIFFERENT pending compaction.
        // Its ID must be durable before any lifecycle observation or release.
        run.compact!.nativeAdmittedId = admitted.id; run.nativePhase = "accepted"; run.nativeAcceptedAt = admitted.time.created;
        await this.deps.persist();
      } catch (error) {
        if (!attempted) throw error;
        if (error instanceof OpenCodeError && [400, 401, 403, 404, 409].includes(error.status)) {
          await this.deps.emit(run, "status", { status: "running", operation: "compact", compactAdmissionRejected: true, nativeStatus: error.status, reason: error.message });
          await this.finishNative(owner, "failed", "Native compaction admission rejected; request will not be replayed"); return;
        }
        if (this.deps.storageFailed()) return;
        await this.deps.emit(run, "status", { status: "running", operation: "compact", connection: "unconfirmed", reason: error instanceof Error ? error.message : "Compaction acknowledgement unavailable; do not resend" });
      }
      await this.monitorNativeCompact(owner);
    } catch (error) {
      if (this.deps.storageFailed()) return;
      if (!attempted) {
        await this.deps.emit(run, "status", { status: "running", operation: "compact", compactNotSubmitted: true });
        await this.finishNative(owner, owner.stopRequested || this.deps.closing() ? "interrupted" : "failed", error instanceof Error ? error.message : "Compaction preparation failed");
      } else throw error;
    }
  }
  async recoverNativeCompact(owner: RunOwner) {
    const run = owner.run;
    const negative = this.deps.events(run.runId).some(event => event.kind === "status" && record(event.data) && (event.data.compactNotSubmitted === true || event.data.compactAdmissionRejected === true && typeof event.data.nativeStatus === "number" && [400, 401, 403, 404, 409].includes(event.data.nativeStatus)));
    if (run.nativePhase === "preparing" || negative) {
      if (run.nativePhase === "preparing") await this.deps.emit(run, "status", { status: "running", operation: "compact", compactNotSubmitted: true });
      await this.finishNative(owner, "failed", negative ? "Recovered definitive compaction non-admission evidence; request will not be replayed" : "Bridge restarted before native compaction submission; request will not be replayed");
      return;
    }
    await this.monitorNativeCompact(owner);
  }
  async executeNative(owner: RunOwner, prompt: string, resume: boolean, ready: (accepted: boolean) => void) {
    const run = owner.run; const session = this.deps.session(run.sessionId), queued = run.nativeDelivery === "queue";
    const handoff = owner.nativeDeliveryPolicy === "native-queued-handoff" || owner.nativeQueuedHandoff !== undefined || this.handoffPins.has(owner);
    const expectedConfiguration = configuration(session), expectedRunConfiguration = runConfiguration(run), nativeSessionId = session.nativeSessionId!;
    const expectedPolicy = owner.nativeDeliveryPolicy, commandId = run.nativeCommandId!;
    // This is the bridge's exact lifecycle identity (including requestId), not a
    // reconstruction from mutable Session/Run fields or queue defaults.
    const contextIdentity = owner.contextIdentity, contextMessages = owner.contextMessages, dispatchEvidence = owner.dispatchEvidence;
    const submissionPublication = owner.submissionPublication;
    const contextSource = contextIdentity?.source, contextSourceSnapshot = JSON.stringify(contextSource);
    const assertDelivery = () => {
      if (owner.nativeDeliveryPolicy !== expectedPolicy) throw new Error("Native delivery policy changed before native dispatch");
      return this.assertHandoff(owner);
    };
    const assertDispatchState = () => {
      if (!this.currentNative(owner) || owner.settled || owner.stopRequested || owner.cancelling || owner.stopping
        || owner.run !== run || this.deps.session(run.sessionId) !== session || runConfiguration(run) !== expectedRunConfiguration
        || owner.nativeDeliveryPolicy !== expectedPolicy || configuration(this.deps.session(run.sessionId)) !== expectedConfiguration
        || run.nativeCommandId !== commandId || session.nativeSessionId !== nativeSessionId
         || !dispatchEvidence || owner.dispatchEvidence !== dispatchEvidence
         || owner.submissionPublication !== submissionPublication
        || !contextIdentity || owner.contextIdentity !== contextIdentity || !contextMessages || owner.contextMessages !== contextMessages
        || contextIdentity.runId !== run.runId || contextIdentity.nativeCommandId !== commandId
        || contextIdentity.source.harnessId !== "opencode" || contextIdentity.source.sessionId !== run.sessionId
        || contextIdentity.source.nativeSessionId !== nativeSessionId || contextIdentity.source.authorityId !== (session.authorityId ?? null)
        || contextIdentity.source.cwd !== session.cwd || run.cwd !== contextIdentity.source.cwd) throw new Error("Prompt withheld before native dispatch: ownership, cancellation, context identity, or conversation configuration changed");
    };
    const assertBeforeSend = () => {
      assertDispatchState();
      synchronousDispatchHook(() => owner.beforeSend?.());
      assertDelivery();
      this.deps.assertWorkerDeliverySubmission(owner);
      assertDispatchState(); assertDelivery();
    };
    let promptAttempted = handoff && (owner.nativeDispatched === true || run.nativePhase === "sending" || run.nativePhase === "accepted");
    // Admission/mutations above require assertDispatchState. Original-command
    // observation must instead survive Stop while native termination is uncertain.
    const observationCurrent = () => this.currentNative(owner) && !owner.settled;
    const assertObservationAssociation = () => {
      if (owner.run !== run || !contextIdentity || owner.contextIdentity !== contextIdentity
        || owner.contextMessages !== contextMessages || run.runId !== contextIdentity.runId
        || run.sessionId !== contextSource?.sessionId || run.nativeCommandId !== commandId
        || contextIdentity.nativeCommandId !== commandId || contextIdentity.source !== contextSource
        || JSON.stringify(contextSource) !== contextSourceSnapshot) throw new OpenCodeSourceMismatchError("Original native submission association changed");
    };
    const current = () => { assertDispatchState(); assertDelivery(); };
    const mode = handoff ? "queued-handoff" : expectedPolicy === "idle-only" ? "idle-only" : queued ? "queued" : "initial";
    const timing = createRunSubmissionTiming({ harness: "opencode", mode });
    let pipelineStarted = false;
    let timingRecorded = false;
    const recordTiming = () => {
      if (!pipelineStarted || timingRecorded) return;
      timingRecorded = true;
      this.retainSubmissionTiming(owner, timing);
    };
    try {
      assertDelivery();
      // Read-only recovery, never a second submission of an unresolved head.
      if (handoff && promptAttempted) { await this.monitorNative(owner); return; }
      if (!dispatchEvidence || !contextMessages) throw new Error("Native prompt requires the original owner's dispatch evidence and context capabilities");
      const preparePromptSubmission = this.deps.oc.preparePromptSubmission;
      if (!preparePromptSubmission) throw new Error("Prepared OpenCode prompt transport is unavailable; submission withheld");
      if (compactCommand(prompt)) throw new Error("Use the dedicated Compact action; compaction cannot be submitted as an ordinary prompt");
      if (queued && (run.operation === "compact" || owner.workerDeliveryId)) throw new Error("Queued native delivery requires a user prompt run");
      if (mode === "idle-only" && queued) throw new Error("Idle-only delivery cannot use the native inbox");
      try {
        pipelineStarted = true;
        let readActualSubmission: (() => ActualContextSubmission) | undefined;
        const admitted = await coordinateRunSubmission<OpenCodePromptPacket, { context: ExecutionContext; transport?: OpenCodePreparedPrompt }, Awaited<ReturnType<OpenCodePreparedPrompt["send"]>>, string>({
          mode, request: { messageId: commandId, body: prompt, boundary: "run-initial",
            ...(owner.nativeQueuedHandoff ? { queuedFollowupId: owner.nativeQueuedHandoff.requestId } : {}) },
          contextMessages, assertCurrent: current, assertObservationCurrent: assertObservationAssociation,
          failClosed: error => this.deps.failClosed(error),
          evidence: dispatchEvidence,
          publication: submissionPublication,
          journal: {
            status: () => this.deps.emit(run, "status", { status: "running", ...(queued ? { reason: "Queued prompt waiting for native continuation to consume the exact input" } : {}) }),
            submission: submission => this.deps.emit(run, "submission", submission),
            launch: (_packet, setup) => this.launchEvidence(owner, resume, setup.context),
          },
          publishMetadata: async phase => { if (phase === "launch") run.nativePhase = "sending"; await this.deps.persist(); },
          native: {
            capabilities: { initial: { supported: true }, queued: { supported: true }, "queued-handoff": { supported: true }, "idle-only": { supported: true }, "live-input": { supported: false, reason: "OpenCode does not support live prompt input" } },
            encode: text => {
              const packet = prepareOpenCodePrompt(nativeSessionId, commandId, text, queued ? "queue" : undefined);
              const readActual = () => {
                // Original bytes remain observable after Stop/configuration drift.
                assertObservationAssociation();
                const actual = JSON.parse(packet.body);
                return { identity: contextIdentity!, messageId: actual.id, text: actual.text };
              };
              readActualSubmission = readActual;
              return { payload: packet, readActual, assertWire: body => {
                if (body !== packet.body) throw new OpenCodeSourceMismatchError("Actual native wire body differs from the bound prompt packet");
              } };
            },
            setup: async (_packet, steps) => {
              // Snapshot setup roots for launch diagnostics only; preflight still resolves fresh.
              const context = { ...await steps.step("execution.resolve", () => this.deps.executionContext(session.sessionId)) };
              const cwd = context.executionCheckout;
              if (cwd !== contextIdentity!.source.cwd) throw new OpenCodeSourceMismatchError("Execution directory differs from the context identity");
              run.cwd = cwd;
              if (!queued) {
                await steps.step("native.inspect", () => this.deps.oc.assertIdle(nativeSessionId, cwd));
                await steps.step("execution.configure", () => this.deps.oc.select(nativeSessionId, run.model, run.effort));
              }
              await this.configureExecution(owner, steps.assertCurrent, steps);
              return { context };
            },
            preflight: async (packet, setup, steps) => {
              const cwd = await steps.step("execution.resolve", () => this.deps.execution(session.sessionId));
              if (cwd !== contextIdentity!.source.cwd) throw new OpenCodeSourceMismatchError("Submission directory differs from the context identity");
              run.cwd = cwd;
              // Handoffs recheck binding, never introduce a post-claim idle lease.
              if (mode === "idle-only") await steps.step("native.inspect", () => this.deps.oc.assertIdle(nativeSessionId, cwd));
              if (handoff) await steps.step("native.preflight", () => this.deps.oc.preflightNativeSession!(nativeSessionId, cwd));
              const text = JSON.parse(packet.body).text as string;
              setup.transport = await steps.step("transport.setup", () => preparePromptSubmission.call(this.deps.oc, nativeSessionId, commandId, text, queued ? "queue" : undefined, packet, handoff));
            },
            beforeNative: () => {
              assertBeforeSend();
              ready(true);
              current();
            },
            onIntentRecorded: () => {
              // Bookkeeping only: preserve successful original intent even when
              // the core's trailing admission gate subsequently refuses fetch.
              promptAttempted = true; owner.nativeDispatched = true;
            },
            send: (_packet, setup, boundary) => {
              if (!setup.transport) throw new Error("Prepared native prompt transport is missing");
              // The handle enters boundary synchronously and issues one fetch
              // without discovery or another await after final context proof.
              const submission = setup.transport.send(body => boundary.beforeNative(body)).then(receipt => {
                const exact = handoff ? isQueuedHandoffAdmission(receipt, nativeSessionId, commandId) : receipt?.id === commandId && Number.isFinite(receipt.time?.created);
                if (!exact) throw handoff ? new OpenCodeQueuedHandoffProtocolError("Native queue acknowledgement protocol mismatch; retain ownership; do not resend") : new Error("Native prompt acknowledgement identity is unconfirmed");
                return receipt;
              }).catch(async error => {
                // Latch a received contradiction BEFORE shared outcome observers
                // can replace its error. This catch covers only native receipt
                // decoding/validation, never errors from boundary.outcome below.
                if (handoff && error instanceof OpenCodeQueuedHandoffProtocolError) {
                  await this.reportHandoffMismatch(owner, error.message, () => {
                    if (!readActualSubmission) throw new OpenCodeSourceMismatchError("Original native submission association is unavailable");
                    readActualSubmission();
                  });
                }
                throw error;
              }).then(receipt => {
                boundary.outcome("submitted", "accepted");
                return receipt;
              });
              owner.submission = submission;
              return submission;
            },
          }, timing,
        });
        if (!observationCurrent()) return;
        assertDelivery();
        run.nativePhase = "accepted"; run.nativeAcceptedAt = admitted.time.created; await this.deps.persist();
      } catch (error) {
        if (!promptAttempted) throw error; // Delivery was withheld before HTTP submission, including discovery failure.
        try { dispatchEvidence.outcome("unknown"); }
        finally {
          // Preserve the exact received protocol contradiction even if the
          // original outcome hook refuses follow-on launch policy. Never let a
          // cancellation/current-owner gate hide it or permit a queue wake.
          if (handoff && error instanceof OpenCodeQueuedHandoffProtocolError) await this.reportHandoffMismatch(owner, error.message, assertObservationAssociation);
        }
        if (!observationCurrent()) return;
        assertDelivery();
        if (!handoff && error instanceof OpenCodeError && [400, 401, 403, 404, 409].includes(error.status)) {
          await this.finishNative(owner, "failed", error.message); return;
        }
        await this.deps.emit(run, "status", { status: "running", connection: "unconfirmed", reason: error instanceof Error ? error.message : "Native submission unconfirmed" });
      }
      recordTiming();
      if (observationCurrent()) await this.monitorNative(owner);
    } catch (error) {
      ready(false);
      if (this.deps.storageFailed()) return;
       if (!promptAttempted) await this.finishNative(owner, owner.stopRequested || owner.cancelling || this.deps.closing() ? "interrupted" : "failed", error instanceof Error ? error.message : "Native preparation failed");
      else throw error;
    } finally {
      if (!promptAttempted) dispatchEvidence?.withheld();
      // In-memory finalization only; no journal, persistence or async callback.
      recordTiming();
      if (owner.workerDeliveryId && !promptAttempted && !this.deps.storageFailed()) await this.deps.emit(run, "status", { status: run.status, workerDeliveryNotSubmitted: owner.workerDeliveryId }); ready(false);
    }
  }
  /** Called only for explicit Stop, after the bridge journals the request.
   * Submission must settle before interrupt so a delayed prompt cannot escape it. */
  interrupt(owner: RunOwner): Promise<{ interrupted: boolean }> {
    return this.interruptSubmission(owner, false, false);
  }
  /** A direct stop request acknowledges withheld preparation as stopped, and
   * rechecks live ownership after submission settles. Worker cancellation keeps
   * its existing narrower native-interruption acknowledgement above. */
  interruptCurrent(owner: RunOwner): Promise<{ interrupted: boolean }> {
    return this.interruptSubmission(owner, true, true);
  }
  private async interruptSubmission(owner: RunOwner, withheld: boolean, checkOwner: boolean): Promise<{ interrupted: boolean }> {
    const run = owner.run, queued = run.nativeDelivery === "queue";
    let pins: HandoffPins | undefined;
    try { pins = this.assertHandoff(owner); } catch { return { interrupted: false }; }
    const sessionId = pins?.sessionId ?? run.sessionId, session = this.deps.session(sessionId);
    const nativeSessionId = pins?.nativeSessionId ?? session.nativeSessionId!, commandId = pins?.commandId ?? run.nativeCommandId!, cwd = pins?.cwd ?? session.cwd;
    const expectedConfiguration = configuration(session), expectedRunConfiguration = runConfiguration(run), expectedPolicy = owner.nativeDeliveryPolicy;
    const assertCancellation = () => {
      if (!this.currentNative(owner) || owner.settled || owner.run !== run) throw new Error("Native cancellation withheld after ownership changed");
      this.assertHandoff(owner);
      if (owner.nativeDeliveryPolicy !== expectedPolicy || run.nativeDelivery !== "queue" || run.sessionId !== sessionId || run.nativeCommandId !== commandId || run.cwd !== cwd
        || configuration(this.deps.session(sessionId)) !== expectedConfiguration || runConfiguration(run) !== expectedRunConfiguration) {
        throw new OpenCodeSourceMismatchError("Native cancellation withheld after claimed source or conversation configuration changed");
      }
    };
    const cancellationCurrent = () => {
      try { assertCancellation(); return true; } catch { return false; }
    };
    if (queued && !this.currentNative(owner)) return { interrupted: false };
    if (owner.run.operation === "compact" && !owner.submission && owner.nativeDispatched === false) return { interrupted: withheld };
    if (!owner.submission && (owner.run.nativePhase === "preparing" || !queued && owner.nativeDispatched === false)) return { interrupted: withheld };
    if (owner.nativeDeliveryPolicy === "native-queued-handoff" && owner.nativeDispatched === false) return { interrupted: withheld };
    await owner.submission?.catch(() => {});
    if (queued && !cancellationCurrent()) return { interrupted: false };
    try {
      if (owner.nativeDeliveryPolicy !== expectedPolicy) return { interrupted: false };
      this.assertHandoff(owner);
    } catch { return { interrupted: false }; }
    if (!queued && owner.nativeDispatched === false) return { interrupted: withheld };
    if (checkOwner && this.deps.currentOwner(owner.run.sessionId) !== owner || owner.run.status !== "running") return { interrupted: false };
    if (queued) {
      if (!this.currentNative(owner) || owner.workerDeliveryId) return { interrupted: false };
      const snapshot = await this.readCommand(nativeSessionId, commandId, cwd, !!pins);
      if (!cancellationCurrent() || snapshot.observation.kind === "exact-terminal" || snapshot.observation.kind === "unavailable") return { interrupted: false };
      if (pins && snapshot.observation.kind === "protocol-contradiction") {
        await this.reportHandoffMismatch(owner, snapshot.observation.reason);
        return { interrupted: false };
      }
      if (snapshot.pending) {
        if (!this.deps.oc.cancelInput) return { interrupted: false };
        // Pinned handoffs require the strict original receipt before any DELETE.
        // Legacy deletion stays separate and cannot support live release proof.
        if (pins && !isQueuedHandoffAdmission(snapshot.pendingInput, nativeSessionId, commandId)) return { interrupted: false };
        try { await this.deps.oc.cancelInput(nativeSessionId, commandId, () => {
          if (!this.currentNative(owner)) throw new Error("Queued input cancellation withheld after ownership changed");
          assertCancellation();
        }, pins ? "native-queued-handoff" : undefined); }
        catch (error) {
          if (!pins || !(error instanceof OpenCodeCommandProtocolError)) throw error;
          await this.reportHandoffMismatch(owner, error.message);
          return { interrupted: false };
        }
        if (!cancellationCurrent()) return { interrupted: false };
        // No verified command-scoped cancellation receipt: keep the owner even
        // if the adapter reports removal. The monitor observes exact terminal
        // history independently; absence alone cannot settle this run.
      }
      return { interrupted: false };
    }
    return this.deps.oc.cancel(this.deps.session(owner.run.sessionId).nativeSessionId!);
  }
}
