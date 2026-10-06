import type { Event, Run, Session, Status } from "./history";
import { OpenCodeError, normalizeMessage, type OpenCodeAdapter } from "./opencode";
import type { RunOwner } from "./run-owner";
import type { ExecutionContext } from "./workstreams";
import { saneSessionMessageId, snapshotIdentity } from "./agent-launch";
import { nativeAgentId } from "sane-core/agent-catalog";

/** Native transport only; owner arbitration and durable writes remain in the bridge. */
export type OpenCodeRunAdapter = Pick<OpenCodeAdapter, "assertIdle" | "select" | "prompt" | "snapshot" | "interactions" | "compact" | "compactionSnapshot" | "activity" | "cancel"> & Partial<Pick<OpenCodeAdapter, "deliverSaneSession" | "bindSaneSession" | "boundSaneSession" | "cancelInput">>;
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

/** OpenCode command lifecycle. Reads live bridge state after awaited work; never
 * owns a second registry, replays a mutation, or cancels native work on detach. */
export class OpenCodeRunService {
  constructor(private readonly deps: OpenCodeRunDependencies) {}
  private currentNative(owner: RunOwner) {
    return !this.deps.closing() && !this.deps.storageFailed() && owner.run.status === "running" && this.deps.currentOwner(owner.run.sessionId) === owner;
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
    const run = owner.run, session = this.deps.session(run.sessionId), compact = run.operation === "compact";
    const delivery = this.deps.takeFrameworkDelivery(session.sessionId);
    if (delivery) await this.deps.emit(run, "context", { type: "framework-delivered", ...delivery });
    const context = await this.deps.executionContext(session.sessionId), identity = snapshotIdentity(run);
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
    const snapshots = new Map<string, string>();
    for (const event of this.deps.events(run.runId)) if (event.kind === "message") {
      const data = event.data; if (record(data) && typeof data.messageId === "string") snapshots.set(data.messageId, JSON.stringify(data));
    }
    let lastError = "", lastBoundary = "", workerWaiting: boolean | undefined, queueWaiting: boolean | undefined;
    for (const event of this.deps.events(run.runId)) if (event.kind === "status" && record(event.data) && "completionBoundary" in event.data) {
      lastBoundary = event.data.completionBoundary ? JSON.stringify(event.data.completionBoundary) : "";
    }
    while (!this.deps.closing() && !this.deps.storageFailed() && run.status === "running") {
      try {
        const snapshot = await this.deps.oc.snapshot(session.nativeSessionId!, run.nativeCommandId!, session.cwd);
        if (!this.currentNative(owner)) break;
        if (run.nativeDelivery === "queue" && owner.cancelling) { await this.deps.sleep(1000); continue; }
        if (run.nativePhase !== "accepted" && (snapshot.pending || snapshot.messages.some(m => m.id === run.nativeCommandId))) { run.nativePhase = "accepted"; await this.deps.persist(); }
        if (!this.currentNative(owner)) break;
        if (run.nativeDelivery === "queue") {
          const waiting = !snapshot.messages.some(m => m.id === run.nativeCommandId && m.type === "user");
          if (queueWaiting !== waiting) { queueWaiting = waiting; await this.deps.emit(run, "status", { status: "running", connection: "connected", reason: waiting ? "Queued prompt waiting for native continuation to consume the exact input" : "Queued prompt consumed by native continuation" }); }
        }
        for (const message of snapshot.messages) {
          if (!this.currentNative(owner)) break;
          const normalized = normalizeMessage(message); if (!normalized) continue;
          const encoded = JSON.stringify(normalized);
          if (snapshots.get(normalized.messageId) !== encoded) { await this.deps.emit(run, "message", normalized); snapshots.set(normalized.messageId, encoded); }
        }
        if (!this.currentNative(owner)) break;
        if (lastError && (snapshot.messages.length || snapshot.pending)) { await this.deps.emit(run, "status", { status: "running", connection: "connected", reason: "Native state reconnected" }); lastError = ""; }
        if (!this.currentNative(owner)) break;
        if (snapshot.outcome === "succeeded" || snapshot.outcome === "failed" || snapshot.outcome === "interrupted") {
          await this.finishNative(owner, snapshot.outcome === "succeeded" ? "completed" : snapshot.outcome); break;
        }
        const boundary = snapshot.boundary ? JSON.stringify(snapshot.boundary) : "";
        if (lastBoundary !== boundary) {
          await this.deps.emit(run, "status", { status: "running", completionBoundary: snapshot.boundary ?? null,
            ...(snapshot.boundary ? { reason: `A later ${snapshot.boundary.type} message prevents attributing completion to this command; retaining ownership without resending` } : {}) });
          lastBoundary = boundary;
        }
        if (!this.currentNative(owner)) break;
        if (this.deps.workerHasRun(run.runId)) {
          const waiting = (await this.deps.oc.interactions(session.nativeSessionId!)).length > 0;
          if (!this.currentNative(owner)) break;
          if (workerWaiting !== waiting) { workerWaiting = waiting; await this.deps.emit(run, "status", { status: "running", workerWaiting: waiting }); }
        }
        if (!this.currentNative(owner)) break;
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
    const configuration = (value: Session) => JSON.stringify([value.harness, value.authorityId, value.nativeSessionId, value.cwd,
      value.profileId, value.model, value.effort, value.agent, value.agentKind, value.nativeAgentSelected, value.saneContext, value.attachment]);
    const expectedConfiguration = configuration(session), nativeSessionId = session.nativeSessionId!;
    const assertBeforeSend = () => {
      if (!this.currentNative(owner) || owner.settled || owner.stopRequested || owner.cancelling || owner.stopping
        || configuration(this.deps.session(run.sessionId)) !== expectedConfiguration) throw new Error("Prompt withheld before native dispatch: ownership, cancellation, or conversation configuration changed");
      owner.beforeSend?.();
      this.deps.assertWorkerDeliverySubmission(owner);
    };
    let promptAttempted = false;
    try {
      if (compactCommand(prompt)) throw new Error("Use the dedicated Compact action; compaction cannot be submitted as an ordinary prompt");
      if (queued && (run.operation === "compact" || owner.workerDeliveryId)) throw new Error("Queued native delivery requires a user prompt run");
      await this.deps.emit(run, "status", { status: "running", ...(queued ? { reason: "Queued prompt waiting for native continuation to consume the exact input" } : {}) });
      await this.deps.emit(run, "submission", { messageId: run.nativeCommandId, text: prompt });
      await this.deps.persist();
      if (queued && (run.status !== "running" || this.deps.currentOwner(run.sessionId) !== owner)) return;
      if (this.deps.closing() || owner.stopRequested) { await this.finishNative(owner, "interrupted", "Stopped before native submission"); ready(false); return; }
      const cwd = await this.deps.execution(session.sessionId);
      if (queued && (run.status !== "running" || this.deps.currentOwner(run.sessionId) !== owner)) return;
      run.cwd = cwd;
      if (queued) {
        if (!this.currentNative(owner)) throw new Error("Queued prompt ownership changed before launch evidence");
      } else {
        await this.deps.oc.assertIdle(session.nativeSessionId!, run.cwd);
        await this.deps.oc.select(session.nativeSessionId!, run.model, run.effort);
        if (!resume) {
          const block = await this.deps.saneSession(session.sessionId);
          if (block !== null) {
            if (!this.deps.oc.deliverSaneSession) throw new Error("Native startup requires SANE Session context delivery");
            await this.deps.oc.deliverSaneSession(session.nativeSessionId!, saneSessionMessageId(session.sessionId), block);
            await this.deps.emit(run, "context", { type: "session-block", changed: true, text: block });
          }
        }
      }
      await this.launchEvidence(owner, resume);
      if (queued && (run.status !== "running" || this.deps.currentOwner(run.sessionId) !== owner)) return;
      if (this.deps.closing() || owner.stopRequested) { await this.finishNative(owner, "interrupted", "Stopped before native submission"); ready(false); return; }
      run.nativePhase = "sending"; await this.deps.persist();
      if (queued && (run.status !== "running" || this.deps.currentOwner(run.sessionId) !== owner)) return;
      if (this.deps.closing() || this.deps.storageFailed() || owner.stopRequested) throw new Error("Bridge unavailable before native submission");
      const submissionCwd = await this.deps.execution(session.sessionId);
      if (queued && !this.currentNative(owner)) return;
      run.cwd = submissionCwd;
      // Native command ID is durable before the request. A timeout is ambiguous:
      // keep this conversation's slot and reconcile, never replay automatically.
      this.deps.assertWorkerDeliverySubmission(owner);
      ready(true);
      try {
        const beforeSubmit = () => {
          assertBeforeSend();
          promptAttempted = true; owner.nativeDispatched = true;
        };
        const submission = queued ? this.deps.oc.prompt(nativeSessionId, run.nativeCommandId!, prompt, beforeSubmit, "queue") : this.deps.oc.prompt(nativeSessionId, run.nativeCommandId!, prompt, beforeSubmit);
        owner.submission = submission;
        const admitted = await submission;
        if (queued && !this.currentNative(owner)) return;
        run.nativePhase = "accepted"; run.nativeAcceptedAt = admitted.time.created; await this.deps.persist();
      } catch (error) {
        if (queued && !this.currentNative(owner)) return;
        if (!promptAttempted) throw error; // Delivery was withheld before HTTP submission, including discovery failure.
        if (error instanceof OpenCodeError && [400, 401, 403, 404, 409].includes(error.status)) {
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
    } finally { if (owner.workerDeliveryId && !promptAttempted && !this.deps.storageFailed()) await this.deps.emit(run, "status", { status: run.status, workerDeliveryNotSubmitted: owner.workerDeliveryId }); ready(false); }
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
    if (owner.run.nativeDelivery === "queue" && !this.currentNative(owner)) return { interrupted: false };
    if (owner.run.operation === "compact" && !owner.submission && owner.nativeDispatched === false) return { interrupted: withheld };
    if (!owner.submission && (owner.run.nativePhase === "preparing" || owner.run.nativeDelivery !== "queue" && owner.nativeDispatched === false)) return { interrupted: withheld };
    await owner.submission?.catch(() => {});
    if (owner.run.nativeDelivery !== "queue" && owner.nativeDispatched === false) return { interrupted: withheld };
    if (checkOwner && this.deps.currentOwner(owner.run.sessionId) !== owner || owner.run.status !== "running") return { interrupted: false };
    if (owner.run.nativeDelivery === "queue") {
      const run = owner.run, session = this.deps.session(run.sessionId);
      if (!this.currentNative(owner) || owner.workerDeliveryId) return { interrupted: false };
      let snapshot = await this.deps.oc.snapshot(session.nativeSessionId!, run.nativeCommandId!, session.cwd);
      if (!this.currentNative(owner) || snapshot.outcome) return { interrupted: false };
      if (snapshot.pending) {
        if (!this.deps.oc.cancelInput) return { interrupted: false };
        const canceled = await this.deps.oc.cancelInput(session.nativeSessionId!, run.nativeCommandId!, () => {
          if (!this.currentNative(owner)) throw new Error("Queued input cancellation withheld after ownership changed");
        });
        if (!this.currentNative(owner)) return { interrupted: false };
        if (canceled) {
          await this.finishNative(owner, "interrupted", "Explicitly canceled queued native input before consumption");
          return { interrupted: true };
        }
        snapshot = await this.deps.oc.snapshot(session.nativeSessionId!, run.nativeCommandId!, session.cwd);
        if (!this.currentNative(owner) || snapshot.outcome) return { interrupted: false };
      }
      if (snapshot.pending || snapshot.currentInputId !== run.nativeCommandId || !snapshot.messages.some(message => message.id === run.nativeCommandId && message.type === "user")) return { interrupted: false };
      const interrupted = await this.deps.oc.cancel(session.nativeSessionId!, () => {
        if (!this.currentNative(owner)) throw new Error("Native prompt interruption withheld after ownership changed");
      });
      return this.currentNative(owner) ? interrupted : { interrupted: false };
    }
    return this.deps.oc.cancel(this.deps.session(owner.run.sessionId).nativeSessionId!);
  }
}
