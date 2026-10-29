import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { AgentLaunchConfigurationError, claudeAgentSettings, sha256, snapshotIdentity } from "./agent-launch";
import { projectCompactions } from "./compaction";
import type { Event, Run, Session, TerminationUncertainty } from "./history";
import type { RunOwner } from "./run-owner";
import type { RunControlOperations } from "./run-controls";
import { WorkstreamAdapterError, type ExecutionContext } from "./workstreams";
import { isClaudeRootRecord } from "../shared/conversation/cc-scope";
import { CLAUDE_RESULT_TEXT_LIMIT, consumeClaudeResultRecord, createClaudeResultSequenceState, type ClaudeResultSequenceState } from "../shared/conversation/cc-result";
import type { QueuedSendConfiguration } from "../shared/conversation/queued-followup";
import type { ConversationActivity } from "../shared/conversation/activity";
import { ClaudeActivity } from "./claude-activity";
import { synchronousDispatchHook } from "./dispatch-evidence";
import { HarnessDispatchError } from "./harness-dispatch";
import type { ActualContextSubmission, OwnedContextMessages, OwnedSubmissionPublication } from "./context-message-transport";
import { coordinateRunSubmission, type RunSubmissionPreparationSteps } from "./run-submission-preparation";
import { createRunSubmissionTiming, type RunSubmissionTimingSnapshot } from "./run-submission-timing";
import type { DispatchIdentity } from "../shared/conversation/dispatch-contract";
import { claudeExecutionConfiguration } from "./canonical-agent-operations";
import type { CanonicalExecutionProvider } from "./canonical-execution-store";
import type { WorkerProtocolPin } from "./worker-contract";
import { execFile } from "node:child_process";

export const hookEvents = ["SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "PreToolUse", "PostToolUse", "PermissionRequest", "Notification", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact", "CwdChanged"] as const;

export type ClaudeRunOptions = {
  dataDir: string;
  claudeBin: string;
  claudeRoot: string;
  /** The same package root previously used for hooks/forward.ts in bridge. */
  packageRoot: string;
  /** Resolved at spawn, after the loopback hook listener has started. */
  hookUrl: () => string;
};

/** The bridge remains the sole owner of admission, metadata, and journal writes.
 * All state checks are live: preparation can overlap cancellation/shutdown. */
export type ClaudeRunDependencies = {
  session: (sessionId: string) => Session | undefined;
  run: (runId: unknown) => Run | undefined;
  events: (runId: string) => Event[];
  owns: (owner: RunOwner) => boolean;
  closing: () => boolean;
  storageFailed: () => boolean;
  retained: () => boolean;
  /** Set both retainOwner and metadata.reconciliationRequired, without I/O. */
  requireReconciliation: () => void;
  failClosed: () => void;
  emit: (run: Run, kind: Event["kind"], data: unknown) => Promise<void>;
  persist: () => Promise<void>;
  enqueue: (action: () => Promise<void>) => Promise<void>;
  execution: (sessionId: string) => Promise<string>;
  /** Workstream membership and roots recorded in launch evidence. */
  executionContext: (sessionId: string) => Promise<ExecutionContext>;
  compactExecution: (session: Session) => Promise<string>;
  refreshCompactHistory: (owner: RunOwner) => Promise<void>;
  assertWorkerDeliverySubmission: (owner: RunOwner) => void;
  canonicalExecution?: CanonicalExecutionProvider;
  /** Recorded worker pin only. Absent must not upgrade an unpinned resume. */
  explicitProtocol?: (sessionId: string) => WorkerProtocolPin | undefined;
  browserMcp?: (sessionId: string, runId: string) => Promise<{ mcpConfigPath: string; allowedTools: string[] } | null>;
};

type SpawnOptions = {
  cwd: string;
  detached: true;
  stdin: "pipe";
  stdout: "pipe";
  stderr: "pipe";
  env: Record<string, string>;
};
type ClaudeLaunchSetup = { args: string[]; options: SpawnOptions; launch: Record<string, unknown> };

/** Injectable local primitives for deterministic supervision tests; production
 * uses Bun children and signals only the group created by this live owner. */
export type ClaudeRunRuntime = {
  spawn: (args: string[], options: SpawnOptions) => Bun.Subprocess<"pipe", "pipe", "pipe">;
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep: (ms: number) => Promise<unknown>;
  randomUUID: () => string;
  execPath: string;
  env: NodeJS.ProcessEnv;
  writeSettings: (path: string, content: string) => Promise<void>;
  agentSettings: typeof claudeAgentSettings;
  version?: (executable: string) => Promise<string>;
};

export type ClaudeHookInput = { runId?: unknown; payload?: unknown };
export type ClaudeHookReply = { status: 200; body: { ok: true } } | { status: 400 | 403; body: { error: string } };
export type ClaudeQueuedFollowup = { requestId: string; afterRunId: string; sessionId: string; prompt: string; configuration?: QueuedSendConfiguration };
export type ClaudeTerminalCause = "result-success" | "service-closing" | "stop-requested" | "storage-failure" | "nonzero-exit" | "signal-exit" | "framework-rejected" | "result-failure" | "missing-result" | "termination-unconfirmed" | "launch-stream-shutdown-failure";
/** Process-local observations, never reconstructed from mutable Run DTO fields. */
export type ClaudeLocalSupervision = Readonly<{
  runId: string; sessionId: string; nativeSessionId: string | null; cwd: string;
  childPid: number | null; groupPid: number | null; nativeAttempted: boolean;
  exitObserved: boolean; exitCode: number | null; exitSignal: string | number | null;
  /** Observed service promise result: confirmed=true, unconfirmed=false.
   * Neither a promise's presence nor signal delivery is an acknowledgement. */
  termination: "not-requested" | "pending" | "confirmed" | "unconfirmed";
  streamsDrained: boolean; lifecycleFinished: boolean;
  terminal: Readonly<{ status: "completed" | "failed" | "interrupted"; cause: ClaudeTerminalCause }> | null;
}>;
export type ClaudeLocalSettlement =
  | { readonly ready: true; readonly kind: "withheld" | "terminated"; readonly evidence: ClaudeLocalSupervision }
  | { readonly ready: false; readonly reason: string; readonly code: "claude-local-unproven"; readonly evidence?: ClaudeLocalSupervision };
export type ClaudeLocalIdle = { readonly ready: true } | { readonly ready: false; readonly reason: string; readonly code: "claude-local-unproven" };
type Supervision = {
  readonly owner: RunOwner; readonly run: Run; readonly identity: Readonly<{ runId: string; sessionId: string; nativeSessionId: string | null; cwd: string }>;
  readonly source: Readonly<{ harness: Session["harness"]; authorityId: string | undefined; nativeSessionId: string | null; cwd: string | undefined }>;
  newNativeAssigned: boolean;
  /** Closed on return/throw from the synchronous intent hook, before spawn. */
  preparing: boolean;
  child?: Bun.Subprocess<"pipe", "pipe", "pipe">; pid?: number;
  nativeAttempted: boolean; exitObserved: boolean; exitCode: number | null; exitSignal: string | number | null;
  termination: ClaudeLocalSupervision["termination"]; terminationPromise?: Promise<boolean>;
  streamsDrained: boolean; finished: boolean; valid: boolean; terminal: ClaudeLocalSupervision["terminal"];
};
type QueuedFollowup = { owner: RunOwner; input: ClaudeQueuedFollowup; cancelled?: boolean; persisted: Promise<void>; draining?: Promise<void> };
type Result = ClaudeResultSequenceState & { stderr: string };
type LiveInput = { closed: boolean; sending: boolean; turnComplete: boolean; pendingUuids: Set<string>; result: Result;
  contextMessages: OwnedContextMessages; contextIdentity: DispatchIdentity };
