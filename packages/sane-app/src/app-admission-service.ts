import { isDeepStrictEqual } from "node:util";
import {
  canonicalAppAdmissionJSON, decodeAppAdmissionKey, decodeAppAdmissionTarget,
  type AppAdmissionEnvelope, type AppAdmissionKey, type AppAdmissionReceipt,
  type AppAdmissionRejection, type AppAdmissionTarget,
} from "../shared/conversation/app-admission-contract";
import {
  AppAdmissionRequestError, AppAdmissionStorageError, AppAdmissionStore,
  type AppAdmissionConversationBinding, type AppAdmissionInvocation, type AppAdmissionPending,
} from "./app-admission-store";
import { decodeContextMessageSubmission, type ContextMessageSubmission } from "./context-message-evidence";
import type { OwnedSubmissionPublication } from "./context-message-transport";
import { synchronousDispatchHook } from "./dispatch-evidence";
import { WorkstreamAdapterError } from "./workstreams";

declare const originalBrand: unique symbol;
/** One original live invocation, never manufactured from a receipt or request ID. */
export type OriginalAppAdmission = Readonly<{ [originalBrand]: true }>;
export type AppAdmissionPublicationProof = Readonly<{
  target: AppAdmissionTarget;
  /** Original journal/metadata association and storage only. No cancellation,
   * current owner eligibility, fresh context selection, or native observation. */
  assertCurrent: () => void;
}>;
export type AppAdmissionServicePorts = Readonly<{
  /** The bridge's EXISTING serialized write queue, including its failure latch. */
  enqueue: (work: () => Promise<void>) => Promise<void>;
  assertStorage: () => void;
  assertCanBegin: (envelope: AppAdmissionEnvelope, pending: readonly AppAdmissionPending[], binding: AppAdmissionConversationBinding) => void;
  failClosed: (error: AppAdmissionStorageError) => void;
}>;
export type AppAdmissionServiceBegin = Readonly<{ kind: "existing"; receipt: AppAdmissionReceipt }>
  | Readonly<{ kind: "created"; receipt: AppAdmissionReceipt; original: OriginalAppAdmission; intent: AppAdmissionEnvelope; binding: AppAdmissionConversationBinding }>;

/** Expected revocation of the ORIGINAL HTTP principal before durable intake.
 * This is not a storage failure and is never thrown through store mutation. */
export class AppAdmissionAuthorizationError extends Error {
  readonly status = 401;
  readonly code = "authentication-required";
}
export type AppAdmissionIntakeAuthorization = () => void;

/** Translate only expected bridge eligibility refusals at intake, before the
 * store writes intent. Storage, source and invariant failures remain fatal. */
export function assertAppAdmissionEligibility(check: () => void): void {
  try { synchronousDispatchHook(check); }
  catch (error) {
    if (error instanceof WorkstreamAdapterError) {
      if (error.status === 409 && error.code === "session-retired") throw new AppAdmissionRequestError("target-conflict", error.message);
      if (error.status === 409 && error.code === "session-retirement-pending"
        || error.status === 503 && error.code === "startup-classifying") throw new AppAdmissionRequestError("pending-admission", error.message);
    }
    throw error;
  }
}

type Result<T> = { kind: "value"; value: T } | { kind: "refused"; error: AppAdmissionRequestError };

/** The assertion is valid only in the synchronous prefix of a callback actually
 * entered by enqueue. In particular, no flag remains set across an await. */
function serializedMutations(enqueue: AppAdmissionServicePorts["enqueue"]) {
  let entered = false;
  return {
    assertCurrent() {
      if (!entered) throw new Error("App admission mutation is outside its synchronous serialized scope");
    },
    async run<T>(action: () => T): Promise<T> {
      let result: Result<T> | undefined;
      await enqueue(async () => {
        if (entered) throw new Error("App admission serialized scope reentered");
        entered = true;
        try {
          try {
            synchronousDispatchHook(() => {
              const value = action();
              result = { kind: "value", value };
              return value;
            });
          } catch (error) {
            // Expected intake refusals must not poison the existing queue. All
            // storage/invariant errors still reach its original failure latch.
            if (!(error instanceof AppAdmissionRequestError)) throw error;
            result = { kind: "refused", error };
          }
        } finally { entered = false; }
      });
      if (!result) throw new Error("App admission serialized operation did not finish");
      if (result.kind === "refused") throw result.error;
      return result.value;
    },
  };
}

