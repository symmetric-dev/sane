import { isAbsolute } from "node:path";
import { PassThrough } from "node:stream";
import type { GrokSourceDescriptor } from "sane-core/contracts";
import { normalizeNativeSource } from "sane-core/server";
import type { AdmissionService, GrokCreateAdmission } from "./admission";
import {
  createGrokDispatchAdapter, grokDispatchObservation, stopGrokDispatch,
  type GrokDispatchAdapter, type GrokSpawn, type GrokStopResult, type GrokTurnObservation,
} from "./grok-adapter";
import {
  appendGrokCaptureTurn, beginGrokCaptureTurn, finishGrokCaptureTurn, loadGrokCaptureJournal,
  type GrokCaptureJournal, type GrokCaptureTurn,
} from "./grok-capture";
import type { RunOwner } from "./run-owner";

/** Capture coordinator: no registry advertisement, receipt, automatic send,
 * native acceptance claim, or PATH discovery. The capture envelope owns durable
 * identity and pending/blocked execution. This map owns only live App turns,
 * including a child whose close remains unavailable after bounded termination. */
const inFlightOwners = new Map<string, { owner: RunOwner; adapter: GrokDispatchAdapter }>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GROK_AUTHORITY = /^sane-native-v1:gk:[a-f0-9]{64}$/;
const NOT_SUBMITTED = "Grok turn did not reach a submitted spawn";

export class GrokSendRefusal extends Error {
  readonly name = "GrokSendRefusal";
  constructor(readonly code: "grok-eligibility-refused", message: string) { super(message); }
}
export type GrokResolvedAuthority = { readonly descriptor: GrokSourceDescriptor; readonly authorityId: string | null };
export type GrokSendSession = {
  readonly appSessionId: string;
  readonly captureDirectory: string;
  readonly promptDirectory: string;
  nativeSessionId?: string;
  turnIndex: number;
  blocked: boolean;
  /** Retained on incomplete child drain, even though wrapper processing settled. */
  owner?: RunOwner;
  readonly journal: GrokCaptureJournal;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly stdoutChunks: Buffer[];
  readonly stderrChunks: Buffer[];
};
export type GrokTurnKind = "new" | "continuation";
export type GrokTurnRequest = {
  kind: GrokTurnKind;
  executable?: string;
  model?: string;
  effort?: string;
  cwd: string;
  authority: GrokResolvedAuthority | null;
  prompt: string;
  workspaceId: string;
  worktreeId: string;
  admissions: Pick<AdmissionService, "beginGrokCreate" | "get" | "getGrokCreate" | "getGrokSourcePin">;
  spawn?: GrokSpawn;
  timeoutMs?: number;
  /** Final synchronous catalog fence after preparation/admission persistence. */
  assertBinding?: () => void;
  /** Normal composer errors are terminal for this App conversation, even when withheld. */
  blockOnFailure?: boolean;
};
export type GrokTurnResult = {
  readonly nativeSessionId: string;
  readonly turn: GrokCaptureTurn | null;
  readonly admission?: GrokCreateAdmission;
  readonly observation?: GrokTurnObservation;
  readonly owner: RunOwner;
};
export type GrokTurnHandle = {
  readonly session: GrokSendSession;
  readonly nativeSessionId: string;
  stop(): GrokStopResult;
  readonly done: Promise<GrokTurnResult>;
  readonly closed: Promise<void>;
  observation(): GrokTurnObservation | undefined;
};

function refuse(message: string): never { throw new GrokSendRefusal("grok-eligibility-refused", message); }
function absolute(value: unknown): value is string { return typeof value === "string" && isAbsolute(value) && !value.includes("\0"); }
function explicit(value: unknown): value is string { return typeof value === "string" && value.trim() !== ""; }
function collect(stream: PassThrough, chunks: Buffer[]): void {
  stream.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
}
function textFrom(chunks: readonly Buffer[], mark: number): string { return Buffer.concat(chunks.slice(mark)).toString("utf8"); }

function grokAdmission(admissions: GrokTurnRequest["admissions"], sessionId: string): GrokCreateAdmission | undefined {
  const admission = admissions.getGrokCreate(sessionId);
  if (!admission && admissions.get(sessionId)) refuse("Grok session already has a non-Grok create admission");
  return admission;
}

function sameDescriptor(left: GrokSourceDescriptor, right: GrokSourceDescriptor): boolean {
  return Object.keys(left).length === 4 && Object.keys(right).length === 4
    && left.version === right.version && left.harness === right.harness && left.kind === right.kind && left.homeRoot === right.homeRoot;
}