const resultTextLimit = CLAUDE_RESULT_TEXT_LIMIT;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const compactCommand = (text: string) => /^\s*\/compact(?:\s|$)/i.test(text);
const equal = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** Decode the immutable wire line, not the composer candidate. CC's wire UUID
 * and journal message ID are different identities, correlated here explicitly. */
function readContextLine(encoded: string, uuid: string, nativeSessionId: string, messageId: string, identity: DispatchIdentity): ActualContextSubmission {
  const line = JSON.parse(encoded);
  if (line.type !== "user" || line.uuid !== uuid || line.session_id !== nativeSessionId
    || line.message?.role !== "user" || typeof line.message.content !== "string"
    || (messageId === `${identity.runId}:user` ? uuid !== identity.runId : messageId !== `${identity.runId}:user:${uuid}`)) throw new Error("Claude context wire identity mismatch");
  return { identity, messageId, text: line.message.content };
}

export class ClaudeRunService {
  private readonly secrets = new Map<string, { secret: string; supervised: Supervision }>();
  private readonly stoppedTurns = new Set<string>();
  private readonly turnHooks = new Map<string, symbol | undefined>();
  private readonly followups = new Map<string, QueuedFollowup>();
  private readonly activities = new Map<string, ClaudeActivity>();
  private readonly inputs = new WeakMap<RunOwner, LiveInput>();
  private readonly supervision = new WeakMap<RunOwner, Supervision>();
  /** Diagnostics only: never append through the authoritative fail-closed journal.
   * Keep at most the initial and latest live-input snapshot per original owner. */
  private readonly submissionTimings = new WeakMap<RunOwner, Readonly<{ initial?: RunSubmissionTimingSnapshot; liveInput?: RunSubmissionTimingSnapshot }>>();
  /** All unretired local groups/attempts, not the bridge's execution owners. */
  private readonly supervised = new Map<string, Set<Supervision>>();
  private readonly runtime: ClaudeRunRuntime;

  constructor(private readonly options: ClaudeRunOptions, private readonly deps: ClaudeRunDependencies, runtime: Partial<ClaudeRunRuntime> = {}) {
    this.runtime = {
      spawn: (args, options) => Bun.spawn(args, options),
      kill: (pid, signal) => { process.kill(pid, signal); },
      sleep: ms => Bun.sleep(ms),
      randomUUID: () => crypto.randomUUID(),
      execPath: process.execPath,
      env: process.env,
      writeSettings: (path, content) => writeFile(path, content, { mode: 0o600 }),
      agentSettings: claudeAgentSettings,
      version: executable => new Promise((resolve, reject) => execFile(executable, ["--version"], { timeout: 10000, maxBuffer: 4096 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()))),
      ...runtime,
    };
  }

  readSubmissionTiming(owner: RunOwner): Readonly<{ initial?: RunSubmissionTimingSnapshot; liveInput?: RunSubmissionTimingSnapshot }> | undefined {
    return this.submissionTimings.get(owner);
  }

  /** Bound to the original owner, never a later session owner or DTO lookup. */
  controls(owner: RunOwner): RunControlOperations {
    const done = owner.done;
    return {
      cancellation: "retain-result",
      interrupt: async () => ({ interrupted: await this.terminate(owner) }),
      cleanup: () => owner.child ? this.terminate(owner) : Promise.resolve(true),
      shutdown: async () => {
        // Preparation rechecks closing before spawn. Still observe the live child
        // after draining, rather than caching a prelaunch no-child observation.
        if (owner.child) await this.terminate(owner);
        const drained = await Promise.race([done.then(() => true), this.runtime.sleep(3000).then(() => false)]);
        if (!drained || (owner.child && this.groupAlive(owner))) return { drained: false, reconciliationRequired: true };
        return { drained: true, reconciliationRequired: false };
      },
      readPreparationTiming: () => this.readSubmissionTiming(owner),
    };
  }

  private retainSubmissionTiming(owner: RunOwner, kind: "initial" | "liveInput", timing: ReturnType<typeof createRunSubmissionTiming>): void {
    try { this.submissionTimings.set(owner, Object.freeze({ ...this.submissionTimings.get(owner), [kind]: timing.snapshot() })); }
    catch { /* Optional diagnostics cannot gate response, supervision or settlement. */ }
  }

  groupAlive(owner: RunOwner): boolean {
    const state = this.supervision.get(owner), pid = state ? state.pid : owner.child?.pid;
    return pid === undefined ? false : this.localGroupAlive(pid);
  }

  private localGroupAlive(pid: number): boolean {
    try { this.runtime.kill(-pid, 0); return true; } catch (e: any) { return e.code !== "ESRCH"; }
  }

  private validSupervision(state: Supervision): boolean {
    const { owner, identity } = state;
    if (owner.run !== state.run || owner.run.runId !== identity.runId || owner.run.sessionId !== identity.sessionId || owner.run.cwd !== identity.cwd
      || owner.child !== state.child || state.child && state.child.pid !== state.pid
      || !this.sameOriginalSource(state)
      || state.terminal && owner.run.status !== state.terminal.status) state.valid = false;
    return state.valid;
  }

  private sameOriginalSource(state: Supervision, session = this.deps.session(state.identity.sessionId)): boolean {
    const source = state.source;
    return !!session && session.sessionId === state.identity.sessionId && session.harness === source.harness
      && session.authorityId === source.authorityId && session.cwd === source.cwd
      && (session.nativeSessionId ?? null) === (state.newNativeAssigned ? state.identity.nativeSessionId : source.nativeSessionId);
  }

  /** Exact live service capability. Copied fields, forged status, exitCode and
   * streamsDrained cannot manufacture runtime terminal/EOF observations. */
  readLocalSettlement(owner: RunOwner): ClaudeLocalSettlement {
    const state = this.supervision.get(owner);
    const denied = (reason: string, evidence?: ClaudeLocalSupervision): ClaudeLocalSettlement => ({ ready: false, reason, code: "claude-local-unproven", ...(evidence ? { evidence } : {}) });
    if (!state) return denied("No original local supervision capability");
    const evidence: ClaudeLocalSupervision = Object.freeze({ ...state.identity,
      childPid: state.pid ?? null, groupPid: state.pid === undefined ? null : -state.pid, nativeAttempted: state.nativeAttempted,
      exitObserved: state.exitObserved, exitCode: state.exitCode, exitSignal: state.exitSignal, termination: state.termination,
      streamsDrained: state.streamsDrained, lifecycleFinished: state.finished, terminal: state.terminal });
    if (!this.validSupervision(state) || !state.finished || !state.terminal || !state.streamsDrained) return denied("Original local identity, terminal classification and successful EOF consumption are not all proven", evidence);
    if (!state.nativeAttempted && !state.child) return { ready: true, kind: "withheld", evidence };
    if (!state.child || state.pid === undefined || !state.exitObserved || this.localGroupAlive(state.pid)
      || owner.stopping && owner.stopping !== state.terminationPromise
      || state.termination === "pending" || state.termination === "unconfirmed") return denied("Original child exit and detached group absence are not proven", evidence);
    return { ready: true, kind: "terminated", evidence };
  }