/** Explicit operational setup only. Normal service construction never calls it.
 * The caller still owns feature enablement and installation/data locks. */
export async function initializeAppAdmissionService(dataDir: string, storeId: string,
  ports: Pick<AppAdmissionServicePorts, "enqueue" | "assertStorage" | "failClosed">): Promise<void> {
  const serialized = serializedMutations(ports.enqueue);
  await serialized.run(() => AppAdmissionStore.initialize(dataDir, storeId, {
    assertStorage: ports.assertStorage, assertSerializedMutation: serialized.assertCurrent, failClosed: ports.failClosed,
    assertCanBegin: () => { throw new Error("Intake is unavailable during explicit App admission setup"); },
    validateAdmission: () => { throw new Error("Publication is unavailable during explicit App admission setup"); },
  }));
}

type Original = {
  envelope: AppAdmissionEnvelope;
  invocation: AppAdmissionInvocation;
  binding: AppAdmissionConversationBinding;
  phase: "fresh" | "bound" | "publishing" | "admitted" | "rejecting" | "rejected" | "unresolved";
};

/** Receipt orchestration only: no scheduler, RunOwner registry, native adapter,
 * retry path or new writer. Live execution is supervised by the bridge. */
export class AppAdmissionService {
  readonly #store: AppAdmissionStore;
  readonly #serialized: ReturnType<typeof serializedMutations>;
  readonly #originals = new WeakMap<OriginalAppAdmission, Original>();
  #beginPending: readonly AppAdmissionPending[] | undefined;
  #publication: { envelope: AppAdmissionEnvelope; binding: AppAdmissionConversationBinding; proof: AppAdmissionPublicationProof } | undefined;