export function createGrokSendSession(input: { appSessionId: string; captureDirectory: string; promptDirectory?: string }): GrokSendSession {
  if (!UUID.test(input.appSessionId)) refuse("Grok session id is not a UUID");
  if (!absolute(input.captureDirectory)) refuse("Grok capture directory is not absolute");
  const promptDirectory = input.promptDirectory ?? input.captureDirectory;
  if (!absolute(promptDirectory)) refuse("Grok prompt directory is not absolute");
  const stdout = new PassThrough(), stderr = new PassThrough();
  const stdoutChunks: Buffer[] = [], stderrChunks: Buffer[] = [];
  collect(stdout, stdoutChunks); collect(stderr, stderrChunks);
  const journal = loadGrokCaptureJournal(input.captureDirectory, input.appSessionId);
  return {
    appSessionId: input.appSessionId, captureDirectory: input.captureDirectory, promptDirectory,
    nativeSessionId: journal.execution?.nativeSessionId ?? journal.turns[0]?.nativeSessionId,
    turnIndex: journal.turns.length,
    blocked: (journal.execution !== undefined && journal.execution.disposition !== "idle")
      || journal.turns.some(turn => turn.nativeCancellation === "unproven"),
    journal, stdout, stderr, stdoutChunks, stderrChunks,
  };
}

function assertEligible(session: GrokSendSession, input: GrokTurnRequest, ownerKey: string): asserts input is GrokTurnRequest & {
  executable: string; model: string; effort: string; authority: GrokResolvedAuthority & { authorityId: string };
} {
  if (session.owner || inFlightOwners.has(ownerKey)) refuse("A Grok turn already owns this App session");
  if (session.blocked || (session.journal.execution && session.journal.execution.disposition !== "idle")) refuse("Refusing to spawn again while the Grok session is blocked");
  if (!absolute(input.executable)) refuse("Grok executable is missing or not absolute");
  if (!explicit(input.model) || !explicit(input.effort)) refuse("Grok model and effort must be explicit non-empty strings");
  if (!absolute(input.cwd)) refuse("Grok cwd is not absolute");
  if (!input.authority?.authorityId || !GROK_AUTHORITY.test(input.authority.authorityId)) refuse("Grok authority is unresolved or not a sane-native-v1:gk identity");
  if (!absolute(input.authority.descriptor?.homeRoot)) refuse("Grok homeRoot is missing or not absolute");
  if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 0)) refuse("Grok timeoutMs must be a finite non-negative number");
  const original = session.journal.execution ?? session.journal.turns[0];
  if (original && (original.authorityId !== input.authority.authorityId || original.nativeSessionId !== session.nativeSessionId)) refuse("Grok request does not match the original captured source identity");
  if (input.kind === "continuation" && (!session.nativeSessionId || session.journal.turns.length === 0)) refuse("Grok continuation requires a previously submitted turn");
  if (input.kind === "new" && session.journal.turns.length !== 0) refuse("Grok new turn refuses to replace an existing native session");
}

/** Final synchronous source fence, after executable preparation and admission
 * awaits. Exact descriptors bind the request and admission to the pin; only the
 * configured descriptor is normalized, once, at this final fence. */
function launchHome(session: GrokSendSession, input: GrokTurnRequest, nativeSessionId: string, authority: GrokResolvedAuthority & { authorityId: string }): string {
  const original = session.journal.execution ?? session.journal.turns[0];
  if (original && (original.authorityId !== authority.authorityId || original.nativeSessionId !== nativeSessionId)) refuse("Grok launch would change its original captured identity");
  const admission = grokAdmission(input.admissions, session.appSessionId);
  if (!admission || admission.source.descriptor.harness !== "gk" || admission.source.authorityId !== authority.authorityId
    || admission.nativeId !== nativeSessionId || admission.operation !== "create" || admission.state !== "identity_known") refuse("Grok launch does not match its original create admission");
  if (admission.binding.executionCheckout !== input.cwd || admission.binding.workspaceId !== input.workspaceId
    || admission.binding.worktreeId !== input.worktreeId || admission.binding.domain.mode !== "app-only") refuse("Grok launch does not match its admitted execution binding");
  const pin = input.admissions.getGrokSourcePin();
  if (!pin || pin.descriptor.harness !== "gk" || pin.authorityId !== authority.authorityId) refuse("Grok launch does not match the configured gk source pin");
  if (!sameDescriptor(authority.descriptor, pin.descriptor) || !sameDescriptor(admission.source.descriptor, pin.descriptor)) refuse("Grok requested home does not match the original admitted source pin");
  try {
    const configured = normalizeNativeSource(pin.descriptor);
    if (configured.authorityId !== authority.authorityId) refuse("Grok pinned home changed before launch");
    return configured.descriptor.homeRoot;
  } catch (error) {
    if (error instanceof GrokSendRefusal) throw error;
    refuse(`Grok pinned home could not be normalized: ${error instanceof Error ? error.message : "unavailable"}`);
  }
}