  /** App-created groups only, never foreign Claude/native exclusivity or restart
   * safety. An optional original owner may exclude only its live, unattempted
   * preparation (including validation inside beforeNative, BEFORE intent writes).
   * This is a fresh observation, not an execution lease or settlement proof. */
  readLocalIdle(sessionId: string, preparingOwner?: RunOwner): ClaudeLocalIdle {
    const states = this.supervised.get(sessionId);
    if (states) for (const state of states) this.retireSupervision(state);
    const remaining = this.supervised.get(sessionId);
    const preparing = preparingOwner ? this.supervision.get(preparingOwner) : undefined;
    const denied: ClaudeLocalIdle = { ready: false, reason: "Local Claude preparation, group or stream supervision remains unproven", code: "claude-local-unproven" };
    if (preparingOwner && (!preparing || !remaining?.has(preparing) || preparing.identity.sessionId !== sessionId
      || !this.isPreparingOwner(preparing))) return denied;
    if (remaining) for (const state of remaining) if (state !== preparing) return denied;
    return { ready: true };
  }

  private isPreparingOwner(state: Supervision): boolean {
    const { owner } = state;
    return state.preparing && !state.nativeAttempted && !state.child && state.pid === undefined && !state.exitObserved
      && !state.finished && !state.terminal && !state.newNativeAssigned && state.termination === "not-requested"
      && !!state.identity.nativeSessionId && (state.source.harness === undefined || state.source.harness === "claude-code")
      && this.validSupervision(state) && this.deps.owns(owner) && owner.run.status === "running"
      && !owner.nativeDispatched && !owner.settled && !owner.stopRequested && !owner.cancelling && !owner.stopping
      && !this.deps.closing() && !this.deps.storageFailed() && !this.deps.retained();
  }

  private retireSupervision(state: Supervision): void {
    if (!state.finished || !state.streamsDrained) return;
    if (state.nativeAttempted && (!state.child || state.pid === undefined || !state.exitObserved || this.localGroupAlive(state.pid))) return;
    const states = this.supervised.get(state.identity.sessionId);
    states?.delete(state);
    if (!states?.size) this.supervised.delete(state.identity.sessionId);
  }

  /** Input admission is not process ownership. The one-shot CLI cannot receive
   * another prompt after stdin EOF; accept at most one journaled follow-up and
   * let bridge admit a fresh run only after this owner's entire lifecycle ends.
   * This capability is for explicit user prompts, never compact/worker/handoff
   * deliveries or any operation that requires an idle conversation. */
  canQueueFollowup(owner: RunOwner): boolean {
    return this.deps.owns(owner) && this.deps.session(owner.run.sessionId)?.harness === "claude-code"
      && !owner.native && !owner.workerDeliveryId && !!owner.child && owner.run.operation !== "compact"
      && owner.run.status === "running" && !owner.settled && !owner.stopRequested && !owner.cancelling && !owner.stopping
      && !this.deps.closing() && !this.deps.storageFailed() && !this.deps.retained()
      && this.stoppedTurns.has(owner.run.runId) && !this.followups.has(owner.run.sessionId);
  }

