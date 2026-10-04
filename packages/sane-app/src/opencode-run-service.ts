import type { Event, Run, Session, Status } from "./history";
import { OpenCodeError, normalizeMessage, type OpenCodeAdapter } from "./opencode";
import type { RunOwner } from "./run-owner";
import type { ExecutionContext } from "./workstreams";
import { snapshotIdentity } from "./agent-launch";
import { nativeAgentId } from "sane-core/agent-catalog";

/** Native transport only; owner arbitration and durable writes remain in the bridge. */
export type OpenCodeRunAdapter = Pick<OpenCodeAdapter, "assertIdle" | "select" | "bindSaneSession" | "prompt" | "snapshot" | "interactions" | "compact" | "compactionSnapshot" | "activity" | "cancel">;
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
  /** The SANE Session block from current membership, or null. */
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
  async finishNative(owner: RunOwner, status: Status, reason?: string) {
    owner.run.status = status; owner.run.endedAt = new Date().toISOString();
    this.deps.session(owner.run.sessionId).lastStatus = status;
    await this.deps.emit(owner.run, "status", { status, ...(reason ? { reason } : {}) });
    await this.deps.persist();
  }
  /** Launch inputs as journal evidence, after selection and binding and before native submission. */
  private async launchEvidence(owner: RunOwner, resume: boolean, block: string | null, changed: boolean) {
    const run = owner.run, session = this.deps.session(run.sessionId), compact = run.operation === "compact";
    const delivery = this.deps.takeFrameworkDelivery(session.sessionId);
    if (delivery) await this.deps.emit(run, "context", { type: "framework-delivered", ...delivery });
    const context = await this.deps.executionContext(session.sessionId), identity = snapshotIdentity(run);
    await this.deps.emit(run, "launch", {
      harness: "opencode", resume, operation: run.operation ?? "prompt", workstreamId: context.workstreamId, workstreamRoot: context.artifactsRoot, implementationRoot: run.cwd,
      agent: run.agent ?? null, saneContextVersion: run.saneContextVersion ?? null,
      nativeAgent: run.nativeAgentSelected && identity ? nativeAgentId(identity, "opencode") : null, model: compact ? null : run.model ?? null, variant: compact ? null : run.effort ?? null,
    });
    await this.deps.emit(run, "context", { type: "session-block", changed, text: block });
  }
  async monitorNative(owner: RunOwner) {
    const run = owner.run;
    const session = this.deps.session(run.sessionId);
    const snapshots = new Map<string, string>();
    for (const event of this.deps.events(run.runId)) if (event.kind === "message") {
      const data = event.data; if (record(data) && typeof data.messageId === "string") snapshots.set(data.messageId, JSON.stringify(data));
    }
    let lastError = "", workerWaiting: boolean | undefined;
    while (!this.deps.closing() && !this.deps.storageFailed() && run.status === "running") {
      try {
        const snapshot = await this.deps.oc.snapshot(session.nativeSessionId!, run.nativeCommandId!, session.cwd);
        if (this.deps.closing() || this.deps.storageFailed()) break;
        if (run.nativePhase !== "accepted" && (snapshot.pending || snapshot.messages.some(m => m.id === run.nativeCommandId))) { run.nativePhase = "accepted"; await this.deps.persist(); }
        for (const message of snapshot.messages) {
          const normalized = normalizeMessage(message); if (!normalized) continue;
          const encoded = JSON.stringify(normalized);
          if (snapshots.get(normalized.messageId) !== encoded) { await this.deps.emit(run, "message", normalized); snapshots.set(normalized.messageId, encoded); }
        }
        if (lastError && (snapshot.messages.length || snapshot.pending)) { await this.deps.emit(run, "status", { status: "running", connection: "connected", reason: "Native state reconnected" }); lastError = ""; }
        if (snapshot.outcome === "succeeded" || snapshot.outcome === "failed" || snapshot.outcome === "interrupted") {
          await this.finishNative(owner, snapshot.outcome === "succeeded" ? "completed" : snapshot.outcome); break;
        }
        if (this.deps.workerHasRun(run.runId)) {
          const waiting = (await this.deps.oc.interactions(session.nativeSessionId!)).length > 0;
          if (workerWaiting !== waiting) { workerWaiting = waiting; await this.deps.emit(run, "status", { status: "running", workerWaiting: waiting }); }
        }
        if (!snapshot.messages.length && !snapshot.pending && run.nativePhase === "sending" && !lastError) {
          lastError = "Prompt acceptance remains unconfirmed; reconnecting to native history without resending";
          await this.deps.emit(run, "status", { status: "running", connection: "unconfirmed", reason: lastError });
        }
      } catch (error) {
        if (this.deps.storageFailed() || this.deps.closing()) break;
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
      const block = await this.deps.saneSession(session.sessionId);
      await this.launchEvidence(owner, true, block, await this.deps.oc.bindSaneSession(session.nativeSessionId!, block));
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
    const run = owner.run; const session = this.deps.session(run.sessionId);
    let promptAttempted = false;
    try {
      if (compactCommand(prompt)) throw new Error("Use the dedicated Compact action; compaction cannot be submitted as an ordinary prompt");
      await this.deps.emit(run, "status", { status: "running" });
      await this.deps.emit(run, "submission", { messageId: run.nativeCommandId, text: prompt });
      await this.deps.persist();
      if (this.deps.closing() || owner.stopRequested) { await this.finishNative(owner, "interrupted", "Stopped before native submission"); ready(false); return; }
      run.cwd = await this.deps.execution(session.sessionId);
      await this.deps.oc.assertIdle(session.nativeSessionId!, run.cwd);
      await this.deps.oc.select(session.nativeSessionId!, run.model, run.effort);
      const block = await this.deps.saneSession(session.sessionId);
      await this.launchEvidence(owner, resume, block, await this.deps.oc.bindSaneSession(session.nativeSessionId!, block));
      if (this.deps.closing() || owner.stopRequested) { await this.finishNative(owner, "interrupted", "Stopped before native submission"); ready(false); return; }
      run.nativePhase = "sending"; await this.deps.persist();
      if (this.deps.closing() || this.deps.storageFailed() || owner.stopRequested) throw new Error("Bridge unavailable before native submission");
      run.cwd = await this.deps.execution(session.sessionId);
      // Native command ID is durable before the request. A timeout is ambiguous:
      // keep this conversation's slot and reconcile, never replay automatically.
      this.deps.assertWorkerDeliverySubmission(owner);
      ready(true);
      try {
        promptAttempted = !owner.workerDeliveryId;
        const submission = this.deps.oc.prompt(session.nativeSessionId!, run.nativeCommandId!, prompt, owner.workerDeliveryId ? () => { this.deps.assertWorkerDeliverySubmission(owner); promptAttempted = true; } : undefined);
        owner.submission = submission;
        const admitted = await submission;
        run.nativePhase = "accepted"; run.nativeAcceptedAt = admitted.time.created; await this.deps.persist();
      } catch (error) {
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
      if (!promptAttempted) await this.finishNative(owner, owner.stopRequested ? "interrupted" : "failed", error instanceof Error ? error.message : "Native preparation failed");
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
    if (owner.run.operation === "compact" && !owner.submission && owner.nativeDispatched === false) return { interrupted: withheld };
    if (!owner.submission && owner.run.nativePhase === "preparing") return { interrupted: withheld };
    await owner.submission?.catch(() => {});
    if (owner.run.operation === "compact" && owner.nativeDispatched === false) return { interrupted: withheld };
    if (checkOwner && this.deps.currentOwner(owner.run.sessionId) !== owner || owner.run.status !== "running") return { interrupted: false };
    return this.deps.oc.cancel(this.deps.session(owner.run.sessionId).nativeSessionId!);
  }
}
