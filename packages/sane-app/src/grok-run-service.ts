import { constants } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Writable } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import { normalizeNativeSource } from "sane-core/server";
import type {
  AutomationDispatchOrigin, DispatchOrigin, DispatchReadiness, DispatchSource, DispatchTerminalGuards, PinnedDispatchReadiness,
} from "../shared/conversation/dispatch-contract";
import type { AdmissionService } from "./admission";
import type { Admission } from "./app-store";
import { synchronousDispatchHook } from "./dispatch-evidence";
import {
  createGrokDispatchAdapter, grokDispatchObservation, stopGrokDispatch,
  type GrokDispatchAdapter, type GrokDispatchAdapterOptions, type GrokTurnObservation,
} from "./grok-adapter";
import { sameDispatchSource, terminalDispatchReadiness, type HarnessDispatchAdapter } from "./harness-dispatch";
import { uuid, type Event, type Run, type Session, type Status } from "./history";
import { bindRunControls, type OwnedRunControls, type RunControlOperations } from "./run-controls";
import type { RunOwner } from "./run-owner";
import { coordinateRunSubmission } from "./run-submission-preparation";
import { createGrokNativeRuntime, installGrokNativeRuntime } from "./grok-native-runtime";
import { compactGrokSession, GrokAcpCompactionError, GrokAcpRpcError, type GrokAcpCloseEvidence, type GrokAcpCompactionResult } from "./grok-acp";
import { grokCompactResultMetadata } from "./grok-compaction-result";
import { grokSessionExists } from "./grok-native-history";
import { grokCompactRequest } from "./grok-native-history";
import type { CompactionMetadata } from "./oc-contract";

/** Actual UTF-8 --prompt-file encoding, not a Claude stream-json input message. */
export type GrokPromptFilePacket = Readonly<{ encoding: "grok-prompt-file"; text: string }>;
export type GrokCompactRunObservation = Readonly<{
  status: Status; submission: "not-submitted" | "submitted" | "unknown"; nativeAcceptance: "unknown";
  nativeSessionId: string; result?: unknown; process?: GrokAcpCloseEvidence;
  compaction?: CompactionMetadata; refreshHistory: boolean;
}>;

export type GrokRunServicePorts<Owner extends RunOwner> = Pick<GrokDispatchAdapterOptions,
  "executable" | "homeRoot" | "toolPath" | "spawn" | "timeoutMs" | "executableReady"> & {
  promptDirectory: string;
  /** Existing authenticated native-handoff.json; never a new authority grant. */
  appConnectionFile?: string;
  /** Private directory shared with bridge proof verification for live runs. */
  bindingDirectory?: string;
  session: (id: string) => Session | undefined;
  /** Read the bridge's existing owner registry; this service never replaces it. */
  owner: (id: string) => Owner | undefined;
  admissions: Pick<AdmissionService, "get" | "getGrokSourcePin">;
  /** Use the existing serialized journal/publication queue. stdout/stderr are raw text. */
  append: (run: Run, kind: Event["kind"], data: unknown) => void | Promise<void>;
  persist: () => Promise<void>;
  assertOpen: () => void;
  failClosed: (error: unknown) => void;
  /** Mirror terminal status to Session metadata and append its standard status event. */
  updateStatus: (owner: Owner, status: Status, reason?: string) => Promise<void>;
  /** Optional additional synchronous catalog/checkout validation at native launch. */
  assertBinding?: (admission: Admission) => void;
};

type ManagedRun<Owner extends RunOwner> = {
  owner: Owner;
  processing: ReturnType<typeof Promise.withResolvers<void>>;
  executing: boolean;
  finished: boolean;
  successful: boolean;
  invalid: boolean;
  drained: boolean;
  adapter?: GrokDispatchAdapter<Owner>;
  source?: DispatchSource;
  original?: { run: Run; done: Promise<void>; runId: string; configuration: string };
  stdout?: Writable;
  stderr?: Writable;
  captureFailure?: unknown;
  drain?: Promise<boolean>;
  operations?: RunControlOperations;
  controls?: OwnedRunControls;
  compact?: {
    controller: AbortController;
    closed?: Promise<GrokAcpCloseEvidence>;
    evidence?: GrokAcpCloseEvidence;
    journal: Promise<void>;
    observation?: GrokCompactRunObservation;
  };
};