  hasQueuedFollowup(sessionId: string): boolean { return this.followups.has(sessionId); }
  /** Continue the original CLI, never resume the same session in a second process. */
  private inputCurrent(owner: RunOwner, input: LiveInput, workerReport = false): boolean {
    const supervised = this.supervision.get(owner);
    return !!supervised && this.validSupervision(supervised) && this.deps.owns(owner)
      && !input.closed && !input.result.error
      && !!owner.child && owner.child.exitCode === null && owner.run.status === "running" && owner.run.operation !== "compact"
      && !owner.settled && !owner.stopRequested && !owner.cancelling && !owner.stopping && (workerReport || !owner.workerDeliveryId)
      && !this.deps.closing() && !this.deps.storageFailed() && !this.deps.retained()
      && !this.hasQueuedFollowup(owner.run.sessionId) && !this.deps.session(owner.run.sessionId)?.attachment;
  }
  canSendInput(owner: RunOwner): boolean {
    const input = this.inputs.get(owner);
    return !!input && !input.sending && input.turnComplete && this.inputCurrent(owner, input)
      && this.activities.get(owner.run.runId)?.get().phase === "background";
  }
  /** Worker reports may queue behind an active turn in the SAME supervised CLI.
   * This never grants permission to spawn/resume a competing native process. */
  canSendWorkerReport(owner: RunOwner): boolean {
    const input = this.inputs.get(owner);
    return !!input && !input.sending && this.inputCurrent(owner, input, true);
  }
  async sendInput(owner: RunOwner, prompt: string, assertCurrent: () => void, publication?: OwnedSubmissionPublication): Promise<{ runId: string; messageId: string }> {
    return this.sendLiveInput(owner, prompt, assertCurrent, { publication });
  }
  async sendWorkerReport(owner: RunOwner, prompt: string, uuid: string, assertCurrent: () => void): Promise<{ runId: string; messageId: string }> {
    return this.sendLiveInput(owner, prompt, assertCurrent, { workerReportUuid: uuid });
  }
  private async sendLiveInput(owner: RunOwner, prompt: string, assertCurrent: () => void, options: { publication?: OwnedSubmissionPublication; workerReportUuid?: string }): Promise<{ runId: string; messageId: string }> {
    const input = this.inputs.get(owner);
    if (!prompt.trim() || compactCommand(prompt) || !input || !(options.workerReportUuid ? this.canSendWorkerReport(owner) : this.canSendInput(owner))) throw new WorkstreamAdapterError(409, "claude-input-unavailable", "Claude is not ready for live input");
    input.sending = true;
    const uuid = options.workerReportUuid ?? this.runtime.randomUUID(), messageId = `${owner.run.runId}:user:${uuid}`;
    const contextMessages = owner.contextMessages, contextIdentity = owner.contextIdentity;
    // Per-send publication is independent of the owner's initial publication.
    // Capture before awaits; the shared coordinator captures its callbacks.
    const submissionPublication = options.publication;
    const child = owner.child!, supervised = this.supervision.get(owner)!;
    const current = () => {
      assertCurrent();
      if (!contextMessages || !contextIdentity || owner.contextMessages !== contextMessages || owner.contextIdentity !== contextIdentity
        || input.contextMessages !== contextMessages || input.contextIdentity !== contextIdentity || owner.child !== child
        || !this.inputCurrent(owner, input, options.workerReportUuid !== undefined)) throw new WorkstreamAdapterError(409, "claude-input-unavailable", "Claude stopped or its context owner changed before the follow-up could be sent");
    };
    const timing = createRunSubmissionTiming({ harness: "claude-code", mode: "live-input" });
    let attempted = false, turnStarted = false;
    let previousTurn: { turnComplete: boolean; stopped: boolean; hook: symbol | undefined } | undefined;
    try {
      const observe = () => {
        // Observation must survive cancellation, exit and terminal DTO changes.
        // Only the original source/process association qualifies these bytes.
        if (owner.contextMessages !== contextMessages || owner.contextIdentity !== contextIdentity || owner.child !== child
          || owner.run !== supervised.run || owner.run.runId !== supervised.identity.runId || owner.run.sessionId !== supervised.identity.sessionId
          || owner.run.cwd !== supervised.identity.cwd || child.pid !== supervised.pid || !this.sameOriginalSource(supervised)) throw new Error("Claude context owner changed");
      };
      await coordinateRunSubmission({
        mode: "live-input", request: { messageId, body: prompt, liveInput: true, boundary: "message", ...(options.workerReportUuid ? { origin: "worker-report" as const } : {}) },
        contextMessages: contextMessages!, evidence: owner.dispatchEvidence!, assertCurrent: current,
        assertObservationCurrent: observe, failClosed: () => this.deps.failClosed(), publication: submissionPublication, timing,
        journal: { status: async () => {}, submission: submission => this.deps.emit(owner.run, "submission", submission), launch: async () => {} },
        publishMetadata: phase => phase === "submission" ? this.deps.persist() : Promise.resolve(),
        native: {
          capabilities: { "live-input": { supported: true } },
          encode: text => {
            const encoded = JSON.stringify({ type: "user", uuid, session_id: supervised.identity.nativeSessionId,
              message: { role: "user", content: text }, parent_tool_use_id: null }) + "\n";
            return { payload: encoded,
              readActual: () => { observe(); return readContextLine(encoded, uuid, supervised.identity.nativeSessionId!, messageId, contextIdentity!); },
              assertWire: wire => { if (wire !== encoded) throw new Error("Claude context wire changed"); } };
          },
          setup: async () => undefined,
          preflight: async () => {},
          beforeNative: () => {
            // The same CLI serializes a task continuation and this admitted send.
            previousTurn = { turnComplete: input.turnComplete, stopped: this.stoppedTurns.has(owner.run.runId), hook: this.turnHooks.get(owner.run.runId) };
            turnStarted = true;
            input.turnComplete = false; input.pendingUuids.add(uuid);
            this.stoppedTurns.delete(owner.run.runId);
            this.turnHooks.set(owner.run.runId, undefined);
            this.activities.get(owner.run.runId)?.running();
            current();
          },
          send: async (encoded, _setup, boundary) => {
            boundary.beforeNative(encoded);
            attempted = true;
            try { child.stdin.write(encoded); await child.stdin.flush(); }
            catch (error) { void this.terminate(owner); throw error; }
            boundary.outcome("submitted");
          },
        },
      });
      return { runId: owner.run.runId, messageId };
    } catch (error) {
      // A partial pipe write is not safe to retry or accept more input behind.
      if (attempted) void this.terminate(owner);
      else if (turnStarted && previousTurn) {
        // A synchronous refusal must not leave a UUID that never reached stdin
        // awaiting acknowledgement or strand the original background process.
        input.turnComplete = previousTurn.turnComplete; input.pendingUuids.delete(uuid);
        if (previousTurn.stopped) this.stoppedTurns.add(owner.run.runId);
        this.turnHooks.set(owner.run.runId, previousTurn.hook);
        if (input.turnComplete) this.activities.get(owner.run.runId)?.turnFinished();
        else this.activities.get(owner.run.runId)?.running();
      }
      throw error;
    } finally {
      input.sending = false;
      this.finishInput(owner);
      this.retainSubmissionTiming(owner, "liveInput", timing);
    }
  }
  private finishInput(owner: RunOwner) {
    const input = this.inputs.get(owner);
    // A session-level failure need not acknowledge a user UUID, but must still
    // close input so the CLI can settle instead of waiting for another prompt.
    if (!input || input.closed || input.sending || (!input.turnComplete && !input.result.error)) return;
    if (!input.result.error && this.activities.get(owner.run.runId)?.get().backgroundTaskCount) return;
    input.closed = true;
    void Promise.resolve().then(() => owner.child!.stdin.end()).catch(() => this.terminate(owner));
  }
  activity(owner: RunOwner): ConversationActivity | undefined {
    if (!this.deps.owns(owner)) return;
    const activity = this.activities.get(owner.run.runId)?.get()
      ?? { phase: owner.child ? "running" as const : "starting" as const, runId: owner.run.runId, startedAt: owner.run.createdAt, observedAt: owner.run.createdAt };
    if (this.deps.retained()) return { ...activity, phase: "unconfirmed" };
    if (owner.stopRequested || owner.cancelling || owner.stopping) return { ...activity, phase: "stopping" };
    if (owner.run.status !== "running" || owner.child?.exitCode != null) return { ...activity, phase: "finishing" };
    return activity;
  }
  followupPending(requestId: string): boolean { return [...this.followups.values()].some(queued => queued.input.requestId === requestId && !queued.cancelled); }
  cancelFollowup(sessionId: string): void { const queued = this.followups.get(sessionId); if (queued) queued.cancelled = true; }

  async queueFollowup(owner: RunOwner, prompt: string, configuration?: QueuedSendConfiguration): Promise<ClaudeQueuedFollowup> {
    if (!prompt.trim() || compactCommand(prompt)) throw new Error("Only ordinary nonempty prompts can be queued");
    if (!this.canQueueFollowup(owner)) throw new Error("Claude follow-up admission unavailable");
    const input: ClaudeQueuedFollowup = { requestId: this.runtime.randomUUID(), afterRunId: owner.run.runId, sessionId: owner.run.sessionId, prompt, ...(configuration ? { configuration: structuredClone(configuration) } : {}) };
    const queued: QueuedFollowup = { owner, input, persisted: Promise.resolve() };
    // Reserve synchronously, before journal I/O, so concurrent requests cannot
    // accept a second prompt. Do not project this as a submitted native turn.
    this.followups.set(input.sessionId, queued);
    try {
      queued.persisted = this.deps.emit(owner.run, "context", { source: "claude-followup", state: "queued", ...input });
      await queued.persisted; return { ...input };
    }
    catch (error) { if (this.followups.get(input.sessionId) === queued) this.followups.delete(input.sessionId); throw error; }
  }

