import type { DispatchNativeAcceptance, DispatchSubmission } from "../shared/conversation/dispatch-contract";
import type { ContextMessageSubmission } from "./context-message-evidence";
import type { ActualContextSubmission, OwnedContextMessageRequest, OwnedContextMessages, OwnedSubmissionPublication, PreparedOwnedContextMessage } from "./context-message-transport";
import { synchronousDispatchHook } from "./dispatch-evidence";
import type { OperationTiming } from "./operation-timing";
import type { RunOwner } from "./run-owner";
import type { RunSubmissionMode, RunSubmissionStage } from "./run-submission-timing";

export type RunSubmissionSetupStage = "native.inspect" | "native.history" | "execution.resolve" | "execution.configure" | "transport.setup" | "native.preflight";
export type RunSubmissionPreparationSteps = Readonly<{
  /** Cheap live source/owner/configuration/cancellation check, NOT full context IO. */
  assertCurrent: () => void;
  /** Every setup await (including queue waits) must use this gate. */
  step: <T>(stage: RunSubmissionSetupStage, work: () => Promise<T>) => Promise<T>;
}>;
export type EncodedRunSubmission<Payload, Wire = Payload> = Readonly<{
  payload: Payload;
  /** Read the retained actual immutable encoding, not the supplied candidate. */
  readActual: () => ActualContextSubmission;
  /** Compare the bytes supplied by the transport's final callback to that encoding. */
  assertWire: (wire: Wire) => void;
}>;
export type RunSubmissionObservedSubmission = Exclude<DispatchSubmission, "attempted">;
export type RunSubmissionBoundary<Wire> = Readonly<{
  /** Must run synchronously at the earliest possible native side effect (spawn
   * for CC, actual request for OC), not merely at acknowledgement or stdin flush. */
  beforeNative: (wire: Wire) => void;
  /** Original-source association only: record facts BEFORE any follow-on live
   * owner/cancellation checks. Retained callbacks may observe after cancellation.
   * CC flush proves submitted/unknown; only an exact OC receipt proves accepted.
   * Native receipt timestamps remain in the port's Result, never inferred here. */
  outcome: (submission: RunSubmissionObservedSubmission, acceptance?: DispatchNativeAcceptance) => void;
}>;
export type RunSubmissionNativePort<Payload, Setup, Result, Wire = Payload> = Readonly<{
  /** Missing declarations refuse; no inferred support for new delivery modes. */
  capabilities: Readonly<Partial<Record<RunSubmissionMode, Readonly<{ supported: true }> | Readonly<{ supported: false; reason: string }>>>>;
  encode: (text: string) => EncodedRunSubmission<Payload, Wire>;
  /** Inspect/history/configuration remain native-specific. Use steps around each
   * await; this callback may not send, spawn, or reserve native intent. */
  setup: (payload: Payload, steps: RunSubmissionPreparationSteps) => Promise<Setup>;
  /** Resolve fresh checkout/idle-only/handoff proofs after launch publication. */
  preflight: (payload: Payload, setup: Setup, steps: RunSubmissionPreparationSteps) => Promise<void>;
  /** Native-specific synchronous beforeSend/worker/delivery-policy guards. The
   * shared pipeline invokes the ORIGINAL evidence intent immediately afterwards. */
  beforeNative: (payload: Payload, setup: Setup) => void;
  /** Optional synchronous ANNOTATION ONLY after original durable intent returns
   * successfully, including if a trailing gate check subsequently fails. Mark
   * existing supervision/nativeDispatched bookkeeping only: no physical native
   * effect, ready/acceptance signal, ownership change, or admission decision. */
  onIntentRecorded?: (payload: Payload, setup: Setup) => void;
  /** Discovery belongs in setup/preflight, returning an opaque connection-bound
   * handle in Setup. Invoke beforeNative with actual wire bytes in this function's
   * SYNCHRONOUS prefix, at spawn/stdin.write/fetch, before its first await. The
   * coordinator rejects a transport which returns without entering that gate.
   * Observe exact receipts via boundary.outcome before applying live cancellation
   * gates. A ready callback is NOT submission or acceptance. No retry on ambiguity. */
  send: (payload: Payload, setup: Setup, boundary: RunSubmissionBoundary<Wire>) => Result | Promise<Result>;
}>;
export type RunSubmissionPreparationPorts<Payload, Setup, Result, Wire = Payload> = Readonly<{
  mode: RunSubmissionMode;
  request: OwnedContextMessageRequest;
  contextMessages: OwnedContextMessages;
  /** Captured original lifecycle evidence; never resolve a replacement owner. */
  evidence: NonNullable<RunOwner["dispatchEvidence"]>;
  assertCurrent: () => void;
  /** Storage/original source and association only, not native admission. */
  assertObservationCurrent: () => void;
  /** REQUIRED coordinator-invariant channel. Wire mismatch, duplicate/reentrant
   * entry and missing synchronous native entry must retain bridge health/ownership
   * fail-closed even if a service catches their errors. Not called for ordinary
   * cancellation, certified intent refusal, or narrow onBound snapshot drift.
   * Existing association/persistence callbacks retain their own failure channels. */
  failClosed: (error: RunSubmissionInvariantError) => void;
  /** Optional paired bridge publication capability. Only the shared coordinator
   * publishes/asserts it; adapters forward their captured capability unchanged.
   * Live input supplies a per-send capability, not the initial owner's one. */
  publication?: OwnedSubmissionPublication;
  /** Optional ADDITIONAL independent bridge proof, retained for compatibility.
   * Does not replace publication.assertCurrent. Checks existing proof only: no
   * creation/adoption/writes/replay. Never gates original outcome observations. */
  assertPublicationCurrent?: () => void;
  journal: Readonly<{
    /** Initial status must be durable before the metadata reference. Live input
     * supplies an explicit no-op rather than rewriting its run status. */
    status: () => Promise<void>;
    submission: (submission: ContextMessageSubmission) => Promise<void>;
    launch: (payload: Payload, setup: Setup) => Promise<void>;
  }>;
  /** Use the existing bridge serialized publication queue. No new writer/queue
   * lives here. Explicit no-op is allowed when that phase has no metadata change. */
  publishMetadata: (phase: "submission" | "launch") => Promise<void>;
  native: RunSubmissionNativePort<Payload, Setup, Result, Wire>;
  timing?: OperationTiming;
}>;

