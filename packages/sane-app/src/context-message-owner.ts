import type { DispatchEvidenceHooks, DispatchIdentity } from "../shared/conversation/dispatch-contract";
import { decodeContextMessage, type ContextMessage } from "./context-message";
import {
  decorateContextMessageEvidence, recordContextMessageSubmission,
  type ContextMessageDispatchObservation, type ContextMessageSubmission,
} from "./context-message-evidence";
import type {
  ActualContextSubmission, OwnedContextMessageRequest, OwnedContextMessages, PreparedOwnedContextMessage,
} from "./context-message-transport";
import { DispatchPreNativeRefusal, synchronousDispatchHook } from "./dispatch-evidence";
import { ClaudeHistorySnapshotChangedError } from "./claude-history-snapshot-error";

export type OwnedContextMessagesDependencies = Readonly<{
  /** The existing captured dispatch owner, not a lookup of whichever run is active. */
  readIdentity: () => DispatchIdentity;
  prepare: (request: OwnedContextMessageRequest, assertCurrent: () => void) => Promise<Readonly<{
    message: ContextMessage;
    assertCurrent: () => Promise<void>;
  }>>;
  originalHooks: DispatchEvidenceHooks;
  /** Same synchronous owner/claim/journal authority as originalHooks. */
  persist: (submission: ContextMessageSubmission, observation: ContextMessageDispatchObservation) => void;
  /** Storage/source/original association only. Cancellation/closing must not hide outcomes. */
  assertObservationCurrent: () => void;
  /** Synchronous retained selection/source gate, distinct from observation
   * association and from initial queued-claim hooks. Required for CC live input. */
  assertBeforeNative: () => void;
  /** Stage independently validated pairing facts; the bridge reserves their
   * association immediately AFTER the actual standard submission is reserved. */
  onBound?: (submission: ContextMessageSubmission, message: ContextMessage, request: OwnedContextMessageRequest) => void;
  failClosed: (error: unknown) => void;
}>;

function readSynchronous<T>(read: () => T): T {
  let value!: T;
  synchronousDispatchHook(() => { value = read(); return value; });
  return value;
}

/** A late-bound adapter for the EXISTING dispatch lifecycle. This owns neither
 * native admission nor activation, retries, a journal, or dispatch evidence state.
 * Install hooks where the original hooks were supplied, never around an owner's
 * already-created dispatchEvidence. Live CC input uses its service's sending and
 * attempt authority and does not re-enter initial queued-claim hooks. */