  constructor(dataDir: string, readonly storeId: string, private readonly ports: AppAdmissionServicePorts) {
    this.#serialized = serializedMutations(ports.enqueue);
    this.#store = new AppAdmissionStore(dataDir, storeId, {
      assertStorage: ports.assertStorage, assertSerializedMutation: this.#serialized.assertCurrent, failClosed: ports.failClosed,
      assertCanBegin: (envelope, pending, binding) => {
        // Readiness may inspect this exact in-memory pending snapshot.
        // It must not recursively reenter the store while begin holds
        // its mutation guard. The view exists only for this synchronous call.
        this.#beginPending = pending;
        try { synchronousDispatchHook(() => ports.assertCanBegin(envelope, pending, binding)); }
        finally { this.#beginPending = undefined; }
      },
      validateAdmission: (envelope, target, binding) => {
        this.#serialized.assertCurrent();
        const publication = this.#publication;
        if (!publication || !isDeepStrictEqual(publication.envelope, envelope) || !isDeepStrictEqual(publication.binding, binding)
          || canonicalAppAdmissionJSON(publication.proof.target) !== canonicalAppAdmissionJSON(target)) throw new Error("App admission lacks its original publication proof");
        synchronousDispatchHook(publication.proof.assertCurrent);
      },
    });
  }

  #original(handle: OriginalAppAdmission): Original {
    const original = this.#originals.get(handle);
    if (!original) throw new AppAdmissionRequestError("no-permit", "No original live App admission invocation");
    return original;
  }

  async begin(envelope: AppAdmissionEnvelope, assertRequestAuthorized: AppAdmissionIntakeAuthorization): Promise<AppAdmissionServiceBegin> {
    const result = await this.#serialized.run<AppAdmissionServiceBegin | { kind: "authorization-refused"; error: AppAdmissionAuthorizationError }>(() => {
      // The queue wait is over. Check the captured request principal HERE,
      // before entering the strict store's mutation/failure classification.
      try { synchronousDispatchHook(assertRequestAuthorized); }
      catch (error) {
        if (!(error instanceof AppAdmissionAuthorizationError)) throw error;
        return { kind: "authorization-refused", error };
      }
      const begun = this.#store.begin(envelope);
      if (begun.kind === "existing") return { kind: "existing", receipt: begun.receipt };
      const consumed = this.#store.consume(begun.permit);
      const original = Object.freeze({}) as OriginalAppAdmission;
      this.#originals.set(original, { envelope: consumed.intent, invocation: consumed.invocation, binding: consumed.binding, phase: "fresh" });
      return { kind: "created", receipt: begun.receipt, original, intent: consumed.intent, binding: consumed.binding };
    });
    // Throw only after the existing queue has successfully completed its tagged
    // refusal. Never suppress a store, publication, or invariant exception.
    if (result.kind === "authorization-refused") throw result.error;
    return result;
  }

  lookup(key: AppAdmissionKey) { return this.#store.lookup(key); }

  /** Read-only policy view, not permission to execute. During assertCanBegin the
   * store already supplied the same immutable pending snapshot. */
  readPending(): readonly AppAdmissionPending[] { return this.#beginPending ?? this.#store.readPending(); }

  key(handle: OriginalAppAdmission): AppAdmissionKey {
    const envelope = this.#original(handle).envelope;
    return decodeAppAdmissionKey({ storeId: envelope.storeId, clientRequestId: envelope.clientRequestId, payloadSha256: envelope.payloadSha256 });
  }

  binding(handle: OriginalAppAdmission): AppAdmissionConversationBinding { return this.#original(handle).binding; }

  /** Called once when the bridge links the original dispatch, or just before
   * handing a per-message capability to CC live input. Never a context/lease. */
  publication(handle: OriginalAppAdmission,
    capture: (envelope: AppAdmissionEnvelope, bound: ContextMessageSubmission) => AppAdmissionPublicationProof): OwnedSubmissionPublication {
    const original = this.#original(handle);
    if (original.phase !== "fresh") throw new Error("Original App admission publication cannot be rebound");
    original.phase = "bound";
    let bound: ContextMessageSubmission | undefined;
    let proof: AppAdmissionPublicationProof | undefined;
    return Object.freeze({
      publish: async submission => {
        if (original.phase !== "bound") throw new Error("Original App admission publication cannot be replayed");
        original.phase = "publishing";
        try {
          bound = decodeContextMessageSubmission(submission);
          await this.#serialized.run(() => {
            if (this.#publication) throw new Error("App admission publication scope reentered");
            const candidate = capture(original.envelope, bound!);
            const target = decodeAppAdmissionTarget(candidate.target), assertion = candidate.assertCurrent;
            if (typeof assertion !== "function") throw new Error("App admission publication assertion is unavailable");
            // Retain only normalized immutable data and the ORIGINAL callback,
            // never reread a caller-owned proof object's properties later.
            proof = Object.freeze({ target, assertCurrent: assertion });
            // The store invokes this proof once at its admission-publication
            // boundary. Do not repeat it around trusted synchronous callbacks.
            this.#publication = { envelope: original.envelope, binding: original.binding, proof };
            try { this.#store.admit(original.invocation, target); }
            finally { this.#publication = undefined; }
          });
          original.phase = "admitted";
        } catch (error) { original.phase = "unresolved"; throw error; }
      },
      assertCurrent: submission => {
        if (original.phase !== "admitted" || !bound || !proof || !isDeepStrictEqual(bound, submission)) throw new Error("Exact original App admission has not been durably published");
        synchronousDispatchHook(proof.assertCurrent);
        this.#store.assertAdmitted(this.key(handle), proof.target);
      },
    });
  }

  /** Definite refusal BEFORE dispatch linking only. An installed, publishing or
   * ambiguous request stays pending; ready(false) and browser abort prove nothing. */
  async rejectBeforeInstallation(handle: OriginalAppAdmission, rejection: AppAdmissionRejection): Promise<boolean> {
    const original = this.#original(handle);
    if (original.phase !== "fresh") return false;
    original.phase = "rejecting";
    try {
      await this.#serialized.run(() => this.#store.reject(original.invocation, rejection));
      original.phase = "rejected";
      return true;
    } catch (error) { original.phase = "unresolved"; throw error; }
  }
}