const automaticOrigins = ["queued-user", "questionnaire-response", "worker-report", "worker-exchange", "handoff"] as const satisfies readonly AutomationDispatchOrigin[];
const automation = Object.freeze(Object.fromEntries(automaticOrigins.map(origin => [origin, Object.freeze({ supported: true as const })])) as Record<AutomationDispatchOrigin, Readonly<{ supported: true }>>);
const authorityPattern = /^sane-native-v1:gk:[a-f0-9]{64}$/;
const absolute = (value: unknown): value is string => typeof value === "string" && isAbsolute(value) && !value.includes("\0");
const denied = (reason: string, code = "grok-dispatch-unproven"): DispatchReadiness => ({ ready: false, reason, code });
const reason = (error: unknown): string => error instanceof Error ? error.message : "Grok run failed";
const sourceOf = (session: Session): DispatchSource => ({ harnessId: session.harness ?? "", sessionId: session.sessionId,
  authorityId: session.authorityId ?? null, nativeSessionId: session.nativeSessionId ?? null, cwd: session.cwd });
const configuration = (session: Session | Run): string => JSON.stringify([session.model, session.effort, session.profileId,
  session.agent, session.agentKind, session.nativeAgentSelected, session.saneExecution,
  "saneContext" in session ? session.saneContext : undefined]);

/** Managed, serial headless execution for the shared dispatch pipeline. The
 * bridge retains admission, owner acquisition/release, reconciliation and wake.
 * Local records below supervise original processes only; none authorizes replay. */
export class GrokRunService<Owner extends RunOwner = RunOwner> {
  readonly id = "grok";
  readonly automation = automation;
  /** Plain bound callbacks: safe for HarnessDispatchRegistry's snapshot/spread. */
  readonly adapter: HarnessDispatchAdapter<Owner>;
  private readonly runs = new WeakMap<Owner, ManagedRun<Owner>>();
  private readonly processes = new Set<ManagedRun<Owner>>();

  constructor(private readonly ports: GrokRunServicePorts<Owner>) {
    if (ports.appConnectionFile && ports.bindingDirectory) installGrokNativeRuntime({ appConnectionFile: ports.appConnectionFile, bindingDirectory: ports.bindingDirectory });
    this.adapter = Object.freeze({
      id: this.id, automation: this.automation,
      readiness: (source, origin) => this.readiness(source, origin),
      execute: (owner, prompt, resume, ready) => this.execute(owner, prompt, resume, ready),
      successfulSettlement: (owner, source, guards) => this.successfulSettlement(owner, source, guards),
    });
  }

  private state(owner: Owner): ManagedRun<Owner> {
    let state = this.runs.get(owner);
    if (!state) {
      state = { owner, processing: Promise.withResolvers<void>(), executing: false, finished: false, successful: false, invalid: false, drained: false };
      this.runs.set(owner, state);
    }
    return state;
  }

  private admission(source: DispatchSource): Admission {
    this.ports.assertOpen();
    if (source.harnessId !== "grok" || !source.authorityId || !authorityPattern.test(source.authorityId)
      || !uuid(source.nativeSessionId) || !absolute(source.cwd)) throw new Error("Grok dispatch source is unresolved or invalid");
    const session = this.ports.session(source.sessionId);
    if (!session || !sameDispatchSource(sourceOf(session), source)) throw new Error("Grok conversation source changed");
    const admission = this.ports.admissions.get(source.sessionId), pin = this.ports.admissions.getGrokSourcePin();
    if (!admission || admission.sessionId !== source.sessionId || admission.state !== "ready" || admission.nativeId !== source.nativeSessionId
      || admission.binding.executionCheckout !== source.cwd || admission.source.descriptor.harness !== "gk"
      || admission.source.authorityId !== source.authorityId || !pin || pin.authorityId !== source.authorityId
      || !isDeepStrictEqual(admission.source.descriptor, pin.descriptor) || pin.descriptor.homeRoot !== this.ports.homeRoot) {
      throw new Error("Grok dispatch requires its exact ready admission and configured source pin");
    }
    return admission;
  }

  async readiness(source: DispatchSource, _origin: DispatchOrigin): Promise<PinnedDispatchReadiness> {
    try {
      this.admission(source);
      if (!absolute(this.ports.executable) || !absolute(this.ports.promptDirectory)) return { source, readiness: denied("Grok executable and prompt directory must be absolute") };
      if (this.ports.executableReady) await this.ports.executableReady();
      else {
        if (!(await stat(this.ports.executable)).isFile()) throw new Error("Grok executable is not a regular file");
        await access(this.ports.executable, constants.X_OK);
      }
      this.admission(source);
      if (this.ports.owner(source.sessionId) || this.ports.session(source.sessionId)?.lastStatus === "running" || this.busy(source)) return { source, readiness: denied("Grok still has an owned or unresolved local run", "grok-busy") };
      return { source, readiness: { ready: true } };
    } catch (error) { return { source, readiness: denied(reason(error), "dispatch-source-mismatch") }; }
  }

