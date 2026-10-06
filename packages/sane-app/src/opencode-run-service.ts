import type { Event, Run, Session, Status } from "./history";
import { OpenCodeError, OpenCodeSourceMismatchError, OpenCodeQueuedHandoffProtocolError, isQueuedHandoffAdmission, normalizeMessage, type OpenCodeAdapter } from "./opencode";
import type { RunOwner } from "./run-owner";
import type { ExecutionContext } from "./workstreams";
import { saneSessionMessageId, snapshotIdentity } from "./agent-launch";
import { nativeAgentId } from "sane-core/agent-catalog";

/** Native transport only; owner arbitration and durable writes remain in the bridge. */
export type OpenCodeRunAdapter = Pick<OpenCodeAdapter, "assertIdle" | "select" | "prompt" | "snapshot" | "interactions" | "compact" | "compactionSnapshot" | "activity" | "cancel"> & Partial<Pick<OpenCodeAdapter, "promptQueuedHandoff" | "preflightNativeSession" | "deliverSaneSession" | "bindSaneSession" | "boundSaneSession" | "cancelInput">>;
export type OpenCodeRunDependencies = {
  oc: OpenCodeRunAdapter;
  closing: () => boolean;
  storageFailed: () => boolean;
  currentOwner: (sessionId: string) => RunOwner | undefined;
  session: (sessionId: string) => Session;
  events: (runId: string) => readonly Event[];
  emit: (run: Run, kind: Event["kind"], data: unknown) => Promise<void>;
  persist: () => Promise<void>;
  execution: (sessionId: string) => Promise<string>;
  /** Workstream membership and roots recorded in launch evidence. */
  executionContext: (sessionId: string) => Promise<ExecutionContext>;
  /** The acknowledged creation-time framework delivery not yet journaled; removed on read. */
  takeFrameworkDelivery: (sessionId: string) => FrameworkDelivery | undefined;
  compactExecution: (session: Session) => Promise<string>;
  refreshCompactHistory: (owner: RunOwner) => Promise<void>;
  assertWorkerDeliverySubmission: (owner: RunOwner) => void;
  workerHasRun: (runId: string) => boolean;
  /** The startup SANE Session block from current membership, or null. */
  saneSession: (sessionId: string) => Promise<string | null>;
  sleep: (ms: number) => Promise<unknown>;
};

export type FrameworkDelivery = { messageId: string; sha256: string; chars: number };
const compactCommand = (text: string) => /^\s*\/compact(?:\s|$)/i.test(text);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
const configuration = (value: Session) => JSON.stringify([value.sessionId, value.harness, value.authorityId, value.nativeSessionId, value.cwd,
  value.profileId, value.model, value.effort, value.agent, value.agentKind, value.nativeAgentSelected, value.saneContext, value.attachment]);
const runConfiguration = (run: Run) => JSON.stringify([run.model, run.effort, run.profileId, run.agent, run.agentKind, run.nativeAgentSelected, run.operation, run.saneContextVersion]);
type HandoffPins = Readonly<{ run: Run; runId: string; sessionId: string; commandId: string; nativeSessionId: string; cwd: string; claim: string; configuration: string; runConfiguration: string }>;

/** OpenCode command lifecycle. Reads live bridge state after awaited work; never
 * owns a second registry, replays a mutation, or cancels native work on detach. */