  /** Bridge must keep a queued-input admission reservation until this promise
   * settles. `dispatch` must use normal launch/configuration validation, create
   * a NEW Run, and install its owner before native submission. Never call this
   * from execute's finally: owner.done also covers bridge release/cancellation.
   * Queued journal evidence is not a durable auto-retry instruction on restart. */
  drainQueuedFollowup(owner: RunOwner, dispatch: (input: ClaudeQueuedFollowup) => Promise<{ runId: string } | { notSubmitted: true }>): Promise<void> {
    const queued = this.followups.get(owner.run.sessionId);
    if (!queued || queued.owner !== owner) return Promise.resolve();
    if (queued.draining) return queued.draining;
    queued.draining = (async () => {
      await queued.persisted;
      await owner.done;
      // A Stop/result, child exit alone, or a cancelled/unconfirmed owner never
      // permits resume. Do not signal children here to make the queue eligible.
      if (queued.cancelled || !owner.settled || owner.cancelling || owner.stopRequested || owner.stopping || owner.run.status !== "completed"
        || !owner.child || owner.child.exitCode !== 0 || this.groupAlive(owner) || this.deps.owns(owner)
        || this.deps.closing() || this.deps.storageFailed() || this.deps.retained()) {
        if (!this.deps.storageFailed()) await this.deps.emit(owner.run, "context", { source: "claude-followup", state: "not-submitted", requestId: queued.input.requestId });
        return;
      }
      await this.deps.emit(owner.run, "context", { source: "claude-followup", state: "admitting", requestId: queued.input.requestId });
      if (queued.cancelled || this.deps.closing() || this.deps.storageFailed() || this.deps.retained()) {
        if (!this.deps.storageFailed()) await this.deps.emit(owner.run, "context", { source: "claude-followup", state: "not-submitted", requestId: queued.input.requestId });
        return;
      }
      try {
        const run = await dispatch({ ...queued.input });
        await this.deps.emit(owner.run, "context", "notSubmitted" in run
          ? { source: "claude-followup", state: "not-submitted", requestId: queued.input.requestId }
          : { source: "claude-followup", state: "dispatched", requestId: queued.input.requestId, runId: run.runId });
      } catch (error) {
        // Admission may have reached native submission before throwing. Never
        // silently retry this prompt; the normal launch journal is authoritative.
        if (!this.deps.storageFailed()) await this.deps.emit(owner.run, "context", { source: "claude-followup", state: "admission-unconfirmed", requestId: queued.input.requestId, error: message(error) });
        throw error;
      }
    })().finally(() => { if (this.followups.get(owner.run.sessionId) === queued) this.followups.delete(owner.run.sessionId); });
    return queued.draining;
  }

  private signal(owner: RunOwner, value: NodeJS.Signals) {
    const state = this.supervision.get(owner), child = state ? state.child : owner.child;
    if (!child) return;
    try { this.runtime.kill(-(state?.pid ?? child.pid), value); } catch { /* Signal delivery is not proof. */ }
    try { child.kill(value); } catch { /* Also cover the original direct child. */ }
  }

  terminate(owner: RunOwner): Promise<boolean> {
    if (owner.stopping) return owner.stopping;
    const state = this.supervision.get(owner), child = state ? state.child : owner.child;
    // Preparation can be stopped before spawn; do not cache a no-child result.
    if (!child) return Promise.resolve(true);
    if (state) state.termination = "pending";
    owner.stopping = (async () => {
      let exited = false;
      void child.exited.then(() => { exited = true; }, () => {});
      for (const value of ["SIGTERM", "SIGKILL"] as const) {
        this.signal(owner, value);
        for (let i = 0; i < 50; i++) { if (exited && !this.groupAlive(owner)) return true; await this.runtime.sleep(20); }
      }
      this.deps.requireReconciliation();
      return false;
    })().catch(() => { this.deps.requireReconciliation(); return false; });
    if (state) {
      state.terminationPromise = owner.stopping;
      void owner.stopping.then(confirmed => { state.termination = confirmed ? "confirmed" : "unconfirmed"; });
    }
    return owner.stopping;
  }

  /** HTTP method, loopback checks, decoding, and body limits stay in bridge.
   * Authentication/association and journal ingestion have one authority here. */
  async ingestHook(event: string, input: ClaudeHookInput, secret: string): Promise<ClaudeHookReply> {
    if (!(hookEvents as readonly string[]).includes(event)) return { status: 400, body: { error: "Unknown hook" } };
    const run = this.deps.run(input.runId), expected = this.secrets.get(input.runId as string);
    if (!run || !expected || run !== expected.supervised.run || run.runId !== expected.supervised.identity.runId
      || run.sessionId !== expected.supervised.identity.sessionId || !equal(secret, expected.secret)) return { status: 403, body: { error: "Forbidden" } };
    const payload = input.payload;
    const session = this.deps.session(run.sessionId);
    if (!session || session.harness !== "claude-code" && session.harness !== undefined || !this.sameOriginalSource(expected.supervised, session)
      || run.cwd !== expected.supervised.identity.cwd || !payload || typeof payload !== "object" || (payload as Record<string, unknown>).hook_event_name !== event
      || (payload as Record<string, unknown>).session_id !== expected.supervised.identity.nativeSessionId) return { status: 400, body: { error: "Hook association mismatch" } };
    // Publish root hook state in receipt order before starting journal I/O.
    // Stop becomes queueable only after its own durable write finishes; a later
    // activity hook invalidates that publication even while Stop is persisting.
    const root = isClaudeRootRecord(payload);
    if (root && (event === "UserPromptSubmit" || event === "PreToolUse")) this.stoppedTurns.delete(run.runId);
    const stop = root && event === "Stop" ? Symbol() : undefined;
    if (root && (stop || event === "UserPromptSubmit" || event === "PreToolUse")) this.turnHooks.set(run.runId, stop);
    await this.deps.emit(run, "hook", { event, payload });
    this.activities.get(run.runId)?.hook(event, payload);
    if (stop && this.turnHooks.get(run.runId) === stop && run.status === "running") this.stoppedTurns.add(run.runId);
    return { status: 200, body: { ok: true } };
  }

  private async consume(owner: RunOwner, run: Run, nativeSessionId: string, stream: ReadableStream<Uint8Array>, kind: "stdout" | "stderr", result: Result) {
    const reader = stream.getReader(); const decoder = new TextDecoder(); let pending = "";
    const line = async (text: string) => {
      if (!text) return;
      let data: any = text;
      if (kind === "stdout") {
        try { data = JSON.parse(text); } catch {}
        // stdout and hook HTTP have independent delivery ordering. An assistant
        // record can be the final reply preceding an already-received Stop, so
        // do not revoke that hook based on stdout text. Root activity hooks do.
        if (isClaudeRootRecord(data) && data?.session_id === nativeSessionId && data?.type === "system" && data.subtype === "task_notification") {
          this.stoppedTurns.delete(run.runId); this.turnHooks.set(run.runId, undefined);
        }
        const observation = consumeClaudeResultRecord(result, data, nativeSessionId);
        // Retain historical framework decoding without requiring new delivery.
        if (observation.frameworkRejected || result.integrityRejected) void this.terminate(owner);
      }
      else result.stderr = (result.stderr + text + "\n").slice(-resultTextLimit);
      await this.deps.emit(run, kind, data);
      if (kind === "stdout") {
        const activity = this.activities.get(run.runId);
        activity?.stdout(data, nativeSessionId);
        if (isClaudeRootRecord(data) && data?.type === "result" && data.session_id === nativeSessionId) {
          const input = this.inputs.get(owner);
          // A background continuation can finish while a user send is pending.
          // Resume can also emit a task-notification result BEFORE the initial
          // command starts. Missing UUIDs never acknowledge a pending prompt,
          // even the initial one; every streamed prompt carries our UUID. A
          // synthetic turn may consume queued user input, so match its echoed
          // UUIDs rather than rejecting all task-origin results.
          const acknowledged = new Set([data.user_message_uuid, ...(Array.isArray(data.user_message_uuids) ? data.user_message_uuids : [])]);
          const answersInput = !input?.pendingUuids.size || [...input.pendingUuids].some(uuid => acknowledged.has(uuid));
          if (answersInput) {
            if (input) {
              for (const uuid of acknowledged) input.pendingUuids.delete(uuid);
              input.turnComplete = input.pendingUuids.size === 0 && !(data.queued_turn_count > 0);
            }
            if (!input || input.turnComplete) activity?.turnFinished();
          }
          this.finishInput(owner);
        }
      }
    };
    while (true) { const { value, done } = await reader.read(); if (done) break; pending += decoder.decode(value, { stream: true }); let at: number; while ((at = pending.indexOf("\n")) >= 0) { await line(pending.slice(0, at)); pending = pending.slice(at + 1); } if (pending.length > 1024 * 1024) { await line(pending); pending = ""; } }
    pending += decoder.decode(); await line(pending);
  }