  private busy(source: DispatchSource, original?: ManagedRun<Owner>): boolean {
    return [...this.processes].some(state => state !== original && state.source && (state.source.sessionId === source.sessionId
      || state.source.authorityId === source.authorityId && state.source.nativeSessionId === source.nativeSessionId));
  }

  /** Matches other run services for bridge code that already calls bindRunControls. */
  controlOperations(owner: Owner): RunControlOperations {
    const state = this.state(owner);
    return state.operations ??= Object.freeze({
      cancellation: "in-flight" as const,
      interrupt: async () => ({ interrupted: await this.stop(state) }),
      cleanup: () => this.stop(state),
      shutdown: async () => {
        const drained = await this.stop(state);
        return { drained, reconciliationRequired: !drained };
      },
    });
  }

  /** Convenience for integrations which do not already bind controls themselves. */
  controls(owner: Owner): OwnedRunControls {
    const state = this.state(owner);
    if (state.controls) { state.controls.assertOwner(owner); return state.controls; }
    const source = owner.contextIdentity?.source ?? (this.ports.session(owner.run.sessionId) && sourceOf(this.ports.session(owner.run.sessionId)!));
    if (!source || source.harnessId !== "grok") throw new Error("Grok controls require their original source");
    return state.controls = bindRunControls(owner, source, this.controlOperations(owner));
  }

  observation(owner: Owner): GrokTurnObservation | undefined {
    const adapter = this.runs.get(owner)?.adapter;
    return adapter ? grokDispatchObservation(adapter, owner) : undefined;
  }

  compactObservation(owner: Owner): GrokCompactRunObservation | undefined {
    return this.runs.get(owner)?.compact?.observation;
  }

  private compactDrained(state: ManagedRun<Owner>): boolean {
    const compact = state.compact, process = compact?.evidence;
    let groupGone = process?.processGroupGone === true;
    if (process?.processGroupId) {
      try { globalThis.process.kill(-process.processGroupId, 0); groupGone = false; }
      catch (error) { groupGone = (error as NodeJS.ErrnoException).code === "ESRCH"; }
    }
    // A missing process record is safe only for a genuine pre-spawn failure.
    state.drained = !state.captureFailure && (!process ? !compact?.closed : process.closeObserved && groupGone
      && (process.stdoutEnded || process.stdoutClosed) && (process.stderrEnded || process.stderrClosed));
    state.owner.streamsDrained = state.drained;
    if (state.drained) this.processes.delete(state);
    return state.drained;
  }

  private async stop(state: ManagedRun<Owner>): Promise<boolean> {
    state.owner.stopRequested = true;
    state.compact?.controller.abort();
    if (state.adapter) stopGrokDispatch(state.adapter, state.owner);
    // No execution has started; the original owner's stop fence prevents it later.
    if (!state.executing) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        state.processing.promise.then(() => state.compact ? this.compactDrained(state) : state.drained),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 2_500); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  private sink(state: ManagedRun<Owner>, kind: "stdout" | "stderr", associate: () => void): Writable {
    const decoder = new StringDecoder("utf8");
    const run = state.owner.run;
    const append = async (text: string) => { if (text) { associate(); await this.ports.append(run, kind, text); } };
    const sink = new Writable({
      write: (chunk: Buffer, _encoding, callback) => { void append(decoder.write(chunk)).then(() => callback(), error => callback(error)); },
      final: callback => { void append(decoder.end()).then(() => callback(), error => callback(error)); },
    });
    sink.on("error", error => {
      state.captureFailure ??= error;
      try { this.ports.failClosed(error); } catch { /* Keep the original capture failure. */ }
    });
    return sink;
  }

  private drain(state: ManagedRun<Owner>): Promise<boolean> {
    return state.drain ??= (async () => {
      if (state.adapter) await state.adapter.closed(state.owner);
      await Promise.all([state.stdout, state.stderr].map(sink => {
        if (!sink || sink.writableFinished) return Promise.resolve();
        if (sink.destroyed) return Promise.reject(state.captureFailure ?? new Error("Grok capture stream was destroyed"));
        return new Promise<void>((resolve, reject) => { sink.once("finish", resolve); sink.once("error", reject); sink.end(); });
      }));
      const observed = this.observation(state.owner);
      state.drained = !state.captureFailure && (!observed || observed.submission === "not-submitted" || observed.wrapperCompletion === "closed");
      state.owner.streamsDrained = state.drained;
      // Capture/publication invalidity is not a live process. Only an actually
      // unresolved child remains in the process registry after close/drain.
      if (state.drained) this.processes.delete(state);
      return state.drained;
    })();
  }