export class RunSubmissionCapabilityError extends Error {
  constructor(readonly mode: RunSubmissionMode, message: string) { super(message); }
}

export type RunSubmissionInvariantCode = "invalid-message-boundary" | "wrong-wire" | "reentrant-boundary" | "duplicate-boundary" | "missing-native-boundary";
export class RunSubmissionInvariantError extends Error {
  constructor(readonly code: RunSubmissionInvariantCode, message: string, cause?: unknown) { super(message, { cause }); }
}

function synchronous<T>(read: () => T): T {
  let value!: T;
  synchronousDispatchHook(() => { value = read(); return value; });
  return value;
}

/** ONE ordered preparation policy for initial/live/queued prompt submission.
 * Compaction retains its separate non-message operation contract. The bridge
 * retains its one owner registry, admission authority, journal, and write queue;
 * existing context/evidence owners retain pairing, intent and monotonic outcomes.
 *
 * Preparation establishes the message once. After setup/publication/preflight,
 * its retained input/binding fence is checked without repeating context IO.
 * The final native callback still performs synchronous wire/source/owner guards
 * and durable intent. Preparation is not a lease or permission to replay. */
export async function coordinateRunSubmission<Payload, Setup, Result, Wire = Payload>(
  ports: RunSubmissionPreparationPorts<Payload, Setup, Result, Wire>,
): Promise<Result> {
  // Capture callbacks/capabilities once; they are not looked up on a mutable owner.
  const { mode, contextMessages, evidence, assertCurrent, assertObservationCurrent, assertPublicationCurrent, failClosed, publishMetadata, timing } = ports;
  const request = Object.freeze({ ...ports.request }), native = Object.freeze({ ...ports.native }), journal = Object.freeze({ ...ports.journal });
  const suppliedPublication = ports.publication;
  const publication = suppliedPublication ? Object.freeze({ publish: suppliedPublication.publish, assertCurrent: suppliedPublication.assertCurrent }) : undefined;
  const current = () => synchronousDispatchHook(assertCurrent);
  const observation = () => synchronousDispatchHook(assertObservationCurrent);
  const start = (stage: RunSubmissionStage) => {
    let end: ((outcome?: string) => void) | undefined;
    try { end = timing?.span(stage); } catch { /* Optional diagnostics never own admission. */ }
    let finished = false;
    return (outcome?: string) => {
      if (finished) return;
      finished = true;
      try { end?.(outcome); } catch {}
    };
  };
  const measured = <T>(stage: RunSubmissionStage, action: () => T): T => {
    const end = start(stage);
    try { const result = action(); end(); return result; }
    catch (error) { end("error"); throw error; }
  };
  const checked = async <T>(stage: RunSubmissionStage, action: () => Promise<T>): Promise<T> => {
    const end = start(stage);
    try {
      current();
      try { return await action(); }
      finally { current(); }
    } catch (error) { end("error"); throw error; }
    finally { end(); }
  };
  const steps: RunSubmissionPreparationSteps = Object.freeze({ assertCurrent: current, step: checked });
  let prepared: PreparedOwnedContextMessage | undefined;
  // Preserve an original publication failure even if a trailing live guard or
  // withholding observation also fails after the publisher fences storage.
  let publicationFailure: { error: unknown } | undefined;
  // Descriptive bookkeeping only; original evidence remains the admission/intent
  // authority. Successful intent and successful gate RETURN are distinct facts.
  const state: {
    phase: "preparing" | "ready" | "entering-native" | "possible-native" | "closed";
    intentInvoked: boolean;
    possibleAttempt: boolean;
    gateReturned: boolean;
    boundaryFailure?: { error: unknown };
    invariantReported: boolean;
  } = {
    phase: "preparing", intentInvoked: false, possibleAttempt: false, gateReturned: false, invariantReported: false,
  };
  const latchBoundaryFailure = (error: unknown): unknown => {
    state.phase = "closed";
    state.boundaryFailure ??= { error };
    return state.boundaryFailure.error;
  };
  const invariant = (code: RunSubmissionInvariantCode, message: string, cause?: unknown): unknown => {
    const error = new RunSubmissionInvariantError(code, message, cause);
    const first = latchBoundaryFailure(error);
    if (!state.invariantReported) {
      // Close and latch BEFORE the callback, including if it throws or reenters.
      state.invariantReported = true;
      try { synchronousDispatchHook(() => failClosed(error)); }
      catch { /* The original invariant remains the surfaced failure, not a callback replacement. */ }
    }
    return first;
  };
  const assertBoundaryUnpoisoned = () => {
    if (state.boundaryFailure) throw state.boundaryFailure.error;
  };
  const live = mode === "live-input";
  const outcome: RunSubmissionBoundary<Wire>["outcome"] = (submission, acceptance) => {
    measured("native.outcome", () => {
      observation();
      // No current() here: stop/configuration drift must not erase original facts.
      synchronousDispatchHook(() => live ? prepared!.messageOutcome(submission, acceptance) : evidence.outcome(submission, acceptance));
    });
  };
  try {
    const support = native.capabilities[mode];
    if (support?.supported !== true) throw new RunSubmissionCapabilityError(mode, support?.supported === false ? support.reason : "Native submission capability was not explicitly declared");
    if (live !== (request.liveInput === true) || live !== (request.boundary === "message")) throw invariant("invalid-message-boundary", "Submission mode differs from the owned message boundary");
    await checked("status.journal", journal.status);
    prepared = await checked("context.prepare", () => contextMessages.prepare(request, current));
    const selected = prepared;
    current();
    const encoded = measured("payload.encode", () => synchronous(() => native.encode(selected.message.transport.text)));
    current();
    const boundSubmission = await checked("payload.bind-and-journal", async () => {
      // Binding and standard journal reservation MUST be one synchronous call
      // sequence: no await, instrumentation, or refusal gate between them.
      const submission = synchronous(() => selected.bindActual(encoded.readActual));
      await journal.submission(submission);
      return submission;
    });
    await checked("metadata.submission", () => publishMetadata("submission"));
    if (publication) await checked("admission.publish", async () => {
      try { await publication.publish(boundSubmission); }
      catch (error) { publicationFailure = { error }; throw error; }
    });
    const setup = await checked("native.setup", () => native.setup(encoded.payload, steps));
    await checked("launch.journal", () => journal.launch(encoded.payload, setup));
    await checked("metadata.launch", () => publishMetadata("launch"));
    await checked("native.preflight", () => native.preflight(encoded.payload, setup, steps));
    await checked("context.freshness.before-native", selected.assertCurrent);
    current();
    state.phase = "ready";
    const gate: RunSubmissionBoundary<Wire> = Object.freeze({
      beforeNative: wire => {
        if (state.phase !== "ready") throw invariant(state.phase === "entering-native" ? "reentrant-boundary" : "duplicate-boundary", "Native submission boundary closed; replay forbidden");
        state.phase = "entering-native";
        const end = start("native.gate");
        try {
          current();
          try { synchronousDispatchHook(() => encoded.assertWire(wire)); }
          catch (error) {
            throw invariant("wrong-wire", "Actual native wire differs from the bound submission", error);
          }
          synchronousDispatchHook(() => native.beforeNative(encoded.payload, setup));
          if (assertPublicationCurrent) synchronousDispatchHook(assertPublicationCurrent);
          if (publication) synchronousDispatchHook(() => publication.assertCurrent(boundSubmission));
          current();
          // One closed-gate check before durable intent, rather than treating
          // each typed synchronous callback as a separate adversarial boundary.
          assertBoundaryUnpoisoned();
          state.intentInvoked = true;
          synchronousDispatchHook(() => live ? selected.beforeMessageNative() : evidence.beforeNative());
          // Preserve uncertainty if intent returned successfully but a later guard
          // fails, or a caught reentry poisoned the gate during intent publication.
          state.possibleAttempt = true;
          if (native.onIntentRecorded) synchronousDispatchHook(() => native.onIntentRecorded!(encoded.payload, setup));
          end();
          current();
          assertBoundaryUnpoisoned();
          state.gateReturned = true;
          state.phase = "possible-native";
        } catch (error) {
          const first = latchBoundaryFailure(error);
          end("error");
          throw first;
        } finally { end(); }
      },
      outcome,
    });
    // Do not wrap this await in checked(): acknowledgement/original outcomes must
    // survive cancellation and ownership release. Admission stays in the gate.
    const end = start("native.send");
    try {
      const pending = native.send(encoded.payload, setup, gate);
      if (state.boundaryFailure || !state.gateReturned) {
        // Async functions convert a synchronous gate throw into a rejected
        // promise. Preserve the EXACT latched refusal/failure, never replace it
        // with a generic missing-gate error. Only no entry is that invariant.
        const failure = state.boundaryFailure ? state.boundaryFailure.error
          : invariant("missing-native-boundary", "Native transport must enter its synchronous boundary before returning");
        // An invalid async adapter cannot later reopen the retained callback. Its
        // rejection is observed, but neither awaited nor retried for admission.
        state.phase = "closed";
        void Promise.resolve(pending).catch(() => {});
        throw failure;
      }
      const result = await pending;
      state.phase = "closed";
      end();
      // A diagnostics callback cannot hide a caught late duplicate by poisoning
      // the gate in finally after the successful return value was selected.
      assertBoundaryUnpoisoned();
      return result;
    }
    catch (error) {
      // Close BEFORE diagnostics, which may themselves call retained callbacks.
      state.phase = "closed";
      end("error");
      throw state.boundaryFailure ? state.boundaryFailure.error : error;
    }
    finally { end(); }
  } catch (error) {
    // Irrevocable closure precedes ALL failure instrumentation/observations.
    state.phase = "closed";
    try {
      if (state.possibleAttempt) outcome("unknown", "unknown");
      else if (!state.intentInvoked) measured("native.withheld", () => {
        // Prompt non-submission only: native configuration effects may exist.
        observation();
        // Missing original evidence already denies admission. Cleanup must not
        // mask that refusal or manufacture a withholding fact without its owner.
        synchronousDispatchHook(() => live ? prepared?.messageOutcome("not-submitted", "not-accepted") : evidence?.withheld());
      });
      // Invoked-but-failed intent is not recertified as non-submission. Original
      // evidence owns its refusal/partial-write classification and failure path.
    } catch (observationError) {
      // Observation callbacks keep their existing fail-closed channels. They may
      // not replace a certified refusal or another already-latched gate failure.
      throw state.boundaryFailure ? state.boundaryFailure.error : publicationFailure ? publicationFailure.error : observationError;
    } finally { state.phase = "closed"; }
    throw state.boundaryFailure ? state.boundaryFailure.error : publicationFailure ? publicationFailure.error : error;
  } finally { state.phase = "closed"; }
}