  /** Native causes for a failed run: the non-success result and an undelivered framework. */
  private failure(result: Result): Record<string, unknown> {
    return { ...result.failure, ...(result.framework?.rejected ? { sessionStartFailures: result.framework.failures } : {}) };
  }

  async execute(owner: RunOwner, prompt: string, resume: boolean, ready: (accepted: boolean) => void): Promise<void> {
    const run = owner.run, deps = this.deps, runtime = this.runtime;
    if (this.supervision.has(owner)) throw new Error("Original Claude supervision cannot be replaced or replayed");
    owner.nativeDispatched = false;
    const runId = run.runId, sessionId = run.sessionId, cwd = run.cwd;
    const sessionAtEntry = deps.session(sessionId), operation = run.operation, model = run.model, effort = run.effort, dispatchEvidence = owner.dispatchEvidence;
    const contextMessages = operation === "compact" ? undefined : owner.contextMessages;
    const contextIdentity = operation === "compact" ? undefined : owner.contextIdentity;
    const submissionPublication = operation === "compact" ? undefined : owner.submissionPublication;
    const source = Object.freeze({ harness: sessionAtEntry?.harness, authorityId: sessionAtEntry?.authorityId, nativeSessionId: sessionAtEntry?.nativeSessionId ?? null, cwd: sessionAtEntry?.cwd });
    // Bridge creation normally preallocates the native UUID. Legacy new-session
    // callers without one use this run's UUID, never an ID selected by stdout.
    const nativeSessionId = source.nativeSessionId ?? (!resume ? runId : null);
    const supervised: Supervision = { owner, run, identity: Object.freeze({ runId, sessionId, nativeSessionId, cwd }),
      source, newNativeAssigned: false, preparing: true,
      nativeAttempted: false, exitObserved: false, exitCode: null, exitSignal: null, termination: "not-requested", streamsDrained: false, finished: false, valid: true, terminal: null };
    this.supervision.set(owner, supervised);
    const states = this.supervised.get(sessionId) ?? new Set<Supervision>(); states.add(supervised); this.supervised.set(sessionId, states);
    const assertSource = () => {
      const session = deps.session(sessionId);
      if (owner.run !== run || run.runId !== runId || run.sessionId !== sessionId || run.cwd !== cwd
        || source.harness !== undefined && source.harness !== "claude-code"
        || !nativeSessionId || !session || !this.sameOriginalSource(supervised, session)) {
        supervised.valid = false;
        throw new HarnessDispatchError("dispatch-source-mismatch", "Original Claude conversation source changed during execution");
      }
      return session;
    };
    const assertContextOwner = () => {
      assertSource();
      if (!contextMessages || !contextIdentity || owner.contextMessages !== contextMessages || owner.contextIdentity !== contextIdentity
        || contextIdentity.runId !== runId || contextIdentity.source.harnessId !== "claude-code"
        || contextIdentity.source.sessionId !== sessionId || contextIdentity.source.authorityId !== (source.authorityId ?? null)
        || contextIdentity.source.nativeSessionId !== nativeSessionId || contextIdentity.source.cwd !== cwd) throw new Error("Original Claude context owner identity is unavailable or changed");
    };
    const assertDispatchCurrent = () => {
      assertSource();
      if (operation !== "compact") {
        assertContextOwner();
        if (!dispatchEvidence || owner.dispatchEvidence !== dispatchEvidence) throw new Error("Original Claude dispatch evidence is unavailable or changed");
        // Publication replacement denies new native effects, never original outcomes.
        if (owner.submissionPublication !== submissionPublication) throw new Error("Original Claude submission publication changed");
      }
      if (deps.closing() || deps.storageFailed() || deps.retained() || owner.stopRequested || owner.cancelling || owner.stopping || owner.settled || !deps.owns(owner)) throw new Error("Context message preparation cancelled");
    };
    // Keep setup awaits cheap, but freshly guard source/owner/cancellation on
    // both sides. Terminal/cleanup writes retain only the original source pin.
    const assertPreparationCurrent = () => {
      if (supervised.preparing) assertDispatchCurrent();
      else assertSource();
    };
    const prepare = async <T>(action: () => Promise<T>): Promise<T> => {
      assertPreparationCurrent();
      try { return await action(); } finally { assertPreparationCurrent(); }
    };
    const classify = (status: "completed" | "failed" | "interrupted", cause: ClaudeTerminalCause) => {
      supervised.terminal = Object.freeze({ status, cause });
      run.status = status;
      this.validSupervision(supervised); // A contradictory DTO setter cannot mint proof.
    };
    const updateSession = () => {
      const session = deps.session(sessionId);
      if (session && this.sameOriginalSource(supervised, session)) session.lastStatus = supervised.terminal!.status;
      else supervised.valid = false;
    };
    const result: Result = { ...createClaudeResultSequenceState(), stderr: "" };
    const activity = new ClaudeActivity(runId, run.createdAt);
    this.activities.set(runId, activity);
    let streams: Promise<unknown>[] = [], intentWritten = false;
    const mode = owner.nativeDeliveryPolicy === "native-queued-handoff" || owner.nativeQueuedHandoff ? "queued-handoff"
      : run.nativeDelivery === "queue" ? "queued" : owner.nativeDeliveryPolicy === "idle-only" ? "idle-only" : "initial";
    const timing = operation === "compact" ? undefined : createRunSubmissionTiming({ harness: "claude-code", mode });
    try {
      assertSource();
      const identity = snapshotIdentity(run), agent = run.agent, saneContextVersion = run.saneContextVersion;
      if (operation !== "compact" && compactCommand(prompt)) throw new Error("Use the dedicated Compact action; compaction cannot be submitted as an ordinary prompt");
      const checkExecution = async (steps: RunSubmissionPreparationSteps) => {
        if (await steps.step("execution.resolve", () => operation === "compact" ? deps.compactExecution(assertSource()) : deps.execution(sessionId)) !== cwd) {
          supervised.valid = false;
          throw new HarnessDispatchError("dispatch-source-mismatch", "Original Claude execution checkout changed during preparation");
        }
      };
      const setupLaunch = async (_payload: string, steps: RunSubmissionPreparationSteps): Promise<ClaudeLaunchSetup> => {
        await checkExecution(steps);
        const secret = runtime.randomUUID() + runtime.randomUUID(); this.secrets.set(runId, { secret, supervised });
        const hooks: Record<string, { hooks: { type: "command"; command: string; timeout: number }[] }[]> = Object.fromEntries(hookEvents.map(event => [event, [{ hooks: [{ type: "command", command: `${quote(runtime.execPath)} ${quote(join(this.options.packageRoot, "hooks/forward.ts"))} ${quote(event)}`, timeout: 3 }] }]]));
        const executionPolicy = await steps.step("execution.configure", async () => await deps.canonicalExecution?.(sessionId) ?? null);
        if (executionPolicy && (!identity || executionPolicy.policy.spec.name !== `sane/${identity.kind}/${identity.role}`)) throw new Error("Canonical execution role differs from the run");
        const privateExecution = executionPolicy ? claudeExecutionConfiguration({ policy: executionPolicy.policy, children: executionPolicy.children, protocol: deps.explicitProtocol?.(sessionId) }) : undefined;
        let claudeVersion: string | null = null;
        if (privateExecution) {
          claudeVersion = await steps.step("native.inspect", () => runtime.version!(this.options.claudeBin));
          const version = /^(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(claudeVersion);
          if (!version || Number(version[1]) < 2 || Number(version[1]) === 2 && (Number(version[2]) < 1 || Number(version[2]) === 1 && Number(version[3]) < 281)) throw new AgentLaunchConfigurationError("Canonical execution requires Claude Code 2.1.281 or newer");
        }
        if (identity && !privateExecution) throw new AgentLaunchConfigurationError("SANE Claude roles require canonical execution configuration");
        // Base sessions grant parent messaging without inheriting bridge context.
        const ccAgent = privateExecution?.agent, permissions = privateExecution?.permissions ?? { allow: ["mcp__sane__sane_worker_message"] };
        const session = assertSource();
        // Browser MCP is a Claude launch argument, not a pinned policy or a shared Stop control.
        // Compact, workers, and an omitted harness do not receive it. Tool names are visible
        // only on the synthetic Base allow list; canonical permissions stay byte-stable.
        const browserMcp = operation !== "compact" && session.harness === "claude-code" && session.agentKind !== "worker" && deps.browserMcp
          ? await steps.step("transport.setup", () => { assertSource(); return deps.browserMcp!(sessionId, runId); })
          : null;
        assertSource();
        const launchPermissions = browserMcp && !privateExecution
          ? { allow: [...(Array.isArray(permissions.allow) ? permissions.allow : []), ...browserMcp.allowedTools] }
          : permissions;
        const settingsPath = join(this.options.dataDir, `${runId}.settings.json`);
        const settings = JSON.stringify({ hooks, ...(launchPermissions ? { permissions: launchPermissions } : {}) });
        await steps.step("transport.setup", () => deps.enqueue(() => runtime.writeSettings(settingsPath, settings)));
        const args = [this.options.claudeBin, "-p", "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--verbose", resume ? "--resume" : "--session-id", nativeSessionId!, "--settings", settingsPath];
        if (operation !== "compact") args.push("--input-format", "stream-json");
        if (browserMcp) args.push("--mcp-config", browserMcp.mcpConfigPath);
        if (privateExecution) args.push(...privateExecution.args);
        // Never revive an old system-context snapshot on a canonical SANE resume.
        if (resume && privateExecution) args.push("--system-prompt-snapshot", "off");
        if (model !== undefined) args.push("--model", model);
        if (effort !== undefined) args.push("--effort", effort);
        const env = Object.fromEntries(Object.entries(runtime.env).filter(([name, value]) => value !== undefined && !/^(CC_WEB_|OPENCODE_SERVER_|OPENCODE_SESSION_ID$|OPENCODE_TOKEN$|SANE_|BUN_INSPECT|NODE_OPTIONS$)/i.test(name))) as Record<string, string>;
        const context = await steps.step("execution.resolve", () => deps.executionContext(sessionId));
        return { args, options: {
          cwd, detached: true, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...env, CLAUDE_CONFIG_DIR: this.options.claudeRoot, CLAUDE_CODE_PROJECT_DIR_NAME: "", CC_WEB_HOOK_URL: this.options.hookUrl(), CC_WEB_RUN_ID: runId, CC_WEB_HOOK_SECRET: secret, CC_WEB_HOOK_ERRORS: join(this.options.dataDir, `${runId}.hook-errors.jsonl`) },
        }, launch: {
          harness: "claude-code", resume, operation: operation ?? "prompt", workstreamId: context.workstreamId, workstreamRoot: context.artifactsRoot, implementationRoot: cwd,
          agent: agent ?? null, saneContextVersion: saneContextVersion ?? null, args: [...args], claudeVersion,
          ...(executionPolicy ? { executionPolicy: { revision: executionPolicy.revision, agent: ccAgent, nativeRoleRegistration: false, policyTranslation: privateExecution!.policyTranslation } } : {}),
          agentFile: null, settings: { path: settingsPath, sha256: sha256(settings) },
        } };
      };
      const beforeLaunch = () => {
        deps.assertWorkerDeliverySubmission(owner);
        assertDispatchCurrent();
        synchronousDispatchHook(() => owner.beforeSend?.());
        assertDispatchCurrent();
      };
      const beforeIntent = () => {
        // SessionStart can execute at spawn, before any stdin message arrives.
        try { synchronousDispatchHook(() => dispatchEvidence?.beforeNative()); }
        finally { supervised.preparing = false; }
        intentWritten = !!dispatchEvidence;
      };
      const startLaunch = (encoded: string, setup: ClaudeLaunchSetup, beforeNative: (wire: string) => void, outcome: () => void) => {
        beforeNative(encoded);
        assertDispatchCurrent();
        supervised.nativeAttempted = true; owner.nativeDispatched = true;
        const child = runtime.spawn(setup.args, setup.options);
        owner.child = child;
        supervised.child = child; supervised.pid = child.pid;
        void child.exited.then(exit => {
          supervised.exitObserved = true; supervised.exitCode = exit;
          supervised.exitSignal = (child as unknown as { signalCode?: string | number | null }).signalCode ?? null;
        }, () => {});
        activity.running(); ready(true);
        streams = [this.consume(owner, run, nativeSessionId!, child.stdout, "stdout", result), this.consume(owner, run, nativeSessionId!, child.stderr, "stderr", result)];
        const output = Promise.all([child.exited, ...streams]);
        void output.catch(() => {});
        if (operation !== "compact") this.inputs.set(owner, { closed: false, sending: false, turnComplete: false, pendingUuids: new Set([runId]), result, contextMessages: contextMessages!, contextIdentity: contextIdentity! });
        child.stdin.write(encoded);
        // Retain these promises for lifecycle supervision outside preparation.
        const submitted = Promise.resolve(operation === "compact" ? child.stdin.end() : child.stdin.flush()).then(outcome);
        void submitted.catch(() => {});
        return { output, submitted };
      };
      let started: ReturnType<typeof startLaunch>;
      if (operation === "compact") {
        // Compaction is a native non-message operation, not an ordinary prompt.
        const steps: RunSubmissionPreparationSteps = { assertCurrent: assertPreparationCurrent, step: (_stage, action) => prepare(action) };
        await prepare(() => deps.emit(run, "status", { status: "running" }));
        await prepare(() => deps.persist());
        const setup = await setupLaunch(prompt, steps);
        await prepare(() => deps.emit(run, "launch", setup.launch));
        await checkExecution(steps);
        started = startLaunch(prompt, setup, () => { beforeLaunch(); beforeIntent(); }, () => dispatchEvidence?.outcome("submitted"));
      } else {
        const messageId = `${runId}:user`;
        started = await coordinateRunSubmission({
          mode, request: { messageId, body: prompt, boundary: "run-initial", ...(run.queuedFollowupId ? { queuedFollowupId: run.queuedFollowupId } : {}) },
          contextMessages: contextMessages!, evidence: dispatchEvidence!,
          assertCurrent: assertDispatchCurrent, assertObservationCurrent: assertContextOwner, failClosed: () => deps.failClosed(), publication: submissionPublication, timing,
          journal: { status: () => deps.emit(run, "status", { status: "running" }),
            submission: submission => deps.emit(run, "submission", submission), launch: (_packet, setup) => deps.emit(run, "launch", setup.launch) },
          // CC launch evidence has no new metadata phase; retain the existing publication.
          publishMetadata: phase => phase === "submission" ? deps.persist() : Promise.resolve(),
          native: {
            capabilities: { initial: { supported: true }, "idle-only": { supported: true } },
            encode: text => {
              const encoded = JSON.stringify({ type: "user", uuid: runId, session_id: nativeSessionId,
                message: { role: "user", content: text }, parent_tool_use_id: null }) + "\n";
              return { payload: encoded, readActual: () => { assertContextOwner(); return readContextLine(encoded, runId, nativeSessionId!, messageId, contextIdentity!); },
                assertWire: wire => { if (wire !== encoded) throw new Error("Claude context wire changed"); } };
            },
            setup: setupLaunch,
            preflight: (_packet, _setup, steps) => checkExecution(steps),
            beforeNative: beforeLaunch,
            onIntentRecorded: () => { intentWritten = true; supervised.preparing = false; },
            send: (encoded, setup, boundary) => startLaunch(encoded, setup, boundary.beforeNative, () => boundary.outcome("submitted")),
          },
        });
      }
      const [exit] = await Promise.all([started.output.then(values => values[0] as number), started.submitted]);
      activity.finishing();
      if (this.groupAlive(owner) && !(await this.terminate(owner))) throw new Error("Process group termination unconfirmed");
      assertSource();
      const closing = deps.closing(), stopRequested = owner.stopRequested, storageFailed = deps.storageFailed();
      const exitSignal = supervised.exitSignal, exitedNormally = exit === 0 && exitSignal === null;
      const status = closing || stopRequested ? "interrupted" : !storageFailed && exitedNormally && result.seen && !result.error ? "completed" : "failed";
      const cause = closing ? "service-closing" : stopRequested ? "stop-requested" : storageFailed ? "storage-failure" : exitSignal !== null ? "signal-exit" : exit !== 0 ? "nonzero-exit" : result.framework?.rejected ? "framework-rejected" : !result.seen ? "missing-result" : result.error ? "result-failure" : "result-success";
      if (!resume && supervised.source.nativeSessionId === null && result.seen && !result.integrityRejected) {
        assertSource().nativeSessionId = nativeSessionId!;
        supervised.newNativeAssigned = true;
      }
      classify(status, cause);
      run.endedAt = new Date().toISOString(); updateSession();
      const compact = operation === "compact" ? projectCompactions(assertSource(), [run], deps.events(runId))[0] : undefined;
      const failure = status !== "failed" ? {} : { ...this.failure(result), ...(!exitedNormally ? { error: result.stderr.trim() || (exitSignal !== null ? `CLI terminated by signal ${exitSignal}` : `CLI exited with code ${exit}`) } : {}) };
      await prepare(() => deps.emit(run, "status", { status, exitCode: exit, resultSeen: result.seen, ...(compact ? { compactionLifecycle: compact.lifecycle, reason: compact.lifecycle === "unconfirmed" ? "CLI ended without native compaction outcome evidence; do not automatically resend" : "CLI process ended; compaction outcome is reported separately by native evidence" } : result.diagnostic ? { reason: result.diagnostic } : {}), ...failure }));
    } catch (error) {
      supervised.preparing = false;
      if (dispatchEvidence && (intentWritten || supervised.nativeAttempted)) dispatchEvidence.outcome("unknown");
      if (error instanceof AgentLaunchConfigurationError) owner.launchError = error.message;
      const stopped = await this.terminate(owner);
      const closing = deps.closing(), stopRequested = owner.stopRequested, storageFailed = deps.storageFailed();
      const status = stopped && (closing || stopRequested) ? "interrupted" : "failed";
      classify(status, !stopped ? "termination-unconfirmed" : closing ? "service-closing" : stopRequested ? "stop-requested" : storageFailed ? "storage-failure" : "launch-stream-shutdown-failure");
      run.endedAt = new Date().toISOString(); updateSession();
      try { await deps.emit(run, "status", { status, ...(operation === "compact" && !supervised.child && !intentWritten && !supervised.nativeAttempted ? { operation: "compact", compactNotSubmitted: true } : {}), reason: !stopped ? "Process termination unconfirmed; operator reconciliation required" : storageFailed ? "Storage failure; operator reconciliation required" : owner.launchError ?? "CLI launch, stream, or shutdown failure", ...(!stopped ? { termination: { kind: "unconfirmed", cause: "process-group" } satisfies TerminationUncertainty } : {}), error: message(error), ...(error instanceof HarnessDispatchError ? { code: error.code } : {}), ...this.failure(result) }); } catch { deps.failClosed(); }
      ready(false);
    } finally {
      ready(false);
      if (!intentWritten && !supervised.nativeAttempted) dispatchEvidence?.withheld();
      // Retain the sentinel if either consumer cannot finish within the bound.
      const drained = await Promise.race([Promise.allSettled(streams).then(results => (!supervised.child || results.length === 2) && results.every(result => result.status === "fulfilled")), runtime.sleep(2200).then(() => false)]);
      owner.streamsDrained = drained;
      supervised.streamsDrained = drained;
      if (!drained) deps.requireReconciliation();
      run.endedAt = new Date().toISOString(); updateSession();
      try {
        if (operation === "compact" && supervised.child && drained && !deps.retained() && !deps.closing() && !deps.storageFailed() && this.validSupervision(supervised)) await prepare(() => deps.refreshCompactHistory(owner));
        if (owner.workerDeliveryId && !supervised.child && !intentWritten && !supervised.nativeAttempted) await deps.emit(run, "status", { status: supervised.terminal!.status, workerDeliveryNotSubmitted: owner.workerDeliveryId });
        // Persist cleanup even after a denied source, but never certify that
        // replacement source as this lifecycle's original capability.
        this.validSupervision(supervised);
        await deps.persist();
      } catch { deps.failClosed(); }
      this.validSupervision(supervised);
      this.secrets.delete(runId);
      this.stoppedTurns.delete(runId);
      this.turnHooks.delete(runId);
      this.activities.delete(runId);
      this.inputs.delete(owner);
      supervised.finished = true;
      this.retireSupervision(supervised);
      if (timing) this.retainSubmissionTiming(owner, "initial", timing);
    }
  }
}