  /** One explicitly requested native ACP compact operation. No user message,
   * bootstrap, /compact prose prompt, native-ID allocation or acceptance claim.
   * The bridge supplies the original compact owner's identity/evidence and owns
   * final owner release plus optional read-only native history refresh. */
  async executeCompact(owner: Owner, instructions?: string): Promise<GrokCompactRunObservation> {
    const state = this.state(owner);
    if (state.executing) throw new Error("A managed Grok run cannot execute twice");
    state.executing = true;
    owner.streamsDrained = false;
    const compact = state.compact = { controller: new AbortController(), journal: Promise.resolve() } as NonNullable<ManagedRun<Owner>["compact"]>;
    const run = owner.run, done = owner.done, identity = owner.contextIdentity, evidence = owner.dispatchEvidence, beforeSend = owner.beforeSend;
    const source = identity?.source, originalIdentity = structuredClone(identity), runConfiguration = configuration(run), request = JSON.stringify(run.compact);
    const sessionConfiguration = this.ports.session(run.sessionId) && configuration(this.ports.session(run.sessionId)!);
    const metadataProof = owner.assertMetadataCommitted;
    state.original = { run, done, runId: run.runId, configuration: runConfiguration };
    let pinned: Admission | undefined, response: GrokAcpCompactionResult | undefined, failure: unknown, failed = false, entered = false;
    let submission: GrokCompactRunObservation["submission"] = "not-submitted";
    let latestCompaction: CompactionMetadata | undefined, nativeCompactionObserved = false;
    let rpcResult: unknown;
    const association = () => {
      if (owner.run !== run || owner.done !== done || owner.contextIdentity !== identity || owner.dispatchEvidence !== evidence || owner.beforeSend !== beforeSend
        || owner.assertMetadataCommitted !== metadataProof || !isDeepStrictEqual(identity, originalIdentity)
        || identity && (identity.runId !== run.runId || identity.nativeCommandId !== (run.nativeCommandId ?? null)
          || source?.sessionId !== run.sessionId || source.cwd !== run.cwd)
        || run.operation !== "compact" || JSON.stringify(run.compact) !== request) {
        throw new Error("Original Grok compaction association changed");
      }
    };
    const current = () => {
      this.ports.assertOpen(); association();
      if (owner.settled || owner.stopRequested || owner.cancelling || owner.stopping || compact.controller.signal.aborted || run.status !== "running"
        || this.ports.owner(run.sessionId) !== owner || state.invalid || state.captureFailure || configuration(run) !== runConfiguration
        || !this.ports.session(run.sessionId) || configuration(this.ports.session(run.sessionId)!) !== sessionConfiguration) throw new Error("Grok compact ownership, cancellation or configuration changed");
      owner.controls?.assertIdentity(owner);
      const admission = this.admission(source!);
      if (pinned && (admission.requestId !== pinned.requestId || admission.operation !== pinned.operation || !isDeepStrictEqual(admission.binding, pinned.binding))) throw new Error("Grok compact admission changed");
      if (this.busy(source!, state)) throw new Error("Another Grok process remains unresolved");
      synchronousDispatchHook(() => this.ports.assertBinding?.(admission));
      if (normalizeNativeSource(admission.source.descriptor).authorityId !== source!.authorityId) throw new Error("Grok compact native source changed");
      synchronousDispatchHook(() => metadataProof?.());
    };
    const enqueue = (kind: Event["kind"], data: unknown) => {
      compact.journal = compact.journal.then(async () => { association(); await this.ports.append(run, kind, data); }).catch(error => {
        state.captureFailure ??= error; state.invalid = true; compact.controller.abort();
        try { this.ports.failClosed(error); } catch { /* Preserve original publication failure while the ACP child drains. */ }
      });
    };
    const snapshot = (metadata: CompactionMetadata) => {
      latestCompaction = structuredClone({ ...metadata, trigger: "manual" });
      // The context fact anchors to the already requested App run. There is no
      // synthetic message/native compaction ID or inferred provider acceptance.
      enqueue("context", { type: "grok-compaction", nativeSessionId: source?.nativeSessionId, compaction: latestCompaction });
    };
    try {
      if (!identity || !source || !evidence) throw new Error("Grok compact requires its original owner's source identity and dispatch evidence, not message bootstrap");
      if (run.operation !== "compact" || !run.compact || !uuid(run.compact.requestId) || identity.requestId !== undefined && identity.requestId !== run.compact.requestId) throw new Error("Grok compact requires its original compact request identity");
      if (instructions !== undefined || run.compact.instructions !== undefined) throw new Error("Grok native compact RPC does not support custom instructions");
      if (!absolute(this.ports.executable)) throw new Error("Grok compact requires its explicit executable");
      current(); pinned = this.admission(source);
      if (!pinned.nativeId || !await grokSessionExists(this.ports.homeRoot, source.cwd, pinned.nativeId)) throw new Error("Grok compact requires an existing native session");
      current();
      state.source = Object.freeze({ ...source }); this.processes.add(state);
      enqueue("status", { status: "running", operation: "compact", compactionLifecycle: "requested" });
      enqueue("launch", { harness: "grok", operation: "compact", transport: "acp", method: "x.ai/compact_conversation", nativeSessionId: pinned.nativeId, cwd: source.cwd });
      await compact.journal; await this.ports.persist(); current();
      response = await compactGrokSession({ executable: this.ports.executable, homeRoot: this.ports.homeRoot, cwd: source.cwd,
        nativeSessionId: pinned.nativeId, signal: compact.controller.signal,
        beforeNative: () => {
          current(); synchronousDispatchHook(() => beforeSend?.()); current();
          synchronousDispatchHook(() => evidence.beforeNative()); entered = true; owner.nativeDispatched = true; current();
          enqueue("context", { type: "grok-compact-request", request: grokCompactRequest(pinned!.nativeId!), requestId: run.compact!.requestId, source });
        },
        onSpawn: info => {
          association(); compact.closed = info.closed;
          void info.closed.then(observed => {
            compact.evidence = observed;
            if (state.finished) void compact.journal.then(() => { this.compactDrained(state); });
          });
        },
        onStderr: text => { if (text) enqueue("stderr", text); },
        onNotification: notification => {
          // session/load may replay old history. Only the owned compact RPC's
          // subsequent native notifications can describe this request.
          if (!entered) return;
          const params = notification.params && typeof notification.params === "object" && !Array.isArray(notification.params)
            ? notification.params as Record<string, unknown> : undefined;
          const payload = params?.notification ?? params?.update ?? params;
          const event = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
          if ([params, event].some(value => value && (
            value.sessionId !== undefined && value.sessionId !== source.nativeSessionId
            || value.session_id !== undefined && value.session_id !== source.nativeSessionId
            || value.parent_tool_use_id !== undefined && value.parent_tool_use_id !== null
            || value.parentToolUseId !== undefined && value.parentToolUseId !== null))) return;
          if (notification.compaction) {
            nativeCompactionObserved = true; snapshot(notification.compaction);
            enqueue("context", { type: "grok-compact-notification", method: notification.method, params: notification.params });
          }
        },
        onClose: observed => { compact.evidence = observed; },
      });
      compact.evidence = response.process; rpcResult = response.result;
    } catch (error) {
      failed = true; failure = error;
      if (error instanceof GrokAcpCompactionError) {
        compact.evidence = error.evidence; compact.closed ??= error.closed; rpcResult = error.rpcResult;
        if (!error.evidence.closeObserved) void error.closed.then(observed => {
          compact.evidence = observed;
          if (state.finished) void compact.journal.then(() => { this.compactDrained(state); });
        });
      }
    }
    try {
      const observed = compact.evidence;
      submission = observed?.compactRequest === "written" ? "submitted" : entered || observed?.compactRequest === "write-attempted" ? "unknown" : "not-submitted";
      if (submission === "not-submitted") evidence?.withheld();
      else synchronousDispatchHook(() => evidence?.outcome(submission, "unknown"));
      const received = observed?.compactResultReceived === true;
      const nativeError = failure instanceof Error && failure.cause instanceof GrokAcpRpcError ? failure.cause.nativeError : undefined;
      if (received) {
        const metadata = grokCompactResultMetadata(rpcResult);
        if (!nativeCompactionObserved || latestCompaction?.lifecycle === "running" || latestCompaction?.lifecycle === "requested") snapshot(metadata);
        else if (latestCompaction) snapshot({ ...latestCompaction, nativeMetadata: { notification: latestCompaction.nativeMetadata, rpcResult } });
        if (metadata.lifecycle === "failed") { failed = true; failure ??= new Error("Grok compact RPC returned an explicit failed outcome"); }
      } else if (nativeError !== undefined) {
        snapshot({ trigger: "manual", lifecycle: "failed", error: nativeError, nativeMetadata: { method: "x.ai/compact_conversation", nativeError } });
      } else if (submission !== "not-submitted" && (!latestCompaction || latestCompaction.lifecycle === "running")) {
        snapshot({ trigger: "manual", lifecycle: "unconfirmed", nativeMetadata: { method: "x.ai/compact_conversation", process: observed, resultReceived: false } });
      }
      if (latestCompaction?.lifecycle === "failed") { failed = true; failure ??= new Error("Grok emitted a native compaction failure"); }
      enqueue("context", { type: "grok-compact-result", requestId: run.compact?.requestId, source,
        submission, nativeAcceptance: "unknown", resultReceived: received, ...(received ? { result: rpcResult } : {}),
        ...(observed ? { process: observed } : {}), ...(response ? { capabilities: response.capabilities, initializeResult: response.initializeResult, loadResult: response.loadResult } : {}),
        ...(nativeError !== undefined ? { nativeError } : {}),
        ...(failed ? { reason: reason(failure) } : {}) });
      await compact.journal;
      if (state.captureFailure) { failed = true; failure ??= state.captureFailure; }
      const drained = this.compactDrained(state);
      const completed = !failed && received && drained;
      const status: Status = owner.stopRequested && drained ? "interrupted" : completed ? "completed" : "failed";
      state.successful = completed;
      run.status = status; run.endedAt = new Date().toISOString();
      compact.observation = Object.freeze({ status, submission, nativeAcceptance: "unknown", nativeSessionId: source?.nativeSessionId ?? "",
        ...(received ? { result: rpcResult } : {}), ...(observed ? { process: observed } : {}), ...(latestCompaction ? { compaction: latestCompaction } : {}), refreshHistory: completed });
      await this.ports.updateStatus(owner, status, failed ? reason(failure) : !drained ? "Grok ACP process-group close/drain remains unproven" : undefined);
      if (submission === "not-submitted") await this.ports.append(run, "status", { status, operation: "compact", compactNotSubmitted: true });
      await this.ports.persist();
      return compact.observation;
    } catch (error) {
      state.invalid = true; state.successful = false; this.ports.failClosed(error); throw error;
    } finally {
      state.finished = true; state.processing.resolve();
    }
  }