/** Claim synchronously, prepare locally, admit, publish pending intent, then
 * launch once. One finalizer captures/settles every exit path. A definitely
 * unsubmitted create keeps its reserved identity_known admission: a later
 * explicit new turn can use that SAME UUID, never an automatic retry/replay. */
export function runGrokTurn(session: GrokSendSession, request: GrokTurnRequest): GrokTurnHandle {
  const ownerKey = session.appSessionId.toLowerCase();
  assertEligible(session, request, ownerKey);
  // Snapshot caller-owned input before awaits; original identity comes only from
  // the durable capture envelope, not from a mutable continuation request.
  const input = { ...request, authority: structuredClone(request.authority) };
  const authority = input.authority;
  const nativeSessionId = session.journal.execution?.nativeSessionId ?? session.nativeSessionId ?? crypto.randomUUID();
  const runId = crypto.randomUUID();
  const finished = Promise.withResolvers<void>();
  const owner: RunOwner = {
    run: { runId, sessionId: session.appSessionId, cwd: input.cwd, status: "running", createdAt: new Date().toISOString(), model: input.model, effort: input.effort },
    done: finished.promise, settled: false,
    contextIdentity: {
      source: Object.freeze({ harnessId: "grok", sessionId: session.appSessionId, authorityId: authority.authorityId, nativeSessionId, cwd: input.cwd }),
      runId, nativeCommandId: null,
    },
  };
  session.owner = owner;
  const adapter = createGrokDispatchAdapter({
    executable: input.executable, homeRoot: authority.descriptor.homeRoot, model: input.model, effort: input.effort,
    promptDirectory: session.promptDirectory, stdout: session.stdout, stderr: session.stderr,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.spawn ? { spawn: input.spawn } : {}),
  });
  inFlightOwners.set(ownerKey, { owner, adapter });
  const stdoutMark = session.stdoutChunks.length, stderrMark = session.stderrChunks.length;

  const done = (async (): Promise<GrokTurnResult> => {
    let admission: GrokCreateAdmission | undefined;
    let turn: GrokCaptureTurn | null = null;
    let failure: { error: unknown } | undefined;
    let intent: "none" | "pending" | "storage-failed" = "none";
    const rememberFailure = (error: unknown) => { failure ??= { error }; };
    try {
      if (await adapter.prepare(owner, input.prompt, input.kind === "continuation")) {
        if (!owner.stopRequested) {
          // Local preparation must finish before a new create reserves identity.
          // A failed admission has no possible native boundary, so it must not
          // durably pin an invalid requested source into the capture envelope.
          const reservedAdmission = grokAdmission(input.admissions, session.appSessionId);
          if (reservedAdmission && !session.journal.execution && session.journal.turns.length === 0) {
            refuse("Grok admission has no durable execution evidence; inspect native state instead of retrying");
          }
          admission = reservedAdmission;
          if (input.kind === "new" && !admission) admission = await input.admissions.beginGrokCreate({
            sessionId: session.appSessionId, nativeId: nativeSessionId, cwd: input.cwd,
            workspaceId: input.workspaceId, worktreeId: input.worktreeId, authorityId: authority.authorityId, parent: null,
          });
          let homeRoot: string | undefined;
          if (!owner.stopRequested) {
            input.assertBinding?.();
            homeRoot = launchHome(session, input, nativeSessionId, authority);
          }
          else if (!admission || admission.nativeId !== nativeSessionId || admission.source.authorityId !== authority.authorityId
            || admission.state !== "identity_known") refuse("Grok cancellation does not match its reserved create admission");
          try {
            beginGrokCaptureTurn(session.captureDirectory, session.journal, {
              appSessionId: session.appSessionId, nativeSessionId, authorityId: authority.authorityId, turnIndex: session.turnIndex,
            });
            intent = "pending";
            session.nativeSessionId = nativeSessionId;
          } catch (error) { intent = "storage-failed"; session.blocked = true; throw error; }
          if (!owner.stopRequested && homeRoot !== undefined) {
            // No await between this source fence and the adapter's guarded spawn.
            await adapter.executePrepared(owner, homeRoot, () => {});
          }
        }
      }
    } catch (error) { rememberFailure(error); }

    // This is the only coordinator finalizer. Preserve the original execution
    // error when capture/cleanup also fails; pending on disk remains conservative.
    try { await adapter.finish(owner); } catch (error) { rememberFailure(error); }
    const observation = grokDispatchObservation(adapter, owner);
    const submitted = observation?.submission === "submitted";
    const unknown = observation?.submission === "unknown";
    const incomplete = observation?.wrapperCompletion === "incomplete";
    // If a freshly admitted create failed its final source fence, publish the
    // reserved identity with proven local non-submission before returning it.
    // Older admission-only records have no such proof and are refused above.
    if (intent === "none" && admission && !session.journal.execution && session.journal.turns.length === 0 && !submitted && !unknown) {
      try {
        beginGrokCaptureTurn(session.captureDirectory, session.journal, {
          appSessionId: session.appSessionId, nativeSessionId, authorityId: authority.authorityId, turnIndex: session.turnIndex,
        });
        intent = "pending";
        session.nativeSessionId = nativeSessionId;
      } catch (error) { intent = "storage-failed"; session.blocked = true; rememberFailure(error); }
    }
    const unsafe = unknown || incomplete || observation?.nativeCancellation === "unproven" || observation?.toolBoundary === "refused"
      || (submitted && (failure !== undefined || observation.wrapperCompletion !== "closed" || observation.exitCode !== 0 || observation.exitSignal !== null));
    session.blocked ||= unsafe || (input.blockOnFailure === true && (failure !== undefined || !submitted));
    if (submitted) {
      session.nativeSessionId = nativeSessionId;
      try {
        turn = appendGrokCaptureTurn(session.journal, {
          appSessionId: session.appSessionId, nativeSessionId, authorityId: authority.authorityId, cwd: input.cwd,
          model: input.model, effort: input.effort, turnIndex: session.turnIndex, prompt: input.prompt, submission: "submitted",
          runId, createdAt: owner.run.createdAt,
          stdout: textFrom(session.stdoutChunks, stdoutMark), stderr: textFrom(session.stderrChunks, stderrMark),
          exitCode: observation.exitCode, exitSignal: observation.exitSignal,
          nativeCancellation: observation.nativeCancellation === "unproven" ? "unproven" : "not-requested",
          nativeAcceptance: "unknown", acceptedMessageId: null,
        });
      } catch (error) { intent = "storage-failed"; session.blocked = true; rememberFailure(error); }
    }
    if (intent === "pending") {
      try {
        // Publish the appended turn and final disposition together, once.
        finishGrokCaptureTurn(session.captureDirectory, session.journal, { blocked: session.blocked });
        session.turnIndex = session.journal.turns.length;
        if (submitted && observation.wrapperCompletion === "closed") {
          session.stdoutChunks.splice(stdoutMark);
          session.stderrChunks.splice(stderrMark);
        }
      }
      catch (error) { session.blocked = true; rememberFailure(error); }
    }
    if (!submitted && !unknown && !owner.stopRequested && !failure) rememberFailure(new GrokSendRefusal("grok-eligibility-refused", observation?.reason ?? NOT_SUBMITTED));
    owner.streamsDrained = observation?.wrapperCompletion === "closed";
    owner.run.status = failure || session.blocked ? "failed" : owner.stopRequested ? "interrupted" : submitted ? "completed" : "failed";
    owner.run.endedAt = new Date().toISOString();
    owner.settled = true;
    // Incomplete drain is not ownership release. Keep the owner reachable in
    // this session and the live registry; durable pending/blocked also survives restart.
    const release = () => {
      if (inFlightOwners.get(ownerKey)?.owner === owner) inFlightOwners.delete(ownerKey);
      if (session.owner === owner) session.owner = undefined;
    };
    if (!incomplete) release();
    else void adapter.closed(owner).then(release);
    finished.resolve();
    if (failure) throw failure.error;
    return { nativeSessionId, turn, admission, observation, owner };
  })();

  return {
    session, nativeSessionId, done, closed: adapter.closed(owner),
    observation: () => grokDispatchObservation(adapter, owner),
    stop() {
      if (owner.settled && grokDispatchObservation(adapter, owner)?.wrapperCompletion !== "incomplete") return { stopped: false, code: "grok-stop-refused", reason: "Grok wrapper processing already settled; native cancellation is not attempted", killedPid: null, nativeCancellation: "not-attempted" };
      owner.stopRequested = true;
      const result = stopGrokDispatch(adapter, owner);
      if (result.nativeCancellation === "unproven") session.blocked = true;
      return result;
    },
  };
}