export function createOwnedContextMessages(deps: OwnedContextMessagesDependencies): Readonly<{
  transport: OwnedContextMessages;
  hooks: DispatchEvidenceHooks;
}> {
  const originalHooks = { ...deps.originalHooks };
  let initialPrepared = false;
  let initialHooks: DispatchEvidenceHooks | undefined;

  const fail = (error: unknown): never => {
    // Only the decorator's ORIGINAL intent hook may certify a refusal. In
    // particular, readers/onBound/failure callbacks must not borrow its class.
    const failure = error instanceof DispatchPreNativeRefusal
      ? new Error("Uncertified context message owner refusal", { cause: error }) : error;
    try { synchronousDispatchHook(() => deps.failClosed(failure)); }
    finally { throw failure; }
  };

  const hooks: DispatchEvidenceHooks = {
    beforeNative: fact => {
      if (!initialHooks) fail(new Error("Initial context message is not bound before native execution"));
      // Do not catch here: the decorator preserves original intent certification.
      return initialHooks!.beforeNative?.(fact);
    },
    outcome: fact => {
      if (initialHooks) return initialHooks.outcome?.(fact);
      // Preparation/readiness failures have no composition or native payload.
      // Still let the original lifecycle observe explicit local withholding.
      try { synchronousDispatchHook(() => originalHooks.outcome?.(fact)); }
      catch (error) { fail(error); }
    },
  };

  const transport: OwnedContextMessages = {
    prepare: async (input, assertCurrent) => {
      const request = Object.freeze({ ...input });
      const live = request.liveInput === true;
      if (!live) {
        if (initialPrepared) fail(new Error("Initial context message preparation cannot be replaced"));
        // Reserve before await, including concurrent prepare calls.
        initialPrepared = true;
      }
      // Domain/policy/staleness errors are handled by the existing lifecycle's
      // local-withholding path, not a fabricated physical evidence failure.
      const prepared = await deps.prepare(request, assertCurrent);
      let message: ContextMessage;
      try {
        message = decodeContextMessage(prepared.message);
        if (message.body.text !== request.body) throw new Error("Prepared context message differs from requested authored body");
        if (live && (request.boundary !== "message" || message.binding.harnessId !== "claude-code")) {
          throw new Error("Message-boundary callbacks require CC live input");
        }
      } catch (error) { return fail(error); }

      let binding: "unbound" | "binding" | "bound" | "failed" = "unbound";
      let messageHooks: DispatchEvidenceHooks | undefined;
      const readLiveIdentity = (): DispatchIdentity => {
        try { return readSynchronous(deps.readIdentity); }
        catch (error) { return fail(error); }
      };

      const result: PreparedOwnedContextMessage = {
        message,
        // Preserve the bridge engine's asynchronous guards across its awaits.
        assertCurrent: () => prepared.assertCurrent(),
        bindActual: readActual => {
          let nativeSnapshotRefusal: ClaudeHistorySnapshotChangedError | undefined;
          try {
            if (binding !== "unbound") throw new Error("Context message actual submission can only be bound once");
            binding = "binding";
            const read = (): ActualContextSubmission => {
              synchronousDispatchHook(() => deps.assertObservationCurrent());
              const actual = readSynchronous(readActual);
              const owner = readSynchronous(deps.readIdentity);
              if (actual.messageId !== request.messageId) throw new Error("Actual context message differs from requested message identity");
              const bytes = { messageId: actual.messageId, text: actual.text,
                ...(request.liveInput !== undefined ? { liveInput: request.liveInput } : {}),
                ...(request.queuedFollowupId !== undefined ? { queuedFollowupId: request.queuedFollowupId } : {}) };
              const owned = recordContextMessageSubmission(message, bytes, owner);
              const observed = recordContextMessageSubmission(message, bytes, actual.identity);
              // Both codecs validate the exact identity shape and normalize its
              // key order; compare ALL fields, including request/native command.
              if (JSON.stringify(owned.composition.dispatch) !== JSON.stringify(observed.composition.dispatch)) {
                throw new Error("Actual context message differs from captured dispatch owner");
              }
              // Never retain the adapter reader's mutable identity object. The
              // decorator calls this ORIGINAL reader again at every boundary.
              return Object.freeze({ identity: observed.composition.dispatch, messageId: observed.messageId, text: observed.text });
            };
            const actual = read();
            const submission = recordContextMessageSubmission(message, {
              messageId: actual.messageId, text: actual.text,
              ...(request.liveInput !== undefined ? { liveInput: request.liveInput } : {}),
              ...(request.queuedFollowupId !== undefined ? { queuedFollowupId: request.queuedFollowupId } : {}),
            }, actual.identity);
            const decorated = decorateContextMessageEvidence({ submission, boundary: request.boundary,
              hooks: live ? {} : originalHooks, readActualSubmission: read, persist: deps.persist, failClosed: deps.failClosed });
            try { synchronousDispatchHook(() => deps.onBound?.(submission, message, request)); }
            catch (error) {
              // This retained native eligibility check precedes hook publication
              // and all persistence. A live child may legitimately append here.
              // Only this callback's specific native-proof drift is local: the
              // same error from actual/identity readers must still fail closed.
              if (error instanceof ClaudeHistorySnapshotChangedError) nativeSnapshotRefusal = error;
              throw error;
            }
            // A callback may catch a reentrant binding error. It still cannot
            // revive that partial association or publish healthy initial hooks.
            if (binding !== "binding") throw new Error("Context message binding was invalidated by reentry");
            binding = "bound";
            messageHooks = decorated;
            if (!live) initialHooks = decorated;
            return submission;
          } catch (error) {
            binding = "failed";
            // Irrevocably consume this binding, without installing message or
            // initial hooks. The existing caller can withhold before any attempt;
            // this is NOT DispatchPreNativeRefusal or permission to retry it.
            if (nativeSnapshotRefusal !== undefined && error === nativeSnapshotRefusal) throw error;
            return fail(error);
          }
        },
        beforeMessageNative: () => {
          if (!live || !messageHooks) fail(new Error("CC live context message is not bound before native execution"));
          synchronousDispatchHook(() => deps.assertBeforeNative());
          // No second createDispatchEvidence: the live service owns attempt flags.
          messageHooks!.beforeNative?.({ ...readLiveIdentity(), submission: "attempted", nativeAcceptance: "unknown" });
        },
        messageOutcome: (submission, acceptance = "unknown") => {
          if (!live) fail(new Error("Message outcomes require CC live input"));
          if (!messageHooks) {
            // Withholding before encoding/binding has no context metadata. Never
            // fabricate an intent to make a local rejection look attempted.
            if (submission === "not-submitted" && acceptance === "not-accepted") return;
            fail(new Error("Unbound CC live context message cannot report native execution"));
          }
          messageHooks!.outcome?.({ ...readLiveIdentity(), submission, nativeAcceptance: acceptance });
        },
      };
      return Object.freeze(result);
    },
  };
  return Object.freeze({ transport: Object.freeze(transport), hooks: Object.freeze(hooks) });
}