  async execute(owner: Owner, prompt: string, resume: boolean, ready: (admitted: boolean) => void): Promise<void> {
    const state = this.state(owner);
    if (state.executing) throw new Error("A managed Grok run cannot execute twice");
    state.executing = true;
    owner.streamsDrained = false;
    const run = owner.run, done = owner.done, identity = owner.contextIdentity, messages = owner.contextMessages, evidence = owner.dispatchEvidence;
    const publication = owner.submissionPublication, metadataProof = owner.assertMetadataCommitted, source = identity?.source;
    const originalIdentity = structuredClone(identity), runConfiguration = configuration(run);
    state.original = { run, done, runId: run.runId, configuration: runConfiguration };
    const session = this.ports.session(run.sessionId), sessionConfiguration = session && configuration(session);
    const policy = owner.nativeDeliveryPolicy, beforeSend = owner.beforeSend;
    let pinned: Admission | undefined;
    let failure: unknown;
    let failed = false;
    let pipelineStarted = false;
    const association = () => {
      if (owner.run !== run || owner.done !== done || owner.contextIdentity !== identity || owner.contextMessages !== messages
        || owner.dispatchEvidence !== evidence || owner.submissionPublication !== publication || owner.assertMetadataCommitted !== metadataProof || !identity || !source
        || !isDeepStrictEqual(identity, originalIdentity) || identity.runId !== run.runId || identity.nativeCommandId !== (run.nativeCommandId ?? null)
        || source.sessionId !== run.sessionId || source.cwd !== run.cwd) throw new Error("Original Grok dispatch association changed");
    };
    const current = () => {
      this.ports.assertOpen(); association();
      if (owner.settled || owner.stopRequested || owner.cancelling || owner.stopping || run.status !== "running" || this.ports.owner(run.sessionId) !== owner
        || state.invalid || state.captureFailure || owner.beforeSend !== beforeSend || owner.nativeDeliveryPolicy !== policy || configuration(run) !== runConfiguration
        || !this.ports.session(run.sessionId) || configuration(this.ports.session(run.sessionId)!) !== sessionConfiguration) throw new Error("Grok dispatch ownership, cancellation or configuration changed");
      owner.controls?.assertIdentity(owner);
      const admission = this.admission(source!);
      if (pinned && (admission.requestId !== pinned.requestId || admission.operation !== pinned.operation || !isDeepStrictEqual(admission.binding, pinned.binding))) throw new Error("Grok admitted execution binding changed");
      if (this.busy(source!, state)) throw new Error("Another local Grok process remains unresolved");
    };
    try {
      if (!identity || !messages || !evidence || !source) throw new Error("Managed Grok requires the original owner's context and dispatch evidence");
      if (run.operation === "compact" || run.nativeDelivery || owner.nativeQueuedHandoff || policy === "native-queued-handoff") throw new Error("Grok supports serial prompt runs, not native compact or inbox operations");
      if (!absolute(this.ports.promptDirectory)) throw new Error("Grok prompt directory must be absolute");
      current(); pinned = this.admission(source);
      state.source = Object.freeze({ ...source }); this.processes.add(state);
      state.stdout = this.sink(state, "stdout", association); state.stderr = this.sink(state, "stderr", association);
      state.adapter = createGrokDispatchAdapter<Owner>({
        executable: this.ports.executable, homeRoot: this.ports.homeRoot, promptDirectory: this.ports.promptDirectory,
        toolPath: this.ports.toolPath, spawn: this.ports.spawn, executableReady: this.ports.executableReady, timeoutMs: this.ports.timeoutMs,
        stdout: state.stdout, stderr: state.stderr,
        ...(this.ports.appConnectionFile && this.ports.bindingDirectory ? { nativeRuntime: (candidate: RunOwner) => {
          if (candidate !== owner) throw new Error("Grok runtime differs from its original owner");
          current();
          const admitted = this.admission(source);
          if (admitted.source.descriptor.harness !== "gk" || !admitted.nativeId) throw new Error("Grok runtime requires its actual gk source");
          return createGrokNativeRuntime({ bindingDirectory: this.ports.bindingDirectory!, appConnectionFile: this.ports.appConnectionFile!,
            runId: run.runId, appSessionId: run.sessionId, nativeSessionId: admitted.nativeId, source: admitted.source.descriptor,
            authorityId: admitted.source.authorityId, cwd: admitted.binding.executionCheckout,
            ...(admitted.binding.domain.mode === "repository" ? { repository: admitted.binding.domain.primaryCheckout } : {}) });
        } } : {}),
        callerContext: candidate => {
          if (candidate !== owner) throw new Error("Grok caller differs from its original owner");
          current();
          const admitted = this.admission(source);
          synchronousDispatchHook(() => this.ports.assertBinding?.(admitted));
          const normalized = normalizeNativeSource(admitted.source.descriptor);
          if (normalized.authorityId !== source.authorityId) throw new Error("Grok source home changed before spawn");
          return admitted.binding.domain.mode === "repository" ? JSON.stringify({ version: 1, repository: admitted.binding.domain.primaryCheckout,
            source: admitted.source.descriptor, authorityId: admitted.source.authorityId, nativeId: admitted.nativeId }) : undefined;
        },
      });
      const native = state.adapter;
      const messageId = `${run.runId}:user`;
      pipelineStarted = true;
      await coordinateRunSubmission<GrokPromptFilePacket, void, void, () => string>({
        mode: policy === "idle-only" ? "idle-only" : "initial",
        request: { messageId, body: prompt, boundary: "run-initial", ...(run.queuedFollowupId ? { queuedFollowupId: run.queuedFollowupId } : {}) },
        contextMessages: messages, evidence, publication,
        assertPublicationCurrent: metadataProof,
        assertCurrent: current, assertObservationCurrent: association,
        failClosed: error => { state.invalid = true; this.ports.failClosed(error); },
        journal: {
          status: async () => { await this.ports.append(run, "status", { status: "running" }); },
          submission: async submission => { await this.ports.append(run, "submission", submission); },
          launch: async packet => { await this.ports.append(run, "launch", { harness: "grok", encoding: packet.encoding,
            resume: this.observation(owner)?.sessionMode === "resume", nativeSessionId: source.nativeSessionId, cwd: source.cwd, model: run.model, effort: run.effort }); },
        },
        publishMetadata: () => this.ports.persist(),
        native: {
          capabilities: { initial: { supported: true }, "idle-only": { supported: true } },
          encode: text => {
            const packet: GrokPromptFilePacket = Object.freeze({ encoding: "grok-prompt-file", text: Buffer.from(text, "utf8").toString("utf8") });
            if (packet.text !== text) throw new Error("Grok prompt is not lossless UTF-8");
            return { payload: packet, readActual: () => { association(); return { identity, messageId, text: packet.text }; },
              assertWire: readWire => { if (readWire() !== packet.text) throw new Error("Grok prompt-file wire differs from its bound bytes"); } };
          },
          setup: async (packet, steps) => {
            await steps.step("transport.setup", () => mkdir(this.ports.promptDirectory, { recursive: true, mode: 0o700 }));
            const prepared = await steps.step("transport.setup", () => native.prepare(owner, packet.text, resume));
            if (!prepared) throw new Error(this.observation(owner)?.reason ?? "Grok local preparation failed");
          },
          preflight: async () => { current(); },
          beforeNative: () => { current(); synchronousDispatchHook(() => beforeSend?.()); current(); },
          onIntentRecorded: () => { owner.nativeDispatched = true; },
          // executePrepared enters the shared gate synchronously with actual file
          // bytes and forwards outcomes without invoking owner hooks a second time.
          send: (_packet, _setup, boundary) => native.executePrepared(owner, this.ports.homeRoot, ready, boundary),
        },
      });
    } catch (error) {
      failed = true; failure = error;
      if (!pipelineStarted) evidence?.withheld();
    }
    finally {
      try {
        await state.adapter?.finish(owner);
        const observed = this.observation(owner);
        if (observed?.wrapperCompletion === "running" || observed?.wrapperCompletion === "incomplete") {
          // Bounded processing is not actual close. Retain the original sinks and
          // process supervision until that original adapter eventually closes.
          if (state.adapter) stopGrokDispatch(state.adapter, owner);
          void this.drain(state).catch(error => {
            state.captureFailure ??= error;
            try { this.ports.failClosed(error); } catch { /* Original drain failure stays retained. */ }
          });
        } else await this.drain(state);
        const completed = !failed && state.drained && observed?.submission === "submitted" && observed.wrapperCompletion === "closed"
          && observed.exitCode === 0 && observed.exitSignal === null;
        const status: Status = owner.stopRequested && state.drained ? "interrupted" : completed ? "completed" : "failed";
        state.successful = status === "completed";
        run.status = status;
        run.endedAt = new Date().toISOString();
        await this.ports.updateStatus(owner, status, failed ? reason(failure) : completed ? undefined : observed?.reason ?? "Grok wrapper did not complete successfully");
        if (owner.workerDeliveryId && !owner.nativeDispatched) await this.ports.append(run, "status", { status, workerDeliveryNotSubmitted: owner.workerDeliveryId });
        await this.ports.persist();
      } catch (error) {
        state.invalid = true; state.successful = false;
        this.ports.failClosed(error);
        throw error;
      } finally {
        state.finished = true; state.processing.resolve(); ready(false);
      }
    }
  }