export class OpenCodeRunService {
  // Observation pins only, not an admission/token or ownership registry. The
  // bridge's real claim gate and durable dispatch evidence remain mandatory.
  private readonly handoffPins = new WeakMap<RunOwner, HandoffPins>();
  constructor(private readonly deps: OpenCodeRunDependencies) {}
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
  private async reportHandoffMismatch(owner: RunOwner, reason: string) {
    if (this.handoffUnsafe(owner)) return;
    owner.nativeHandoffProtocolUnsafe = true;
    await this.deps.emit(owner.run, "status", { status: "running", connection: "unconfirmed", nativeQueuedHandoffProtocolMismatch: true, reason });
    await this.deps.persist();
  }
  async finishNative(owner: RunOwner, status: Status, reason?: string) {
    if (owner.run.nativeDelivery === "queue" && (owner.run.status !== "running" || this.deps.currentOwner(owner.run.sessionId) !== owner)) return;
    owner.run.status = status; owner.run.endedAt = new Date().toISOString();
    if (this.deps.currentOwner(owner.run.sessionId) === owner) this.deps.session(owner.run.sessionId).lastStatus = status;
    await this.deps.emit(owner.run, "status", { status, ...(reason ? { reason } : {}) });
    await this.deps.persist();
  }
  /** Launch inputs as journal evidence, after selection and startup context delivery, before native submission. */
  private async launchEvidence(owner: RunOwner, resume: boolean) {
    this.assertHandoff(owner);
    const run = owner.run, session = this.deps.session(run.sessionId), compact = run.operation === "compact";
    const delivery = this.deps.takeFrameworkDelivery(session.sessionId);
    if (delivery) await this.deps.emit(run, "context", { type: "framework-delivered", ...delivery });
    this.assertHandoff(owner);
    const context = await this.deps.executionContext(session.sessionId), identity = snapshotIdentity(run);
    this.assertHandoff(owner);
    if (run.nativeDelivery === "queue" && (!this.currentNative(owner) || owner.stopRequested)) throw new Error("Queued prompt withheld before launch evidence");
    await this.deps.emit(run, "launch", {
      harness: "opencode", resume, operation: run.operation ?? "prompt", workstreamId: context.workstreamId, workstreamRoot: context.artifactsRoot, implementationRoot: run.cwd,
      agent: run.agent ?? null, saneContextVersion: run.saneContextVersion ?? null,
      nativeAgent: run.nativeAgentSelected && identity ? nativeAgentId(identity, "opencode") : null, model: compact ? null : run.model ?? null, variant: compact ? null : run.effort ?? null,
    });
  }
  async monitorNative(owner: RunOwner) {
    const run = owner.run;
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
    while (!this.deps.closing() && !this.deps.storageFailed() && run.status === "running") {
      try {
        if (!current()) break;
        const pins = this.handoffPins.get(owner);
        const nativeSessionId = pins?.nativeSessionId ?? session.nativeSessionId!, commandId = pins?.commandId ?? run.nativeCommandId!;
        const snapshot = handoff ? await this.deps.oc.snapshot(nativeSessionId, commandId, pins!.cwd, "native-queued-handoff") : await this.deps.oc.snapshot(session.nativeSessionId!, run.nativeCommandId!, session.cwd);
        if (!current()) break;
        if (run.nativeDelivery === "queue" && (owner.cancelling || handoff && owner.stopping)) { await this.deps.sleep(1000); continue; }
        const exactUser = snapshot.messages.some(m => m.id === commandId && m.type === "user");
        const pending = snapshot.pendingInput;
        if (handoff && record(pending) && (pending.id !== commandId
          || pending.sessionID !== undefined && pending.sessionID !== nativeSessionId
          || pending.type !== undefined && pending.type !== "user" || pending.delivery !== undefined && pending.delivery !== "queue")) {
          await this.reportHandoffMismatch(owner, "Exact pending input contradicts native queued handoff policy; operator reconciliation required; do not resend");
        }
        if (!current()) break;
        const accepted = handoff ? !this.handoffUnsafe(owner) && snapshot.pending && isQueuedHandoffAdmission(pending, nativeSessionId, commandId) : exactUser;
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
        if ((!handoff || acceptanceReported && !this.handoffUnsafe(owner) && exactUser && !snapshot.pending && !snapshot.boundary) && (snapshot.outcome === "succeeded" || snapshot.outcome === "failed" || snapshot.outcome === "interrupted")) {
          await this.finishNative(owner, snapshot.outcome === "succeeded" ? "completed" : snapshot.outcome); break;
        }
        const boundary = snapshot.boundary ? JSON.stringify(snapshot.boundary) : "";
        if (lastBoundary !== boundary) {
          await this.deps.emit(run, "status", { status: "running", completionBoundary: snapshot.boundary ?? null,
            ...(snapshot.boundary ? { reason: `A later ${snapshot.boundary.type} message prevents attributing completion to this command; retaining ownership without resending` } : {}) });
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
        if (lastError !== reason) { await this.deps.emit(run, "status", { status: "running", connection: "unavailable", reason }); lastError = reason; }
      }
      await this.deps.sleep(1000);
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
    let attempted = false;
    try {
      if (this.deps.closing() || owner.stopRequested) throw new Error("Stopped before native compaction submission");
      await this.deps.compactExecution(session);
      await this.deps.oc.assertIdle(session.nativeSessionId!, session.cwd);
      await this.launchEvidence(owner, true);
      if (this.deps.closing() || this.deps.storageFailed() || owner.stopRequested) throw new Error("Bridge unavailable before native compaction submission");
      run.nativePhase = "sending"; await this.deps.persist();
      await this.deps.compactExecution(session);
      // Recheck idle immediately before dispatch. No agent/model selection,
      // synthetic user message or ordinary prompt endpoint participates.
      await this.deps.oc.assertIdle(session.nativeSessionId!, session.cwd);
      const submission = this.deps.oc.compact(session.nativeSessionId!, run.compact!.nativeRequestId!, () => {
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
    const expectedConfiguration = configuration(session), nativeSessionId = session.nativeSessionId!;
    const expectedPolicy = owner.nativeDeliveryPolicy, commandId = run.nativeCommandId!;
    const assertDelivery = () => {
      if (owner.nativeDeliveryPolicy !== expectedPolicy) throw new Error("Native delivery policy changed before native dispatch");
      return this.assertHandoff(owner);
    };
    const assertDispatchState = () => {
      if (!this.currentNative(owner) || owner.settled || owner.stopRequested || owner.cancelling || owner.stopping
        || owner.nativeDeliveryPolicy !== expectedPolicy || configuration(this.deps.session(run.sessionId)) !== expectedConfiguration) throw new Error("Prompt withheld before native dispatch: ownership, cancellation, or conversation configuration changed");
    };
    const assertBeforeSend = () => {
      assertDispatchState();
      owner.beforeSend?.();
      assertDelivery();
      this.deps.assertWorkerDeliverySubmission(owner);
      if (handoff) { assertDispatchState(); assertDelivery(); }
    };
    let promptAttempted = handoff && (owner.nativeDispatched === true || run.nativePhase === "sending" || run.nativePhase === "accepted");
    try {
      assertDelivery();
      // Read-only recovery, never a second submission of an unresolved head.
      if (handoff && promptAttempted) { await this.monitorNative(owner); return; }
      if (compactCommand(prompt)) throw new Error("Use the dedicated Compact action; compaction cannot be submitted as an ordinary prompt");
      if (queued && (run.operation === "compact" || owner.workerDeliveryId)) throw new Error("Queued native delivery requires a user prompt run");
      await this.deps.emit(run, "status", { status: "running", ...(queued ? { reason: "Queued prompt waiting for native continuation to consume the exact input" } : {}) });
      assertDelivery();
      await this.deps.emit(run, "submission", { messageId: run.nativeCommandId, text: prompt });
      assertDelivery();
      await this.deps.persist();
      assertDelivery();
      if (queued && (run.status !== "running" || this.deps.currentOwner(run.sessionId) !== owner)) return;
      if (this.deps.closing() || owner.stopRequested) { await this.finishNative(owner, "interrupted", "Stopped before native submission"); ready(false); return; }
      const cwd = await this.deps.execution(session.sessionId);
      assertDelivery();
      if (queued && (run.status !== "running" || this.deps.currentOwner(run.sessionId) !== owner)) return;
      run.cwd = cwd;
      if (queued) {
        if (!this.currentNative(owner)) throw new Error("Queued prompt ownership changed before launch evidence");
      } else {
        await this.deps.oc.assertIdle(session.nativeSessionId!, run.cwd);
        assertDelivery();
        await this.deps.oc.select(session.nativeSessionId!, run.model, run.effort);
        assertDelivery();
        if (!resume) {
          const block = await this.deps.saneSession(session.sessionId);
          assertDelivery();
          if (block !== null) {
            if (!this.deps.oc.deliverSaneSession) throw new Error("Native startup requires SANE Session context delivery");
            await this.deps.oc.deliverSaneSession(session.nativeSessionId!, saneSessionMessageId(session.sessionId), block);
            assertDelivery();
            await this.deps.emit(run, "context", { type: "session-block", changed: true, text: block });
          }
        }
      }
      await this.launchEvidence(owner, resume);
      assertDelivery();
      if (queued && (run.status !== "running" || this.deps.currentOwner(run.sessionId) !== owner)) return;
      if (this.deps.closing() || owner.stopRequested) { await this.finishNative(owner, "interrupted", "Stopped before native submission"); ready(false); return; }
      run.nativePhase = "sending"; await this.deps.persist();
      assertDelivery();
      if (queued && (run.status !== "running" || this.deps.currentOwner(run.sessionId) !== owner)) return;
      if (this.deps.closing() || this.deps.storageFailed() || owner.stopRequested) throw new Error("Bridge unavailable before native submission");
      const submissionCwd = await this.deps.execution(session.sessionId);
      assertDelivery();
      if (queued && !this.currentNative(owner)) return;
      run.cwd = submissionCwd;
      // Idle-only automation preserves its fresh proof. A durable native handoff
      // instead rechecks binding without refusing a post-claim foreign busy race.
      if (owner.nativeDeliveryPolicy === "idle-only") {
        if (queued) throw new Error("Idle-only delivery cannot use the native inbox");
        await this.deps.oc.assertIdle(nativeSessionId, submissionCwd);
        assertDelivery();
      }
      if (handoff) await this.deps.oc.preflightNativeSession!(nativeSessionId, submissionCwd);
      assertDelivery();
      // Native command ID is durable before the request. A timeout is ambiguous:
      // keep this conversation's slot and reconcile, never replay automatically.
      this.deps.assertWorkerDeliverySubmission(owner);
      ready(true);
      try {
        const beforeSubmit = () => {
          assertBeforeSend();
          owner.dispatchEvidence?.beforeNative();
          if (handoff) { assertDispatchState(); assertDelivery(); }
          promptAttempted = true; owner.nativeDispatched = true;
        };
        const submission = handoff ? this.deps.oc.promptQueuedHandoff!(nativeSessionId, commandId, prompt, beforeSubmit) : queued ? this.deps.oc.prompt(nativeSessionId, run.nativeCommandId!, prompt, beforeSubmit, "queue") : this.deps.oc.prompt(nativeSessionId, run.nativeCommandId!, prompt, beforeSubmit);
        owner.submission = submission;
        const admitted = await submission;
        if (queued && !this.currentNative(owner)) return;
        assertDelivery();
        // An acknowledgement for another command (or malformed response) is not
        // acceptance proof for our exact immutable command ID.
        const exact = handoff ? isQueuedHandoffAdmission(admitted, nativeSessionId, commandId) : admitted?.id === run.nativeCommandId && typeof admitted.time?.created === "number";
        owner.dispatchEvidence?.outcome(exact ? "submitted" : "unknown", exact ? "accepted" : "unknown");
        if (handoff) assertDelivery();
        if (!exact) throw handoff && admitted !== undefined ? new OpenCodeQueuedHandoffProtocolError("Native queue acknowledgement protocol mismatch; retain ownership; do not resend") : new Error("Native prompt acknowledgement identity is unconfirmed");
        run.nativePhase = "accepted"; run.nativeAcceptedAt = admitted.time.created; await this.deps.persist();
      } catch (error) {
        if (queued && !this.currentNative(owner)) return;
        if (!promptAttempted) throw error; // Delivery was withheld before HTTP submission, including discovery failure.
        owner.dispatchEvidence?.outcome("unknown");
        if (handoff && error instanceof OpenCodeQueuedHandoffProtocolError) await this.reportHandoffMismatch(owner, error.message);
        if (!handoff && error instanceof OpenCodeError && [400, 401, 403, 404, 409].includes(error.status)) {
          await this.finishNative(owner, "failed", error.message); return;
        }
        await this.deps.emit(run, "status", { status: "running", connection: "unconfirmed", reason: error instanceof Error ? error.message : "Native submission unconfirmed" });
      }
      await this.monitorNative(owner);
    } catch (error) {
      ready(false);
      if (this.deps.storageFailed()) return;
       if (!promptAttempted) await this.finishNative(owner, owner.stopRequested || owner.cancelling || this.deps.closing() ? "interrupted" : "failed", error instanceof Error ? error.message : "Native preparation failed");
      else throw error;
    } finally {
      if (!promptAttempted) owner.dispatchEvidence?.withheld();
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
      let snapshot = await this.deps.oc.snapshot(nativeSessionId, commandId, cwd, pins ? "native-queued-handoff" : undefined);
      if (!cancellationCurrent() || snapshot.outcome) return { interrupted: false };
      if (snapshot.pending) {
        if (!this.deps.oc.cancelInput) return { interrupted: false };
        const canceled = await this.deps.oc.cancelInput(nativeSessionId, commandId, () => {
          if (!this.currentNative(owner)) throw new Error("Queued input cancellation withheld after ownership changed");
          assertCancellation();
        });
        if (!cancellationCurrent()) return { interrupted: false };
        if (canceled) {
          await this.finishNative(owner, "interrupted", "Explicitly canceled queued native input before consumption");
          return { interrupted: true };
        }
        snapshot = await this.deps.oc.snapshot(nativeSessionId, commandId, cwd, pins ? "native-queued-handoff" : undefined);
        if (!cancellationCurrent() || snapshot.outcome) return { interrupted: false };
      }
      if (snapshot.pending || snapshot.currentInputId !== commandId || !snapshot.messages.some(message => message.id === commandId && message.type === "user")) return { interrupted: false };
      if (pins && this.handoffUnsafe(owner)) return { interrupted: false };
      // Native interrupt is session-wide, not atomic with this current-input read.
      // Consumption/new foreign activity can still race this explicit Stop.
      const interrupted = await this.deps.oc.cancel(nativeSessionId, () => {
        if (!this.currentNative(owner)) throw new Error("Native prompt interruption withheld after ownership changed");
        assertCancellation();
      });
      return cancellationCurrent() ? interrupted : { interrupted: false };
    }
    return this.deps.oc.cancel(this.deps.session(owner.run.sessionId).nativeSessionId!);
  }
}