  async successfulSettlement(owner: Owner, source: DispatchSource, guards?: () => DispatchTerminalGuards): Promise<DispatchReadiness> {
    if (guards) { const gate = terminalDispatchReadiness(guards()); if (!gate.ready) return gate; }
    const state = this.runs.get(owner), observed = this.observation(owner);
    if (!state || !state.source || !sameDispatchSource(state.source, source) || !state.finished || !state.successful || state.invalid || !state.drained
      || !state.original || owner.run !== state.original.run || owner.done !== state.original.done || owner.run.runId !== state.original.runId
      || configuration(owner.run) !== state.original.configuration || owner.run.sessionId !== source.sessionId || owner.run.cwd !== source.cwd
      || !owner.settled || owner.run.status !== "completed" || owner.stopRequested || owner.cancelling || owner.stopping
      || observed?.submission !== "submitted" || observed.wrapperCompletion !== "closed" || observed.exitCode !== 0 || observed.exitSignal !== null) {
      return denied("Original Grok wrapper success and complete capture drain are not proven");
    }
    // This is serial local-process completion, never provider acceptance or a
    // statement about foreign Grok clients. The next message must be a new send.
    const readiness = (await this.readiness(source, "queued-user")).readiness;
    if (guards) { const gate = terminalDispatchReadiness(guards()); if (!gate.ready) return gate; }
    if (owner.stopRequested || owner.cancelling || owner.stopping || owner.run.status !== "completed") return denied("Grok settlement changed during readiness evaluation");
    return readiness;
  }
}
